/**
 * Shared type definitions for the VoIP module.
 *
 */

/** Audio stream configuration reported by the WASM. */
export type AudioConfig = {
	sampleRate: number
	channels: number
	bitsPerSample: number
	framesPerChunk: number
}

/** Options for placing a call. */
export type CallOptions = {
	/** Phone number, digits only (e.g. `"12345678901"`). */
	to: string
	/** Audio source: file path to MP3/WAV, or `"silence"` for an empty uplink. */
	audioSource?: string
	/** Auto-hangup after N ms (default: 120000). */
	durationMs?: number
}

/** Video output format delivered to the consumer via the `video-frame` event. */
export type VideoFrameFormat = 'h264-raw' | 'yuv420' | 'rgba'

/** A single decoded (or raw) video frame from the remote peer. */
export type VideoFrame = {
	format: VideoFrameFormat
	data: Buffer
	/** Microseconds since stream start. */
	timestamp: number
	/** Only meaningful for `'h264-raw'` — true when the buffer starts with an IDR/SPS NALU. */
	isKeyframe?: boolean
	/** Only meaningful for `'yuv420'` and `'rgba'`. */
	width?: number
	height?: number
}

/**
 * Video stream configuration. Controls whether the consumer receives raw
 * H.264 NAL units (zero-decode cost on our side, consumer handles it) or
 * already-decoded pixel frames.
 *
 * - `'h264-raw'`: zero footprint; engine just forwards NALUs from RTP.
 * - `'yuv420'`:   engine decodes via the configured backend. YUV420P planes
 *                 in the same buffer (Y then U then V); use `width`/`height`
 *                 from the frame to demux.
 * - `'rgba'`:     decoded + colorspace-converted. Larger buffers but ready
 *                 for direct render / OCR / ML inference.
 *
 * `decoder: 'auto'` (default) tries `libavjs-webcodecs-polyfill` first, then
 * `fluent-ffmpeg` + `ffmpeg-static`. Both are OPTIONAL peer dependencies —
 * install whichever you prefer.
 */
export type VideoConfig = {
	output: VideoFrameFormat
	decoder?: 'libavjs' | 'ffmpeg' | 'auto'
	/** Throttle frames delivered to the consumer (0 = no cap). */
	maxFps?: number
}

/** Events emitted by an `ActiveCall`. */
export type CallEvents = {
	ringing: () => void
	connected: () => void
	/** 16 kHz mono Float32 PCM frame from the remote peer. */
	audio: (pcm: Float32Array) => void
	/** Video frame from the remote peer. Only fires when `VideoConfig` was set on the call. */
	'video-frame': (frame: VideoFrame) => void
	/** Reason: `"hangup"` | `"timeout"` | `"rejected"` | `"remote_end"` | `"disconnect"` | etc. */
	ended: (reason: string) => void
	error: (err: Error) => void
}

/** Events emitted by a `VoipClient` listening for incoming calls. */
export type VoipClientEvents = {
	/** Fired when an inbound call offer arrives. Call `incoming.accept()` or `incoming.reject(reason)`. */
	incoming: (incoming: IncomingCallHandle) => void
}

/**
 * Handle for an incoming call notification. Exposes accept/reject; once
 * accepted, the underlying `ActiveCall` is wired up and the same events
 * apply.
 */
export interface IncomingCallHandle {
	/** Stable identifier mirroring the offer's `call-id`. */
	readonly callId: string
	/** Caller JID (already LID→PN normalized when possible). */
	readonly from: string
	/** Caller's bare phone number (Brazilian 9th-digit fix applied). */
	readonly fromPn?: string
	/** True for video calls. */
	readonly isVideo: boolean
	/** True for group / call-link offers. */
	readonly isGroup: boolean
	/** ISO timestamp of the offer arrival. */
	readonly arrivedAt: Date
	/** Accept the call. Resolves once the active call is set up. */
	accept(opts?: AcceptOptions): Promise<ActiveCallHandle>
	/** Reject the call. `reason` defaults to `'busy'`. */
	reject(reason?: 'busy' | 'declined' | 'timeout'): Promise<void>
}

/** Options for accepting an incoming call. */
export type AcceptOptions = {
	/** Audio source for the uplink. Defaults to `'silence'`. */
	audioSource?: string
	/** Video stream configuration. Omit to skip video frame delivery. */
	video?: VideoConfig
	/** Auto-hangup after N ms. 0 = no cap. */
	durationMs?: number
}

/**
 * Surface returned by `incoming.accept()`. Identical to ActiveCall's public
 * interface — defined as a type alias to avoid the `IncomingCall` user
 * having to import `ActiveCall` separately.
 */
export interface ActiveCallHandle {
	readonly callId: string
	on<E extends keyof CallEvents>(event: E, listener: CallEvents[E]): this
	/** Hang up locally. Synchronous — wait on `waitForEnd()` for the actual
	 *  teardown to complete. (Public type was `Promise<void>` in earlier
	 *  drafts but the runtime is `void`.) */
	end(): void
	waitForEnd(): Promise<string>
}

/**
 * Top-level SDK configuration.
 *
 * Two modes:
 *   1. **Standalone**: pass `authDir`; the client creates its own Baileys
 *      socket internally (prints QR on first run).
 *   2. **Embedded**: pass `socket` (an existing Baileys-compatible socket).
 *      The client wires into its `ev` emitter for `'call'` events and uses
 *      its `offerCall` / `acceptCall` / etc. for signaling. Use this mode
 *      when integrating VoIP into an app that already has a Baileys socket
 *      open for messaging.
 *
 * Pass EITHER `authDir` OR `socket`, not both.
 */
export type VoipSdkConfig = {
	authDir?: string
	/** Existing socket to attach to (mutually exclusive with `authDir`). */
	socket?: VoipSocketLike
}

/**
 * Slice of a Baileys socket the VoIP client needs at runtime. Defined
 * structurally so consumers don't need to import the full `WASocket` type —
 * but in practice this is exactly what `makeWASocket()` returns; passing
 * anything narrower will explode the first time the SignalingBridge or the
 * incoming-call listener reaches for a missing member.
 *
 * The fields are split into three groups:
 *  1. Auth + event bus — `authState`, `ev`, `ws`.
 *  2. Signaling primitives — `query`, `sendNode`, `waitForMessage`,
 *     `generateMessageTag`, `signalRepository`, `getUSyncDevices`,
 *     `presenceSubscribe`, `getPrivacyTokens`, `end`.
 *  3. Call helpers from PR #245 — `offerCall`/`acceptCall`/...
 */
export interface VoipSocketLike {
	readonly authState: { creds: { me?: { id?: string; lid?: string }; account?: unknown } }
	readonly ev: {
		on(event: 'call', listener: (calls: VoipIncomingCallEvent[]) => void): unknown
		on(event: 'connection.update', listener: (update: { connection?: string }) => void): unknown
		on(event: string, listener: (...args: unknown[]) => void): unknown
		off?(event: string, listener: (...args: unknown[]) => void): unknown
	}
	readonly ws?: { on(event: string, listener: (node: unknown) => void): unknown }
	readonly signalRepository: {
		decryptMessage(args: { jid: string; type: string; ciphertext: Uint8Array }): Promise<Uint8Array>
		encryptMessage(args: { jid: string; data: Uint8Array }): Promise<{ type: string; ciphertext: Uint8Array }>
		jidToSignalProtocolAddress(jid: string): string
		validateSession(jid: string): Promise<{ exists: boolean }>
		lidMapping?: { getLIDForPN(jid: string): Promise<string | undefined> }
	}
	generateMessageTag(): string
	query(node: unknown): Promise<unknown>
	sendNode(node: unknown): Promise<void>
	waitForMessage(tag: string, timeoutMs: number): Promise<unknown>
	getUSyncDevices(jids: string[], ignoreZeroDevices: boolean, forceQuery: boolean): Promise<Array<{ jid: string }>>
	presenceSubscribe(jid: string): Promise<void>
	getPrivacyTokens?(jids: string[]): Promise<unknown>
	end?(error?: Error): void
	offerCall(jid: string, isVideo?: boolean): Promise<{ callId: string; stanzaId: string }>
	acceptCall(callId: string, callFrom: string, isVideo?: boolean): Promise<void>
	preacceptCall(callId: string, callCreator: string, isVideo?: boolean): Promise<void>
	rejectCall(callId: string, callFrom: string): Promise<void>
	terminateCall(callId: string, callTo: string, callCreator?: string, reason?: string, duration?: number): Promise<void>
	sendHeartbeat?(callId: string, callCreator: string): Promise<void>
	sendVideoState?(
		callId: string,
		callCreator: string,
		to: string,
		enabled: boolean,
		orientation?: string
	): Promise<void>
	muteCall?(callId: string, callCreator: string, to: string, muted: boolean): Promise<void>
	joinCallLink?(token: string, media?: 'video' | 'audio'): Promise<unknown>
	queryCallLink?(token: string, media?: 'video' | 'audio'): Promise<unknown>
	createCallLink?(media?: 'video' | 'audio'): Promise<{ token: string; url: string }>
}

/**
 * Shape of one element in the `call` event array emitted by Baileys. This
 * mirrors what `src/Socket/messages-recv.ts:handleCallInner` puts on the
 * wire when it parses an incoming `<call>` stanza — kept structural so a
 * future field addition upstream doesn't break our consumers.
 */
export type VoipIncomingCallEvent = {
	chatId: string
	from: string
	id: string
	date: Date
	status: string
	isVideo?: boolean
	isGroup?: boolean
	groupJid?: string
	callerPn?: string
	linkToken?: string
	media?: string
	offline: boolean
}

/** Mirrors the WhatsApp WASM `CallState` enum. */
export const CallState = {
	Idle: 0,
	Calling: 1,
	PreacceptReceived: 2,
	ReceivedCall: 3,
	AcceptSent: 4,
	AcceptReceived: 5,
	Active: 6,
	ActiveElsewhere: 7,
	Ending: 13
} as const
export type CallState = (typeof CallState)[keyof typeof CallState]

/** Relay list update payload from WASM call event 156. */
export type RelayListUpdate = {
	relay_key: string
	relay_tokens: string[]
	auth_tokens?: string[]
	enable_edgeray_dtls_active_mode?: boolean
	relays: ReadonlyArray<{
		relay_id: number
		relay_name: string
		token_id: number
		auth_token_id?: number
		addresses: ReadonlyArray<{
			protocol: number
			ipv4?: string
			ipv6?: string
			port?: number
			port_v6?: number
		}>
	}>
}
