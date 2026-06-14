/**
 * VoIP module — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * the fork's own socket. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * `@roamhq/wrtc` + `qrcode-terminal` are declared as OPTIONAL peer
 * dependencies so the published package doesn't force ~50MB of native WebRTC
 * bindings on users who never place a call. `ffmpeg` on PATH is also
 * required for MP3/WAV source decoding.
 *
 * The `whatsapp.wasm` / `loader.js` / `worker-modules.js` blobs in
 * `assets/wasm/` originate from WhatsApp Web's own VoIP module
 * (Meta-authored binaries).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { SignalingBridge } from './signaling/index.js'
import { WasmEngine } from './wasm-engine/index.js'
import { AudioFeeder } from './audio-feeder.js'
import { type RelayListUpdatePayload, RelayRtcTransport } from './relay-transport.js'
import { CallState, type VoipSdkConfig } from './types.js'

export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from './types.js'
export { CallState } from './types.js'

// Direct imports from our own InfiniteAPI codebase — the third-party
// version lazy-loaded `@whiskeysockets/baileys` as a peer dep. Inside the fork
// we ship as part of the same package, so static imports are cleaner and
// remove the runtime `import()` ceremony.
import makeWASocket from '../Socket/index'
import { DisconnectReason } from '../Types/index'
import { useMultiFileAuthState } from '../Utils/use-multi-file-auth-state'

const SHA256_LEN = 32

const loadBaileys = async (): Promise<any> => ({
	default: makeWASocket,
	makeWASocket,
	useMultiFileAuthState,
	DisconnectReason
})

const toBareJid = (jid: string): string => {
	if (!jid) return jid
	const at = jid.indexOf('@')
	if (at < 0) return jid
	const user = jid.slice(0, at).split(':')[0]
	return `${user}@${jid.slice(at + 1)}`
}

const computeHkdf = (key: Uint8Array, salt: Uint8Array | null, info: Uint8Array, length: number): Uint8Array => {
	const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0)
	const prk = createHmac('sha256', effectiveSalt).update(key).digest()
	const blocks = Math.ceil(length / SHA256_LEN)
	const okm = Buffer.alloc(blocks * SHA256_LEN)
	let prev = Buffer.alloc(0)
	for (let i = 1; i <= blocks; i += 1) {
		prev = createHmac('sha256', prk)
			.update(prev)
			.update(info)
			.update(Buffer.from([i]))
			.digest()
		prev.copy(okm, (i - 1) * SHA256_LEN)
	}

	return new Uint8Array(okm.buffer, okm.byteOffset, length)
}

const computeHmacSha256 = (data: Uint8Array, key: Uint8Array): Uint8Array => {
	const result = createHmac('sha256', Buffer.from(key)).update(data).digest()
	return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
}

const isCallReceiptNode = (node: any): boolean => {
	if (node?.tag !== 'receipt') return false
	const child = Array.isArray(node.content) ? node.content[0] : null
	return !!(child?.attrs?.['call-id'] || child?.attrs?.call_id)
}

/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
	#state: CallState = CallState.Idle
	#endResolver!: (reason: string) => void
	readonly #endPromise: Promise<string>
	#endTimer: NodeJS.Timeout | null = null
	#ended = false

	/** @internal mirrors the source path for the audio feeder */
	_audioSource = 'silence'

	/** @internal — optional video stream configuration. When set, the engine
	 *  routes inbound video frames through `_emitVideoFrame` so the caller's
	 *  `'video-frame'` listener fires. */
	_videoConfig: import('./types.js').VideoConfig | null = null

	/** @internal — group/link callId for the call-creator field used by
	 *  `sendHeartbeat`. Populated by `_setGroupContext` when the call is a
	 *  group / call-link join. */
	_callCreator: string | null = null

	/** @internal — heartbeat timer used for group/link calls. Cleared on end. */
	#heartbeatTimer: NodeJS.Timeout | null = null
	/** @internal — bound socket reference for the heartbeat send. Set by
	 *  `_setGroupContext`. */
	#socketForHeartbeat: { sendHeartbeat?: (callId: string, callCreator: string) => Promise<void> } | null = null

	constructor(
		public readonly callId: string,
		private readonly engine: WasmEngine,
		durationMs: number
	) {
		super()
		this.#endPromise = new Promise(res => {
			this.#endResolver = res
		})
		if (durationMs > 0) {
			this.#endTimer = setTimeout(() => this.end(), durationMs)
		}
	}

	/** @internal — mark this call as a group/link call and provide the
	 *  socket reference so the heartbeat loop can fire. Heartbeats start
	 *  automatically on `connected` and stop on `ended`. */
	_setGroupContext = (
		callCreator: string,
		sock: { sendHeartbeat?: (callId: string, callCreator: string) => Promise<void> }
	): void => {
		this._callCreator = callCreator
		this.#socketForHeartbeat = sock
	}

	get state(): CallState {
		return this.#state
	}

	end = (): void => {
		if (this.#ended) return
		// Drive the engine end first; it normally emits a state change which
		// triggers _forceEnd. We then call _forceEnd ourselves so a local
		// hangup ALWAYS wakes any awaiter on waitForEnd(), even when the
		// engine never reports state back. _forceEnd is idempotent.
		try {
			this.engine.endCall(0, true)
		} catch {}

		this._forceEnd('ended')
	}

	mute = (muted: boolean): void => {
		try {
			this.engine.setMute(muted)
		} catch {}
	}

	waitForEnd = (): Promise<string> => this.#endPromise

	/** @internal — called by VoipClient on WASM call-state change */
	_updateState = (state: number): void => {
		this.#state = state as CallState
		if (state === CallState.PreacceptReceived) this.emit('ringing')
		else if (state === CallState.Active) {
			this.emit('connected')
			// F2: start the per-call heartbeat loop once we have a working session
			// for group/link calls. WhatsApp Web sends one heartbeat every ~10s
			// while a multi-party call is active; without it the server treats
			// the participant as having timed out after ~30s.
			this.#maybeStartHeartbeat()
		} else if (state === CallState.Idle || state === CallState.Ending) {
			this._forceEnd('ended')
		}
	}

	/** @internal */
	_emitAudio = (pcm: Float32Array): void => {
		this.emit('audio', pcm)
	}

	/** @internal — surface a video frame to the consumer. The engine wraps
	 *  the raw H.264 NAL units from RTP (when `format === 'h264-raw'`) or
	 *  delivers an already-decoded YUV420P / RGBA buffer when the consumer
	 *  asked for decoding. */
	_emitVideoFrame = (frame: import('./types.js').VideoFrame): void => {
		if (!this._videoConfig) return // consumer opted out of video
		this.emit('video-frame', frame)
	}

	/** @internal */
	_forceEnd = (reason: string): void => {
		if (this.#ended) return
		this.#ended = true
		if (this.#endTimer) {
			clearTimeout(this.#endTimer)
			this.#endTimer = null
		}

		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer)
			this.#heartbeatTimer = null
		}

		this.emit('ended', reason)
		this.#endResolver(reason)
	}

	/** @internal — start a 10s heartbeat loop. Idempotent (no-op if already
	 *  running, or if this isn't a group call, or if the socket doesn't
	 *  expose `sendHeartbeat`). */
	#maybeStartHeartbeat = (): void => {
		if (this.#heartbeatTimer) return
		if (!this._callCreator) return // not a group/link call
		if (!this.#socketForHeartbeat?.sendHeartbeat) return
		const sock = this.#socketForHeartbeat
		const callCreator = this._callCreator
		const callId = this.callId
		// Fire one immediately, then every 10s. WhatsApp Web's interval is
		// configured via the WASM (`heartbeat_interval_s`, default 30s in the
		// engine wrapper) — we pick 10s for safety against tight server timeouts
		// seen in practice on group calls.
		const fire = () => {
			sock.sendHeartbeat?.(callId, callCreator).catch(() => {
				// network blips. emit() on `error` in Node throws when there are no
				// listeners — guard so a flaky heartbeat doesn't crash the host.
				if (this.listenerCount('error') > 0) {
					this.emit('error', new Error(`heartbeat failed for ${callId}`))
				}
			})
		}

		fire()
		this.#heartbeatTimer = setInterval(fire, 10_000)
	}
}

/** Top-level client. Connects to WhatsApp and lets you place calls. */
export class VoipClient extends EventEmitter {
	readonly #config: VoipSdkConfig
	#engine: WasmEngine | null = null
	#relay: RelayRtcTransport | null = null
	#signaling: SignalingBridge | null = null
	#sock: any = null
	#activeCall: ActiveCall | null = null
	#baileys: any = null
	/** Tracks incoming call IDs we have already surfaced as `'incoming'` to dedupe
	 *  re-emits when the same `<call>` stanza is delivered with multiple children
	 *  (e.g. offer + transport in the same node). */
	#seenIncomingIds = new Set<string>()
	/** True when we created the underlying socket (standalone mode). Embedded
	 *  mode passes a socket in; we must NOT close it on disconnect because the
	 *  caller still needs it for messaging. */
	readonly #ownsSocket: boolean

	// Capture state populated when WASM negotiates audio params
	#capturePtr = 0
	#captureChunkBytes = 0
	#captureSampleRate = 16000
	#captureChannels = 1
	#captureFramesPerChunk = 320
	#feeder: AudioFeeder | null = null

	constructor(config: VoipSdkConfig) {
		super()
		if (!config.authDir && !config.socket) {
			throw new Error('VoipSdkConfig: must provide either `authDir` (standalone) or `socket` (embedded).')
		}

		if (config.authDir && config.socket) {
			throw new Error('VoipSdkConfig: `authDir` and `socket` are mutually exclusive — pass one only.')
		}

		this.#config = config
		this.#ownsSocket = !config.socket
	}

	/**
	 * @internal — wire common call lifecycle: clear `#activeCall` when this
	 * call ends, and free its incoming-id dedupe slot. Idempotent: safe even
	 * if the call was already torn down before the listener fires.
	 */
	#attachCallLifecycle = (call: ActiveCall, incomingId?: string): void => {
		call.once('ended', () => {
			if (this.#activeCall === call) this.#activeCall = null
			if (incomingId) this.#seenIncomingIds.delete(incomingId)
		})
	}

	/**
	 * Connect to WhatsApp and bring up the WASM VoIP stack.
	 *
	 * Two modes:
	 *  - **Embedded** (`config.socket` provided): skips auth/QR; reuses the
	 *    caller's socket. Returns once the WASM engine is up.
	 *  - **Standalone** (`config.authDir` provided): creates its own Baileys
	 *    socket, prints QR on first run, waits for connection.
	 */
	connect = async (): Promise<void> => {
		// Embedded mode: socket already provided by the caller. Skip the
		// auth/QR ceremony and go straight to wiring the WASM stack.
		if (this.#config.socket) {
			this.#sock = this.#config.socket
			await this.#initEngineWithSocket()
			this.#wireIncomingCallListener()
			return
		}

		this.#baileys = await loadBaileys()
		const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys
		const makeSocket: (opts: any) => any = makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys

		// `authDir` is required in standalone mode — the constructor guard above
		// already rejected configs that have neither `authDir` nor `socket`, so
		// by the time we get here the non-null assertion is sound.
		const authDir = resolve(this.#config.authDir!)
		const { state, saveCreds } = await useMultiFileAuthState(authDir)

		const silentLogger: any = {
			level: 'silent',
			child: () => silentLogger,
			trace: () => {},
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
			fatal: () => {}
		}

		const createSocket = () =>
			makeSocket({
				auth: state,
				emitOwnEvents: true,
				logger: silentLogger
			})

		// Connect with auto-reconnect on the post-QR 515 stream-error path.
		await new Promise<void>((resolveOpen, rejectOpen) => {
			let opened = false
			let retries = 0
			const maxRetries = 5
			// Scoped handler: we install OUR uncaughtException listener and detach
			// exactly that one on cleanup. Earlier versions called
			// process.removeAllListeners("uncaughtException") which would also
			// remove handlers installed by the host application's framework/APM —
			// hostile behaviour for a library.
			let installedHandler: ((err: any) => void) | null = null
			const detachHandler = (): void => {
				if (installedHandler) {
					process.off('uncaughtException', installedHandler)
					installedHandler = null
				}
			}

			const connectSocket = () => {
				this.#sock = createSocket()
				this.#sock.ev.on('creds.update', saveCreds)

				detachHandler()
				installedHandler = (err: any) => {
					const code = err?.output?.statusCode ?? err?.data?.attrs?.code
					if ((code === 515 || code === '515') && !opened && retries < maxRetries) {
						retries += 1
						setTimeout(connectSocket, 1500)
					} else if (!opened) {
						rejectOpen(err)
					}
				}

				process.on('uncaughtException', installedHandler)

				this.#sock.ev.on('connection.update', (update: any) => {
					if (update.qr) {
						void import('qrcode-terminal')
							.then(qrt => (qrt.default ?? qrt).generate(update.qr, { small: true }))
							.catch(() => {
								console.log('Scan this QR code in WhatsApp > Linked Devices:')
								console.log(update.qr)
							})
					}

					if (update.connection === 'open') {
						opened = true
						detachHandler()
						resolveOpen()
						return
					}

					if (update.connection === 'close' && !opened) {
						const statusCode = update.lastDisconnect?.error?.output?.statusCode
						const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason?.restartRequired
						if (shouldReconnect && retries < maxRetries) {
							retries += 1
							setTimeout(connectSocket, 1000)
						} else {
							detachHandler()
							rejectOpen(update.lastDisconnect?.error ?? new Error('socket closed before open'))
						}
					}
				})
			}

			connectSocket()
		})

		await this.#initEngineWithSocket()
		this.#wireIncomingCallListener()
	}

	/**
	 * Spin up the WASM engine + RTP transport + signaling bridge against the
	 * already-attached `this.#sock`. Extracted from the original `connect()`
	 * body so it can be reused by the embedded-mode path (which skips the
	 * QR/auth ceremony and goes straight here).
	 */
	#initEngineWithSocket = async (): Promise<void> => {
		this.#signaling = new SignalingBridge({ sock: this.#sock })
		await this.#signaling.init()

		this.#relay = new RelayRtcTransport({
			onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
			onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port)
		})

		this.#engine = new WasmEngine({
			callbacks: {
				onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling!.sendSignaling(peerJid, callId, xmlPayload),
				onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
				sendDataToRelay: (data, ip, port) => this.#relay!.send(data, ip, port),
				onAudioCaptureInit: config => this.#handleAudioCaptureInit(config),
				onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
				onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
				onAudioPlaybackData: audioData => this.#activeCall?._emitAudio(audioData),
				cryptoHkdf: computeHkdf,
				hmacSha256: computeHmacSha256
			}
		})

		await this.#engine.initialize()
		this.#signaling.attachEngine(this.#engine)

		const selfPnJid = this.#sock.authState.creds.me?.id
		const selfLidJid = this.#sock.authState.creds.me?.lid
		this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid)
		await this.#engine.waitForVoipStackReady()
		try {
			this.#engine.updateNetworkMedium(2, 0)
		} catch {}

		// Direct binary-node hooks used for incoming stanza processing. In embedded
		// mode the socket exposes `.ws` (the underlying ws.WebSocket); in standalone
		// mode it's the socket the client just built. Both expose the same handle.
		// Refs are stored so `disconnect()` can detach them — otherwise a stanza
		// arriving after teardown would run against `#engine = null`.
		if (this.#sock.ws?.on) {
			this.#cbCallHandler = (node: any) => {
				this.#signaling?.processIncomingCall(node, this.#engine!, this.#activeCall?.callId ?? '')
			}

			this.#cbReceiptHandler = (node: any) => {
				if (!isCallReceiptNode(node)) return
				this.#signaling?.processIncomingReceipt(node, this.#engine!, this.#activeCall?.callId ?? '')
			}

			this.#sock.ws.on('CB:call', this.#cbCallHandler)
			this.#sock.ws.on('CB:receipt', this.#cbReceiptHandler)
		}
	}

	#cbCallHandler: ((node: any) => void) | null = null
	#cbReceiptHandler: ((node: any) => void) | null = null

	/**
	 * Subscribe to the socket's `'call'` event. When an offer arrives that we
	 * haven't already surfaced (dedupe by call-id), construct an
	 * `IncomingCallHandle` and emit `'incoming'` so the caller can
	 * `accept()` / `reject()`.
	 *
	 * Other call statuses (`terminate`, `transport`, `relaylatency`, etc.)
	 * are forwarded into the engine via the SignalingBridge — this listener
	 * only cares about the `offer` first-touch.
	 */
	#wireIncomingCallListener = (): void => {
		if (!this.#sock?.ev?.on) return
		this.#sock.ev.on('call', (calls: Array<Record<string, unknown>>) => {
			for (const call of calls) {
				if (call?.status !== 'offer') continue
				const callId = String(call.id ?? '')
				if (!callId || this.#seenIncomingIds.has(callId)) continue
				this.#seenIncomingIds.add(callId)
				const incoming = this.#makeIncomingHandle(call)
				this.emit('incoming', incoming)
			}
		})
	}

	/**
	 * Build an `IncomingCallHandle` for an `'offer'` event from the socket.
	 * `accept()` performs the signaling stanza + sets up the active call;
	 * `reject()` just sends the rejection signaling and removes the dedupe
	 * marker so a re-offer with the same id can be surfaced again.
	 */
	#makeIncomingHandle = (call: Record<string, unknown>): import('./types.js').IncomingCallHandle => {
		const self = this
		const callId = String(call.id ?? '')
		const from = String(call.from ?? '')
		const fromPn = (call.callerPn as string | undefined) ?? undefined
		const isVideo = !!call.isVideo
		const isGroup = !!call.isGroup
		const arrivedAt = call.date instanceof Date ? call.date : new Date()

		return {
			callId,
			from,
			fromPn,
			isVideo,
			isGroup,
			arrivedAt,
			accept: async opts => {
				if (!self.#sock?.acceptCall) {
					throw new Error('Socket does not expose acceptCall — is the fork’s call signaling wired up?')
				}

				// Pre-accept first (acknowledges ringing without committing audio
				// path yet), then accept proper. Matches what WA Web does on
				// incoming-call answer.
				if (self.#sock.preacceptCall) {
					await self.#sock.preacceptCall(callId, from, isVideo)
				}

				await self.#sock.acceptCall(callId, from, isVideo)

				// Spin up an ActiveCall and hand it back. The engine was already
				// initialised in `connect()`; we just need to register the call id
				// so audio playback / video frame dispatch routes through it.
				const active = new ActiveCall(callId, self.#engine!, opts?.durationMs ?? 0)
				// mark the source so AudioFeeder can attach later if requested
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				;(active as any)._audioSource = opts?.audioSource ?? 'silence'
				// F3: opt into video frame delivery on accept.
				if (opts?.video) {
					active._videoConfig = opts.video
					// Bridge engine → call: install the frame callback so frames the
					// engine pulls off the wire reach `_emitVideoFrame`.
					self.#engine!.setOnVideoFrameCallback(frame => active._emitVideoFrame(frame))
				}

				// F2: for group/link offers, wire the heartbeat context so the
				// ActiveCall starts pinging once it reaches `Active` state.
				if (isGroup) {
					active._setGroupContext(from, self.#sock)
				}

				self.#activeCall = active
				self.#attachCallLifecycle(active, callId)
				return active as unknown as import('./types.js').ActiveCallHandle
			},
			reject: async reason => {
				if (!self.#sock?.rejectCall) {
					throw new Error('Socket does not expose rejectCall — is the fork’s call signaling wired up?')
				}

				await self.#sock.rejectCall(callId, from)
				// Allow a re-offer with the same id to surface again (the server
				// sometimes redelivers an offer when the recipient ignored the
				// first attempt).
				self.#seenIncomingIds.delete(callId)
				if (reason) {
					// Surface as an `ended` event semantically — useful for logging.
					self.emit('rejected', { callId, reason })
				}
			}
		}
	}

	/**
	 * Place an outbound voice (or video) call.
	 *
	 * Pass `opts.video` to receive the remote peer's video frames via the
	 * `'video-frame'` event on the returned `ActiveCall`. See `VideoConfig`
	 * for the available output formats. Omitting `opts.video` means the call
	 * is treated as voice-only (matching the SheIITear baseline).
	 */
	call = async (
		phoneNumber: string,
		opts: {
			audioSource?: string
			durationMs?: number
			video?: import('./types.js').VideoConfig
		} = {}
	): Promise<ActiveCall> => {
		if (!this.#engine || !this.#signaling) throw new Error('Not connected. Call connect() first.')
		if (this.#activeCall) throw new Error('A call is already active.')

		const targetNumber = phoneNumber.replace(/\D/g, '')
		const targetPnJid = `${targetNumber}@s.whatsapp.net`
		const durationMs = opts.durationMs ?? 120_000
		const audioSource = opts.audioSource ?? 'silence'

		const peerLid = await this.#signaling.resolveLid(targetPnJid)
		if (!peerLid) throw new Error(`Could not resolve LID for ${targetPnJid}`)

		for (const jid of [targetPnJid, peerLid]) {
			try {
				await this.#sock.presenceSubscribe(jid)
			} catch {}
		}

		await new Promise(r => setTimeout(r, 750))

		const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid)
		const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)]

		await this.#signaling.ensureSessionsForPeers(deviceList)

		await new Promise(r => setTimeout(r, 500))
		await this.#signaling.issueTcToken(peerLid)
		const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid)

		const callId = ('00' + randomBytes(16).toString('hex').slice(2)).toUpperCase()

		const call = new ActiveCall(callId, this.#engine, durationMs)
		call._audioSource = audioSource
		this.#activeCall = call
		this.#attachCallLifecycle(call)

		// F3: surface video config so the call's `'video-frame'` listener gets
		// engaged when the WASM delivers a frame. `isVideo` on `startCall` tells
		// the engine to negotiate the video codec (H.264/H.265/AV1) with the peer.
		if (opts.video) {
			call._videoConfig = opts.video
			// Bridge engine → call: install the frame callback so frames the
			// engine pulls off the wire reach `_emitVideoFrame`.
			this.#engine.setOnVideoFrameCallback(frame => call._emitVideoFrame(frame))
		}

		try {
			this.#engine.startCall({
				peerJid: peerLid,
				peerPn: targetPnJid,
				peerList: deviceList,
				callId,
				isVideo: !!opts.video,
				isLidCall: true,
				isFromDialer: false,
				extraData: tcToken
			})
		} catch (err) {
			// Engine refused — roll the lifecycle back so a future call() works.
			this.#activeCall = null
			throw err
		}

		return call
	}

	// ─── F2 — Group / Call-link orchestration ──────────────────────────────────
	//
	// Signaling for create / query / join + heartbeat / participant tracking is
	// already wired into the fork's socket via PR #245 (`createCallLink`,
	// `joinCallLink`, `queryCallLink`, `sendHeartbeat`, `extractParticipants`).
	// These wrappers just expose them as ergonomic `VoipClient` methods AND
	// start a per-call heartbeat loop once the call reaches the `Active` state.
	//
	// What's NOT covered here: the multi-party AUDIO ROUTING that mixes uplinks
	// from N participants downstream to each of them lives inside the WASM
	// binary itself (`whatsapp.wasm`). The bundled engine wrapper exposes
	// `startCall` for 1:1 — group-call init requires the WASM-side
	// `WAWebVoipGroupCallFromChat` / `WAWebVoipGroupCallFromWids` entrypoint
	// we identified via CDP. Surfacing those goes in a follow-up PR once the
	// WASM bindings are extended; today's wrappers below give consumers the
	// signaling path so they can at least RECEIVE / dial into a group call.

	/**
	 * Create a new call link. Returns the token + the `https://call.whatsapp.com/...`
	 * URL the recipient can use to join.
	 *
	 * Delegates to the fork's socket-level `createCallLink` (shipped in
	 * PR #245). Throws if the embedded socket doesn't expose it.
	 */
	createLink = async (media: 'voice' | 'video' = 'voice'): Promise<{ token: string; url: string }> => {
		if (!this.#sock?.createCallLink) {
			throw new Error('Socket does not expose createCallLink — is the fork’s call signaling wired up?')
		}

		return this.#sock.createCallLink(media === 'video' ? 'video' : 'audio')
	}

	/**
	 * Query an existing call link's metadata (creator, current participants,
	 * media type, etc.) without joining.
	 */
	queryLink = async (token: string, media: 'voice' | 'video' = 'voice'): Promise<unknown> => {
		if (!this.#sock?.queryCallLink) {
			throw new Error('Socket does not expose queryCallLink')
		}

		return this.#sock.queryCallLink(token, media === 'video' ? 'video' : 'audio')
	}

	/**
	 * Join an existing call link. Returns immediately after the signaling
	 * round-trip — the call lifecycle then flows through `'incoming'` /
	 * `ActiveCall` events the same way a regular call does.
	 *
	 * Future-work note: the WASM engine still needs `startGroupCall(...)`
	 * (or equivalent) to be wired for the inbound audio mixer to engage.
	 * For now this primes the signaling side and emits a `'group-joined'`
	 * event so the caller knows the join succeeded at the protocol layer.
	 */
	joinLink = async (token: string, media: 'voice' | 'video' = 'voice'): Promise<{ token: string }> => {
		if (!this.#sock?.joinCallLink) {
			throw new Error('Socket does not expose joinCallLink')
		}

		await this.#sock.joinCallLink(token, media === 'video' ? 'video' : 'audio')
		this.emit('group-joined', { token })
		return { token }
	}

	/**
	 * Send a manual heartbeat for an active group/link call. Most consumers
	 * won't need this — `ActiveCall` runs an internal heartbeat loop once
	 * the call enters the `Active` state. Exposed for advanced cases (manual
	 * keep-alive on stale sessions, debugging the protocol, etc.).
	 */
	sendHeartbeat = async (callId: string, callCreator: string): Promise<void> => {
		if (!this.#sock?.sendHeartbeat) {
			throw new Error('Socket does not expose sendHeartbeat')
		}

		await this.#sock.sendHeartbeat(callId, callCreator)
	}

	/**
	 * Place an outbound GROUP call to a list of participants.
	 *
	 * Drives `wasm-engine.startGroupCall` which mirrors WhatsApp Web's
	 * `WAWebVoipStartCall.startWAWebVoipGroupCallFromWids` — extracted via
	 * CDP for reference; not bundled. The engine picks between the
	 * dedicated `startGroupCall` WASM binding (when present) and the
	 * generic `startVoipCall` with an N-element peer list (the path
	 * WA Web itself falls back to). See the JSDoc on
	 * `WasmEngine.startGroupCall` for the routing details.
	 *
	 * Participants should be passed as LID-form JIDs (`<number>@lid`) when
	 * possible — that's what the WASM SFU bring-up expects. Bare phone
	 * numbers are resolved by the signaling layer the same way `call()` does.
	 *
	 * `opts.video` opts into video frame delivery on the returned
	 * `ActiveCall` (same shape as 1:1 `call()`).
	 */
	groupCall = async (
		participants: string[],
		opts: {
			audioSource?: string
			durationMs?: number
			video?: import('./types.js').VideoConfig
			linkToken?: string
		} = {}
	): Promise<ActiveCall> => {
		if (!this.#engine || !this.#signaling) throw new Error('Not connected. Call connect() first.')
		if (this.#activeCall) throw new Error('A call is already active.')
		if (!participants.length) throw new Error('groupCall: at least one participant is required')

		// Resolve each participant to a LID if it's a bare phone number — the
		// SFU expects LIDs and the signaling layer's `discoverPeerDevices`
		// returns per-device LIDs. We don't fan-out per device here; the WASM
		// does that internally from the per-participant LID.
		const resolved: string[] = []
		for (const p of participants) {
			// Both `@lid` and `@hosted.lid` are already resolved — only bare
			// phone numbers need the LID lookup. The earlier `endsWith('@lid')`
			// missed hosted-LID accounts (device 99) and tried to re-resolve
			// them as if they were PNs.
			if (p.endsWith('@lid') || p.endsWith('@hosted.lid')) {
				resolved.push(p)
			} else if (p.endsWith('@s.whatsapp.net')) {
				const lid = await this.#signaling.resolveLid(p)
				resolved.push(lid || p)
			} else {
				const digits = p.replace(/\D/g, '')
				const pnJid = `${digits}@s.whatsapp.net`
				const lid = await this.#signaling.resolveLid(pnJid)
				resolved.push(lid || pnJid)
			}
		}

		const callId = ('00' + randomBytes(16).toString('hex').slice(2)).toUpperCase()
		const durationMs = opts.durationMs ?? 0
		const audioSource = opts.audioSource ?? 'silence'

		const active = new ActiveCall(callId, this.#engine, durationMs)
		active._audioSource = audioSource
		if (opts.video) active._videoConfig = opts.video
		// Group calls always run the heartbeat loop. The call creator for the
		// heartbeat is OUR own JID (we're the originator).
		const selfJid = this.#sock.authState.creds.me?.lid || this.#sock.authState.creds.me?.id
		if (selfJid) active._setGroupContext(selfJid, this.#sock)
		this.#activeCall = active
		this.#attachCallLifecycle(active)

		// Hook the video frame stream into the active call (if opted-in).
		if (opts.video) {
			this.#engine.setOnVideoFrameCallback(frame => active._emitVideoFrame(frame))
		}

		try {
			this.#engine.startGroupCall({
				callId,
				participants: resolved,
				isVideo: !!opts.video,
				callCreator: selfJid,
				linkToken: opts.linkToken
			})
		} catch (err) {
			this.#activeCall = null
			throw err
		}

		return active
	}

	/** Tear down the WhatsApp socket and release resources. */
	disconnect = (): void => {
		this.#activeCall?._forceEnd('disconnect')
		this.#activeCall = null
		// Detach the direct ws CB hooks BEFORE we null out the engine —
		// otherwise a stanza in flight when destroy() lands could invoke
		// the handler against a torn-down engine and throw into the host
		// process. We captured the refs at attach time so `removeListener`
		// targets the exact closure (a fresh arrow would not match).
		const ws: any = this.#sock?.ws
		const off = ws?.off ?? ws?.removeListener
		if (off) {
			if (this.#cbCallHandler) off.call(ws, 'CB:call', this.#cbCallHandler)
			if (this.#cbReceiptHandler) off.call(ws, 'CB:receipt', this.#cbReceiptHandler)
		}

		this.#cbCallHandler = null
		this.#cbReceiptHandler = null
		this.#relay?.closeAll()
		this.#engine?.destroy()
		// Only close the socket if we created it. In embedded mode the caller
		// still needs it for messaging after the VoIP teardown.
		if (this.#ownsSocket) this.#sock?.end?.()
		this.#engine = null
		this.#relay = null
		this.#signaling = null
		this.#sock = null
	}

	// ─── private ──────────────────────────────────────────────────────────────

	#handleCallEvent = (eventType: number, eventData?: string): void => {
		if (eventType === 16 && eventData) {
			try {
				const parsed = JSON.parse(eventData)
				const info = parsed.call_info ?? parsed.callInfo ?? {}
				const callState = Number(info.call_state ?? info.callState ?? 0)
				this.#activeCall?._updateState(callState)
			} catch {}
		} else if (eventType === 156 && eventData) {
			try {
				const update = JSON.parse(eventData) as RelayListUpdatePayload
				this.#relay?.updateRelayList(update)
			} catch {}
		} else if (eventType === 2) {
			this.#activeCall?._forceEnd('remote_end')
		}
	}

	#handleAudioCaptureInit = (config: {
		sampleRate: number
		channels: number
		bitsPerSample: number
		framesPerChunk: number
	}): void => {
		if (!this.#engine) return
		this.#captureSampleRate = config.sampleRate || 16000
		this.#captureChannels = config.channels || 1
		this.#captureFramesPerChunk = config.framesPerChunk || 320
		const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels
		this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT
		this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes)
	}

	#handleAudioCaptureStart = (): void => {
		if (!this.#engine || !this.#capturePtr) return
		const audioSource = this.#activeCall?._audioSource ?? 'silence'
		this.#feeder = new AudioFeeder(
			this.#captureSampleRate,
			this.#captureChannels,
			this.#captureFramesPerChunk,
			chunk => {
				if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr)
			},
			audioSource
		)
		this.#feeder.start()
	}

	#handleAudioCaptureStop = (): void => {
		this.#feeder?.stop()
		this.#feeder = null
		if (this.#engine && this.#capturePtr) {
			try {
				this.#engine.free(this.#capturePtr)
			} catch {}

			this.#capturePtr = 0
		}
	}
}
