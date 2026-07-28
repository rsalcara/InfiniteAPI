/* eslint-disable @typescript-eslint/no-floating-promises */
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { URL } from 'url'
import { promisify } from 'util'
import { proto } from '../../WAProto/index.js'
import {
	DEF_CALLBACK_PREFIX,
	DEF_TAG_PREFIX,
	DEFAULT_SESSION_CLEANUP_CONFIG,
	INITIAL_PREKEY_COUNT,
	MIN_PREKEY_COUNT,
	MIN_UPLOAD_INTERVAL,
	NOISE_WA_HEADER
} from '../Defaults'
import { makeSessionActivityTracker } from '../Signal/session-activity-tracker'
import { makeSessionCleanup } from '../Signal/session-cleanup'
import type { ConnectionState, LIDMapping, NewChatMessageCapInfo, ReachoutTimelockState, SocketConfig } from '../Types'
import { DisconnectReason, QueryIds, ReachoutTimelockEnforcementType, XWAPaths } from '../Types'
import {
	addTransactionCapability,
	aesEncryptCTR,
	appendNativeAndroidPairingAttestation,
	bindWaitForConnectionUpdate,
	buildPairingQRData,
	bytesToCrockford,
	configureSuccessfulPairing,
	createNativeAndroidClientPayloadContext,
	createNativeAndroidFallbackDeviceProfile,
	Curve,
	derivePairingCodeKey,
	generateLoginNode,
	generateMdTagPrefix,
	generateRegistrationNode,
	getCodeFromWSError,
	getErrorCodeFromStreamError,
	getNextPreKeysNode,
	incrementNativeAndroidConnectionLc,
	makeEventBuffer,
	makeNoiseHandler,
	promiseTimeout,
	resolveNativeAndroidClientPayloadPhase,
	resolveNativeAndroidPairingAppVariant,
	resolveTransportSession,
	shouldFallbackNativeAndroidProfile,
	signedKeyPair,
	xmppSignedPreKey
} from '../Utils'
import { getPlatformId, isAndroidBrowser } from '../Utils/browser-utils'
import { applyReconciledPrekeyCursors } from '../Utils/prekey-upload-cursors'
import { resolvePrekeyUploadQueryTimeout } from '../Utils/prekey-upload-timeout'
import {
	markConnectionActive,
	markConnectionInactive,
	recordConnectionAttempt,
	recordConnectionError,
	recordConnectionRestart
} from '../Utils/prometheus-metrics'
import { createExpectedSocketTeardownError, isExpectedSocketTeardownError } from '../Utils/socket-teardown'
import {
	createUnifiedSessionManager,
	extractServerTime,
	shouldEnableUnifiedSession,
	type UnifiedSessionManager
} from '../Utils/unified-session'
import {
	assertNodeErrorFree,
	type BinaryNode,
	binaryNodeToString,
	encodeBinaryNode,
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isLidUser,
	jidDecode,
	jidEncode,
	S_WHATSAPP_NET
} from '../WABinary'
import { BinaryInfo } from '../WAM/BinaryInfo.js'
import { USyncQuery, USyncUser } from '../WAUSync/'
import { getAuthStoreDrainBarrier, registerAuthStoreDrainBarrier } from './auth-store-drain-barrier'
import { TcpSocketClient, WebSocketClient } from './Client'
import { executeWMexQuery } from './mex'
import { createOfflineBufferState } from './offline-buffer-state'
import { createPushNameAnnouncementTracker, getPushNameForAnnouncement } from './push-name-announcement'
import { makeReachoutTimelockRemediation, type RemoveReachoutTimelockServerResult } from './reachout-remediation'

/**
 * Connects to WA servers and performs:
 * - simple queries (no retry mechanism, wait for connection establishment)
 * - listen to messages and emit events
 * - query phone connection
 */

export const makeSocket = (config: SocketConfig) => {
	const {
		waWebSocketUrl,
		connectTimeoutMs,
		logger,
		keepAliveIntervalMs,
		browser,
		auth: authState,
		printQRInTerminal,
		defaultQueryTimeoutMs,
		transactionOpts,
		qrTimeout,
		makeSignalRepository,
		experimentalReachoutTimelockRemediation,
		// If enableUnifiedSession is explicitly set (true/false), use it
		// Otherwise (undefined), check env var, then default to true
		enableUnifiedSession: enableUnifiedSessionConfig
	} = config
	const transportSession = resolveTransportSession(config, authState.creds)
	const isNativeAndroid = transportSession.profile === 'native_android'
	let closed = false
	// ClientPayload must use the resolved, persisted native identity rather than
	// the caller's current environment values. This keeps reconnects immutable.
	const payloadConfig: SocketConfig = isNativeAndroid
		? { ...config, nativeAndroid: transportSession.nativeAndroid }
		: config

	// Resolve enableUnifiedSession: explicit config > env var > default (true)
	const enableUnifiedSession =
		enableUnifiedSessionConfig !== undefined ? enableUnifiedSessionConfig : shouldEnableUnifiedSession()

	// Unified Session Manager will be initialized after sendNode is defined
	let unifiedSessionManager: UnifiedSessionManager | undefined

	const publicWAMBuffer = new BinaryInfo()

	const uqTagId = generateMdTagPrefix()
	const generateMessageTag = () => `${uqTagId}${epoch++}`

	if (printQRInTerminal) {
		console.warn(
			'⚠️ The printQRInTerminal option has been deprecated. You will no longer receive QR codes in the terminal automatically. Please listen to the connection.update event yourself and handle the QR your way. You can remove this message by removing this opttion. This message will be removed in a future version.'
		)
	}

	const url = isNativeAndroid
		? new URL(
				`tcp://${transportSession.nativeAndroid!.host || 'g.whatsapp.net'}:${transportSession.nativeAndroid!.port || 443}`
			)
		: typeof waWebSocketUrl === 'string'
			? new URL(waWebSocketUrl)
			: waWebSocketUrl

	const nativeClientPayloadContext = isNativeAndroid
		? createNativeAndroidClientPayloadContext({
				phase: resolveNativeAndroidClientPayloadPhase({
					hasRegisteredIdentity: Boolean(authState.creds.me),
					accountSyncCounter: authState.creds.accountSyncCounter
				}),
				connectionLc: authState.creds.nativeAndroidIdentity?.connectionLc,
				port: url.port ? Number.parseInt(url.port, 10) : 443
			})
		: undefined

	if (config.mobile) {
		throw new Boom('Mobile API is not supported anymore', { statusCode: DisconnectReason.loggedOut })
	}

	if ((isNativeAndroid && url.protocol !== 'tcp:') || (!isNativeAndroid && url.protocol === 'tcp:')) {
		throw new Boom('transport profile and socket URL protocol do not match', {
			statusCode: DisconnectReason.badSession
		})
	}

	// If clearRoutingInfoOnStart is enabled, discard the stored routing hint so WhatsApp
	// assigns a fresh edge server on this connection. This fixes sessions that became slow
	// after a pm2 restart because the previous edge server retained stale state.
	// Signal keys and auth credentials are NOT affected — no QR re-scan is needed.
	// hadStaleRoutingInfo is used below to skip the offline buffer on reconnect scenarios
	// (restart of an already-authenticated session) so live messages are not held hostage by the backlog buffer.
	let hadStaleRoutingInfo = false
	if (!isNativeAndroid && config.clearRoutingInfoOnStart && authState?.creds?.routingInfo) {
		logger.info('clearRoutingInfoOnStart: discarding stored routingInfo to force fresh edge server assignment')
		authState.creds.routingInfo = undefined
		hadStaleRoutingInfo = true
	}

	// Skip the offline-phase buffer for ANY restart of an existing session.
	// accountSyncCounter > 0 means at least one full sync has completed before — this is a
	// reconnect, not a first-time QR scan. This is a superset of hadStaleRoutingInfo:
	// it covers channels where WhatsApp never sends routingInfo, where routingInfo was already
	// cleared on a previous restart, or any other reconnect scenario.
	// ev.buffer() is called twice on connect (here and in chats.ts). chats.ts already flushes
	// immediately on reconnect (accountSyncCounter > 0), but if socket.ts also buffers, the
	// refcount stays at 1 and events are held for up to 5 s. Skipping this buffer on reconnects
	// lets the chats.ts flush drop the refcount to 0 and release messages immediately.
	const skipOfflineBuffer = hadStaleRoutingInfo || (authState?.creds?.accountSyncCounter ?? 0) > 0

	if (!isNativeAndroid && url.protocol === 'wss' && authState?.creds?.routingInfo) {
		url.searchParams.append('ED', authState.creds.routingInfo.toString('base64url'))
	}

	/** ephemeral key pair used to encrypt/decrypt communication. Unique for each connection */
	const ephemeralKeyPair = Curve.generateKeyPair()
	const nativeInitialRoutingInfo = transportSession.nativeAndroid?.initialRoutingInfo
	const noiseRoutingInfo =
		authState?.creds?.routingInfo ||
		(nativeInitialRoutingInfo?.byteLength ? Buffer.from(nativeInitialRoutingInfo) : undefined)
	const persistedNativeServerStatic = authState.creds.nativeAndroidIdentity?.serverStaticPublicKey
	const useNativeIK = Boolean(
		isNativeAndroid &&
		authState.creds.registered &&
		authState.creds.me &&
		persistedNativeServerStatic?.byteLength === 32
	)
	/** WA noise protocol wrapper */
	const noise = makeNoiseHandler({
		keyPair: ephemeralKeyPair,
		NOISE_HEADER: NOISE_WA_HEADER,
		logger,
		routingInfo: noiseRoutingInfo,
		nativeIK: useNativeIK
			? {
					initiatorStatic: authState.creds.noiseKey,
					responderStatic: persistedNativeServerStatic!
				}
			: undefined
	})

	const ws = isNativeAndroid ? new TcpSocketClient(url, config) : new WebSocketClient(url, config)

	const previousAuthStoreDrain = getAuthStoreDrainBarrier(authState.keys)
	if (previousAuthStoreDrain) {
		logger.warn('waiting for the previous socket auth-store drain before reconnecting')
		void previousAuthStoreDrain.then(() => {
			if (!closed) {
				ws.connect()
			}
		})
	} else {
		ws.connect()
	}

	const sendPromise = promisify(ws.send)
	/** send a raw buffer */
	const sendRawMessage = async (data: Uint8Array | Buffer) => {
		if (closed) throw createExpectedSocketTeardownError()

		if (!ws.isOpen) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		const bytes = noise.encodeFrame(data)
		await promiseTimeout<void>(connectTimeoutMs, async (resolve, reject) => {
			try {
				await sendPromise.call(ws, bytes)
				resolve()
			} catch (error) {
				reject(closed ? createExpectedSocketTeardownError() : error)
			}
		})
	}

	/** send a binary node */
	const sendNode = (frame: BinaryNode) => {
		if (logger.level === 'trace') {
			logger.trace({ xml: binaryNodeToString(frame), msg: 'xml send' })
		}

		const buff = encodeBinaryNode(frame)
		return sendRawMessage(buff)
	}

	// Initialize Unified Session Manager now that sendNode is defined
	if (enableUnifiedSession) {
		unifiedSessionManager = createUnifiedSessionManager({
			enabled: true,
			logger,
			sendNode
		})
		logger.info('Unified session manager initialized')
	}

	/** Send unified_session telemetry */
	const sendUnifiedSession = async (trigger: 'login' | 'pairing' | 'presence' | 'manual' = 'manual'): Promise<void> => {
		if (unifiedSessionManager) {
			await unifiedSessionManager.send(trigger)
		}
	}

	/**
	 * Wait for a message with a certain tag to be received
	 * @param msgId the message tag to await
	 * @param timeoutMs timeout after which the promise will reject
	 */
	const waitForMessage = async <T>(msgId: string, timeoutMs = defaultQueryTimeoutMs) => {
		if (closed) throw createExpectedSocketTeardownError()

		let onRecv: ((data: T) => void) | undefined
		let onErr: ((err: Error) => void) | undefined
		try {
			const result = await promiseTimeout<T>(timeoutMs, (resolve, reject) => {
				onRecv = data => {
					resolve(data)
				}

				onErr = err => {
					reject(
						closed
							? createExpectedSocketTeardownError()
							: err ||
									new Boom('Connection Closed', {
										statusCode: DisconnectReason.connectionClosed
									})
					)
				}

				ws.on(`TAG:${msgId}`, onRecv)
				ws.on('close', onErr)
				ws.on('error', onErr)

				return () => reject(new Boom('Query Cancelled'))
			})
			return result
		} catch (error) {
			// Catch timeout and return undefined instead of throwing
			if (error instanceof Boom && error.output?.statusCode === DisconnectReason.timedOut) {
				logger?.debug?.({ msgId }, 'timed out waiting for message')
				return undefined
			}

			throw error
		} finally {
			if (onRecv) ws.off(`TAG:${msgId}`, onRecv)
			if (onErr) {
				ws.off('close', onErr)
				ws.off('error', onErr)
			}
		}
	}

	/** send a query, and wait for its response. auto-generates message ID if not provided */
	const query = async (node: BinaryNode, timeoutMs?: number) => {
		if (!node.attrs.id) {
			node.attrs.id = generateMessageTag()
		}

		const msgId = node.attrs.id

		// Register the response listener BEFORE sending — avoids a race where the server
		// responds before we start listening. waitForMessage already handles its own
		// timeout (returns undefined) and connection-close errors (throws).
		const responsePromise = waitForMessage<any>(msgId, timeoutMs)
		// Prevent unhandled-rejection if sendNode throws before we reach
		// `await responsePromise` below. The error from sendNode still propagates
		// to the caller; this only silences the secondary rejection from
		// responsePromise (which waitForMessage will emit when ws closes).
		responsePromise.catch(() => {})

		// Await the send so that real sendNode failures (e.g. serialisation errors)
		// are surfaced to the caller immediately rather than silently discarded.
		// Socket-close errors are also propagated by waitForMessage via ws.on('close').
		await sendNode(node)

		const result = await responsePromise

		// Convert the `waitForMessage` timeout sentinel (returns `undefined`)
		// into a typed Boom so callers can `.catch` it as a real error.
		// Without this, `uploadPreKeys` logged "uploaded successfully" and
		// reset `lastUploadTime` on timeout (exhausting server-side prekeys),
		// `appPatch` advanced `app-state-sync-version` (LTHash divergence),
		// `fetchPrivacySettings` destructured `undefined` → opaque TypeError,
		// and `assertSessions` set `didFetchNewSession=true` without ever
		// injecting a session. (audit SOCK-01)
		if (result === undefined) {
			throw new Boom('query timed out', {
				statusCode: DisconnectReason.timedOut,
				data: { msgId, timeoutMs: timeoutMs ?? defaultQueryTimeoutMs }
			})
		}

		if (result && 'tag' in result) {
			assertNodeErrorFree(result)
		}

		return result
	}

	// Validate current key-bundle on server; on failure, trigger pre-key upload and rethrow
	const digestKeyBundle = async (): Promise<void> => {
		const res = await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'encrypt' },
			content: [{ tag: 'digest', attrs: {} }]
		})
		const digestNode = getBinaryNodeChild(res, 'digest')
		if (!digestNode) {
			await uploadPreKeys()
			throw new Error('encrypt/get digest returned no digest node')
		}
	}

	// Rotate our signed pre-key on server; on failure, run digest as fallback and rethrow
	const rotateSignedPreKey = async (): Promise<void> => {
		const newId = (creds.signedPreKey.keyId || 0) + 1
		const skey = await signedKeyPair(creds.signedIdentityKey, newId)
		await query({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'encrypt' },
			content: [
				{
					tag: 'rotate',
					attrs: {},
					content: [xmppSignedPreKey(skey)]
				}
			]
		})
		// Persist new signed pre-key in creds
		ev.emit('creds.update', { signedPreKey: skey })
	}

	const executeUSyncQuery = async (usyncQuery: USyncQuery) => {
		if (usyncQuery.protocols.length === 0) {
			throw new Boom('USyncQuery must have at least one protocol')
		}

		// todo: validate users, throw WARNING on no valid users
		// variable below has only validated users
		const validUsers = usyncQuery.users

		const userNodes = validUsers.map(user => {
			return {
				tag: 'user',
				attrs: {
					jid: !user.phone ? user.id : undefined
				},
				content: usyncQuery.protocols.map(a => a.getUserElement(user)).filter(a => a !== null)
			} as BinaryNode
		})

		const listNode: BinaryNode = {
			tag: 'list',
			attrs: {},
			content: userNodes
		}

		const queryNode: BinaryNode = {
			tag: 'query',
			attrs: {},
			content: usyncQuery.protocols.map(a => a.getQueryElement())
		}
		const iq = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'usync'
			},
			content: [
				{
					tag: 'usync',
					attrs: {
						context: usyncQuery.context,
						mode: usyncQuery.mode,
						sid: generateMessageTag(),
						last: 'true',
						index: '0'
					},
					content: [queryNode, listNode]
				}
			]
		}

		const result = await query(iq)

		return usyncQuery.parseUSyncQueryResult(result)
	}

	const onWhatsApp = async (...phoneNumber: string[]) => {
		let usyncQuery = new USyncQuery()

		let contactEnabled = false
		for (const jid of phoneNumber) {
			if (isLidUser(jid)) {
				logger?.warn('LIDs are not supported with onWhatsApp')
				continue
			} else {
				if (!contactEnabled) {
					contactEnabled = true
					usyncQuery = usyncQuery.withContactProtocol()
				}

				const phone = `+${jid.replace('+', '').split('@')[0]?.split(':')[0]}`
				usyncQuery.withUser(new USyncUser().withPhone(phone))
			}
		}

		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}

		const results = await executeUSyncQuery(usyncQuery)

		if (results) {
			return results.list.filter(a => !!a.contact).map(({ contact, id }) => ({ jid: id, exists: contact as boolean }))
		}
	}

	const pnFromLIDUSync = async (jids: string[]): Promise<LIDMapping[] | undefined> => {
		const usyncQuery = new USyncQuery().withLIDProtocol().withContext('background')

		for (const jid of jids) {
			if (isLidUser(jid)) {
				logger?.warn('LID user found in LID fetch call')
				continue
			} else {
				usyncQuery.withUser(new USyncUser().withId(jid))
			}
		}

		if (usyncQuery.users.length === 0) {
			return [] // return early without forcing an empty query
		}

		const results = await executeUSyncQuery(usyncQuery)

		if (results) {
			return results.list.filter(a => !!a.lid).map(({ lid, id }) => ({ pn: id, lid: lid as string }))
		}

		return []
	}

	const ev = makeEventBuffer(logger)

	// Persist the routingInfo clearing so the consumer's saveCreds() writes the clean state to disk.
	// This ensures that if the process restarts again before the server assigns new routingInfo,
	// the stale value is not reused.
	if (!isNativeAndroid && config.clearRoutingInfoOnStart && !authState?.creds?.routingInfo) {
		ev.emit('creds.update', authState.creds)
	}

	if (transportSession.credsChanged) {
		// Consumers attach `creds.update` after makeWASocket returns. Emitting
		// synchronously here loses the first durable transport identity and a QR
		// refresh can then select a different catalog entry.
		setTimeout(
			() =>
				ev.emit('creds.update', {
					nativeAndroidIdentity: authState.creds.nativeAndroidIdentity,
					registered: authState.creds.registered
				}),
			0
		)
		logger.info(
			{ transportProfile: 'native_android', selectedProfileId: transportSession.nativeAndroid!.device.profileId },
			'native_android identity selected and persisted for this session'
		)
	}

	const { creds } = authState
	// add transaction capability
	const keys = addTransactionCapability(authState.keys, logger, transactionOpts)
	const signalRepository = makeSignalRepository({ creds, keys }, logger, pnFromLIDUSync, {
		multiDbStore: config.multiDbStore
	})

	// Session activity tracker - tracks last activity for cleanup (must be created first)
	const sessionActivityTracker = makeSessionActivityTracker(keys, logger)

	// Session cleanup manager - removes inactive/orphaned sessions
	// Merge user config with defaults to prevent partial overrides from breaking cleanup
	const sessionCleanupConfig = {
		...DEFAULT_SESSION_CLEANUP_CONFIG,
		...(config.sessionCleanupConfig || {})
	}
	const sessionCleanup = makeSessionCleanup(
		keys,
		signalRepository.lidMapping,
		sessionActivityTracker,
		logger,
		sessionCleanupConfig
	)

	let lastDateRecv: Date
	let epoch = 1
	let keepAliveReq: NodeJS.Timeout
	let qrTimer: NodeJS.Timeout

	/**
	 * Connection closed flag - protected by atomic check-and-set in end()
	 *
	 * THREAD SAFETY: This flag uses atomic check-and-set pattern (see end() function)
	 * to prevent race conditions between:
	 * - Multiple simultaneous calls to end() (prevents double cleanup)
	 * - Operations checking flag while end() is destroying resources
	 *
	 * USAGE: Always check this flag BEFORE accessing socket resources (ws, keys, etc.)
	 * The flag is set IMMEDIATELY in end() before any async operations to minimize race window.
	 */
	// Stable id for THIS socket instance, used by the active-connections
	// gauge. Must be unique per instance (not per JID): two sockets for the
	// same number — the overlapping-reconnect case — count as 2, and the old
	// socket's teardown must not evict the new socket's gauge entry. Generated
	// once here so `markConnectionActive` (on open) and `markConnectionInactive`
	// (in end()) always reference the same id.
	const connectionId = `sock:${randomBytes(8).toString('hex')}`

	// Callbacks run on socket close to release per-module resources (caches, timers) and prevent
	// memory leaks on disconnect. Adapted from upstream #2191 — but we deliberately do NOT call
	// ev.destroy() here, because end() intentionally keeps connection.update listeners alive for
	// the consumer's reconnection logic (see end()).
	const socketEndHandlers: Array<(error: Error | undefined) => void | Promise<void>> = []
	const registerSocketEndHandler = (handler: (error: Error | undefined) => void | Promise<void>) => {
		socketEndHandlers.push(handler)
	}

	// Higher socket layers register work that must finish before Signal, LID
	// mapping and the auth-key transaction capability are destroyed. This is
	// intentionally separate from socketEndHandlers: those are post-close
	// cache/timer cleanup callbacks and historically run after repository
	// teardown.
	const socketDrainHandlers: Array<(error: Error | undefined) => void | Promise<void>> = []
	const registerSocketDrainHandler = (handler: (error: Error | undefined) => void | Promise<void>) => {
		socketDrainHandlers.push(handler)
	}

	// Session TTL and cleanup
	const SESSION_TTL = 7 * 24 * 60 * 60 * 1000 // 7 days
	let sessionStartTime: number | undefined
	let ttlTimer: NodeJS.Timeout | undefined
	let ttlGraceTimer: NodeJS.Timeout | undefined

	/** log & process any unexpected errors */
	const onUnexpectedError = (err: Error | Boom, msg: string) => {
		if (isExpectedSocketTeardownError(err)) {
			logger.debug({ msg }, 'in-flight socket work cancelled by connection teardown')
			return
		}

		logger.error({ err }, `unexpected error in '${msg}'`)
	}

	const mapSocketLifecycleError = (handler: (err: Error) => void) => {
		const handleWebSocketError = mapWebSocketError(handler)

		return (error: Error) => {
			if (closed) {
				handler(createExpectedSocketTeardownError(error))
			} else {
				handleWebSocketError(error)
			}
		}
	}

	/** await the next incoming message */
	const awaitNextMessage = async <T>(sendMsg?: Uint8Array) => {
		if (closed) throw createExpectedSocketTeardownError()

		if (!ws.isOpen) {
			throw new Boom('Connection Closed', {
				statusCode: DisconnectReason.connectionClosed
			})
		}

		let onOpen: (data: T) => void
		let onClose: (err: Error) => void

		const result = promiseTimeout<T>(connectTimeoutMs, (resolve, reject) => {
			onOpen = resolve
			onClose = mapSocketLifecycleError(reject)
			ws.on('frame', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('frame', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})

		if (sendMsg) {
			sendRawMessage(sendMsg).catch(onClose!)
		}

		return result
	}

	/** connection handshake */
	const validateConnection = async () => {
		const persistCertifiedNativeResponder = () => {
			if (!isNativeAndroid) return

			const serverStaticPublicKey = noise.getServerStaticKey()
			const persistedIdentity = authState.creds.nativeAndroidIdentity
			if (
				serverStaticPublicKey &&
				persistedIdentity &&
				(!persistedIdentity.serverStaticPublicKey ||
					!Buffer.from(persistedIdentity.serverStaticPublicKey).equals(serverStaticPublicKey))
			) {
				persistedIdentity.serverStaticPublicKey = serverStaticPublicKey
				ev.emit('creds.update', { nativeAndroidIdentity: persistedIdentity })
				logger.debug(
					{
						transportProfile: transportSession.profile,
						selectedProfileId: transportSession.nativeAndroid?.device.profileId,
						action: 'persist-certified-noise-responder-key'
					},
					'native_android: certified Noise responder identity persisted'
				)
			}
		}

		if (useNativeIK) {
			const node = generateLoginNode(creds.me!.id, payloadConfig, nativeClientPayloadContext)
			const payload = proto.ClientPayload.encode(node).finish()
			const init = noise.createIKClientHello(payload)
			logger.info(
				{
					transportProfile: transportSession.profile,
					handshake: 'IK',
					platform: node.userAgent?.platform,
					appVersion: node.userAgent?.appVersion,
					selectedProfileId: transportSession.nativeAndroid?.device.profileId,
					clientPayloadLength: payload.byteLength
				},
				'native_android: reconnecting with persisted certified responder identity'
			)

			const result = await awaitNextMessage<Uint8Array>(init)
			const handshake = proto.HandshakeMessage.decode(result)
			if (noise.requiresXXFallback(handshake)) {
				logger.warn(
					{
						transportProfile: transportSession.profile,
						handshake: 'XXfallback',
						selectedProfileId: transportSession.nativeAndroid?.device.profileId,
						reason: 'server-hello-contained-static-key'
					},
					'native_android: server rejected IK resume; completing the official XX fallback transcript'
				)
				noise.resetToXXFallback()
				const keyEnc = noise.processHandshake(handshake, creds.noiseKey)
				persistCertifiedNativeResponder()
				const payloadEnc = noise.encrypt(payload)
				await sendRawMessage(
					proto.HandshakeMessage.encode({
						clientFinish: {
							static: keyEnc,
							payload: payloadEnc
						}
					}).finish()
				)
			} else {
				noise.processIKServerHello(handshake)
			}

			await noise.finishInit()
			startKeepAliveRequest()
			return
		}

		let helloMsg: proto.IHandshakeMessage = {
			clientHello: { ephemeral: ephemeralKeyPair.public }
		}
		helloMsg = proto.HandshakeMessage.fromObject(helloMsg)

		const init = proto.HandshakeMessage.encode(helloMsg).finish()

		const result = await awaitNextMessage<Uint8Array>(init)
		const handshake = proto.HandshakeMessage.decode(result)

		logger.trace({ handshake }, 'handshake recv from WA')

		const keyEnc = noise.processHandshake(handshake, creds.noiseKey)
		persistCertifiedNativeResponder()

		let node: proto.IClientPayload
		if (!creds.me) {
			node = generateRegistrationNode(creds, payloadConfig, nativeClientPayloadContext)
			logger.info(
				{
					transportProfile: transportSession.profile,
					platform: node.userAgent?.platform,
					appVersion: node.userAgent?.appVersion,
					selectedProfileId: transportSession.nativeAndroid?.device.profileId
				},
				'not logged in, attempting registration...'
			)
		} else {
			node = generateLoginNode(creds.me.id, payloadConfig, nativeClientPayloadContext)
			logger.info(
				{
					transportProfile: transportSession.profile,
					platform: node.userAgent?.platform,
					appVersion: node.userAgent?.appVersion,
					selectedProfileId: transportSession.nativeAndroid?.device.profileId
				},
				'logging in...'
			)
		}

		const payloadEnc = noise.encrypt(proto.ClientPayload.encode(node).finish())
		await sendRawMessage(
			proto.HandshakeMessage.encode({
				clientFinish: {
					static: keyEnc,
					payload: payloadEnc
				}
			}).finish()
		)
		await noise.finishInit()
		startKeepAliveRequest()
	}

	const getAvailablePreKeysOnServer = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				id: generateMessageTag(),
				xmlns: 'encrypt',
				type: 'get',
				to: S_WHATSAPP_NET
			},
			content: [{ tag: 'count', attrs: {} }]
		})
		const countChild = getBinaryNodeChild(result, 'count')!
		return +countChild.attrs.value!
	}

	// Pre-key upload state management
	let uploadPreKeysPromise: Promise<void> | null = null
	let lastUploadTime = 0

	// Only the auth-state that owns the typed prekeys table may control upload
	// progress. `config.multiDbStore` can be a separate best-effort mirror and
	// must never be allowed to rewind or commit the real auth cursor.
	const prekeyUploads = keys.prekeyUploads

	// Records a successful pre-key upload into the multi-db-sqlite axolotl.db,
	// atomically: flips the acked ids [fromId, toId) to sent_to_server = 1 (in
	// chunks of 200) and appends one prekey_uploads row, in a single transaction
	// — mirroring the real SignalPreKeyStore. Timestamp is epoch SECONDS (Android
	// stores seconds). Multi-db-only; single-file / legacy skip it. Best-effort:
	// a DB failure here does NOT undo the upload (the server already acked and the
	// creds cursor already advanced) — it is logged and the table self-heals on
	// the next upload, so it never fails the operation, but it is NOT swallowed
	// silently either.
	const recordPrekeyUpload = (fromId: number, toId: number): void => {
		if (!(toId > fromId)) return
		try {
			if (!prekeyUploads) return
			prekeyUploads.commitUpload(fromId, toId, Math.floor(Date.now() / 1000))
		} catch (err) {
			logger.warn(
				{ err, fromId, toId },
				'multi-db-sqlite: prekey upload commit failed — cursor already advanced, table will self-heal next upload'
			)
		}
	}

	/** generates and uploads a set of pre-keys to the server */
	const uploadPreKeys = async (count = MIN_PREKEY_COUNT) => {
		// Rate-limit: skip if too soon since the last SUCCESSFUL upload.
		const timeSinceLastUpload = Date.now() - lastUploadTime
		if (timeSinceLastUpload < MIN_UPLOAD_INTERVAL) {
			logger.debug(`pre-keys: skipping upload, only ${timeSinceLastUpload}ms since last`)
			return
		}

		// Single-flight: if an upload is already running, wait for it and return —
		// never start a second. The retry below is an INTERNAL loop (not a
		// recursive uploadPreKeys call), so a retry can never re-enter here and
		// deadlock awaiting its own in-flight promise.
		if (uploadPreKeysPromise) {
			logger.debug('pre-keys: upload already in progress, waiting for completion')
			await uploadPreKeysPromise
			return
		}

		const MAX_RETRIES = 3
		// Explicit per-attempt timeout so an attempt is never unbounded. We must NOT
		// blindly rely on `defaultQueryTimeoutMs` (it is `number | undefined`; a
		// consumer can disable it, and `promiseTimeout(undefined)` builds a promise
		// with NO timeout — query() would then hang forever and, since the
		// single-flight promise wraps the whole loop, permanently block every future
		// upload). But we also must NOT clamp a valid config: a consumer's positive
		// value is honoured and only a disabled/0 timeout falls back to 30s.
		const PREKEY_UPLOAD_QUERY_TIMEOUT_MS = resolvePrekeyUploadQueryTimeout(defaultQueryTimeoutMs)

		const runWithRetries = async () => {
			// Reconcile both cursors from the authoritative typed table. Besides
			// rewinding for legacy unsent orphans, this must advance past a durable ACK
			// when a crash happened before the matching creds.update reached creds.db.
			// `nextGeneratedId` also prevents regeneration over durable key material if
			// the allocation-cursor save was the write lost by the crash.
			try {
				const firstUnsent = prekeyUploads?.firstUnsentId()
				const typedNextGenerated = prekeyUploads?.nextGeneratedId()
				const unsent = prekeyUploads?.countUnsent()
				const cursorBefore = {
					firstUnuploadedPreKeyId: creds.firstUnuploadedPreKeyId,
					nextPreKeyId: creds.nextPreKeyId
				}
				const cursorUpdate = applyReconciledPrekeyCursors(creds, {
					firstUnsentId: firstUnsent ?? null,
					nextGeneratedId: typedNextGenerated ?? null,
					unsentCount: unsent ?? 0
				})

				if (Object.keys(cursorUpdate).length > 0) {
					logger.info(
						{
							from: cursorBefore,
							to: cursorUpdate,
							firstUnsent,
							typedNextGenerated,
							unsent
						},
						'pre-keys: self-heal reconciled creds cursors from authoritative typed prekeys'
					)
					ev.emit('creds.update', cursorUpdate)
				}
			} catch (err) {
				logger.debug({ err }, 'multi-db-sqlite: prekey self-heal check failed (non-fatal)')
			}

			let lastError: unknown
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				const startedAt = Date.now()
				// Not committed until the server acks, so a retry reads the SAME
				// starting cursor and regenerates nothing — it re-sends this range.
				const firstUnuploadedBefore = creds.firstUnuploadedPreKeyId
				let committedFirstUnuploaded = firstUnuploadedBefore
				let allocatedNextPreKeyId = creds.nextPreKeyId
				let reservationError: unknown

				logger.info(
					{ requested: count, attempt },
					`pre-keys: ${attempt ? `retry #${attempt}` : 'starting'} upload of ${count}`
				)

				// Generate + persist the batch atomically.
				const node = await keys.transaction(async () => {
					const { update, node } = await getNextPreKeysNode({ creds, keys }, count)
					committedFirstUnuploaded = update.firstUnuploadedPreKeyId ?? firstUnuploadedBefore
					allocatedNextPreKeyId = update.nextPreKeyId ?? creds.nextPreKeyId
					const generated = committedFirstUnuploaded - firstUnuploadedBefore
					logger.info(
						{
							fromId: firstUnuploadedBefore,
							toId: committedFirstUnuploaded,
							keys: generated,
							nextPreKeyId: allocatedNextPreKeyId
						},
						`pre-keys: prepared batch of ${generated} — ids [${firstUnuploadedBefore}..${committedFirstUnuploaded}) — awaiting server ack`
					)
					keys.afterCommit(() => {
						if (!prekeyUploads || !(committedFirstUnuploaded > firstUnuploadedBefore)) return
						try {
							const expected = committedFirstUnuploaded - firstUnuploadedBefore
							const reserved = prekeyUploads.reserveUploadRange(
								firstUnuploadedBefore,
								committedFirstUnuploaded,
								Math.floor(Date.now() / 1000)
							)
							if (reserved !== expected) {
								reservationError = new Error(
									`pre-keys: authoritative upload reservation covered ${reserved}/${expected} rows for ` +
										`[${firstUnuploadedBefore}..${committedFirstUnuploaded}); refusing to send an ambiguous batch`
								)
							}
						} catch (err) {
							reservationError = err
						}
					})
					return node
				}, creds?.me?.id || 'upload-pre-keys')

				// Keys are now committed to storage → only NOW advance the allocation
				// counter, so a failed keys.transaction() (rollback) never leaves
				// `nextPreKeyId` pointing past ids that were never persisted. Holds
				// back `firstUnuploadedPreKeyId` (upload progress) until the ack below.
				ev.emit('creds.update', { nextPreKeyId: allocatedNextPreKeyId })

				// afterCommit runs only after the generated key mutations are durable.
				// A reservation failure must therefore NOT make the caller believe the
				// whole transaction rolled back: doing so leaves nextPreKeyId stale and
				// the next attempt regenerates different key material over the same ids.
				// Advance only the allocation cursor, keep upload progress unchanged, and
				// retry the exact persisted range without sending an ambiguous IQ.
				if (reservationError) {
					lastError = reservationError
					logger.error(
						{
							reservationError: (reservationError as Error)?.toString?.() ?? String(reservationError),
							fromId: firstUnuploadedBefore,
							toId: committedFirstUnuploaded,
							attempt,
							nextPreKeyId: allocatedNextPreKeyId,
							firstUnuploadedPreKeyId: firstUnuploadedBefore,
							action: attempt < MAX_RETRIES ? 'retry-persisted-range' : 'fail-preserving-persisted-range'
						},
						'pre-keys: post-commit upload reservation failed; allocation cursor preserved and IQ suppressed'
					)
					if (attempt < MAX_RETRIES) {
						const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000)
						await new Promise(resolve => setTimeout(resolve, backoffDelay))
					}

					continue
				}

				try {
					await query(node, PREKEY_UPLOAD_QUERY_TIMEOUT_MS)
					const durationMs = Date.now() - startedAt
					lastUploadTime = Date.now()
					// Server acked → advance the upload-progress cursor (all backends),
					// then flip the per-key flag + append prekey_uploads atomically
					// (multi-db, best-effort self-healing).
					ev.emit('creds.update', { firstUnuploadedPreKeyId: committedFirstUnuploaded })
					recordPrekeyUpload(firstUnuploadedBefore, committedFirstUnuploaded)
					logger.info(
						{
							uploaded: committedFirstUnuploaded - firstUnuploadedBefore,
							fromId: firstUnuploadedBefore,
							toId: committedFirstUnuploaded,
							durationMs
						},
						`pre-keys: ✓ uploaded & acked in ${durationMs}ms — ` +
							`${committedFirstUnuploaded - firstUnuploadedBefore} keys [${firstUnuploadedBefore}..${committedFirstUnuploaded}) marked sent_to_server`
					)
					return
				} catch (uploadError) {
					lastError = uploadError
					const durationMs = Date.now() - startedAt
					logger.error(
						{ uploadError: (uploadError as Error).toString(), count, attempt, durationMs },
						`pre-keys: ✗ upload failed after ${durationMs}ms — keys [${firstUnuploadedBefore}..${committedFirstUnuploaded}) kept unuploaded`
					)
					if (attempt < MAX_RETRIES) {
						const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000)
						logger.info(`pre-keys: retrying upload in ${backoffDelay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
						await new Promise(resolve => setTimeout(resolve, backoffDelay))
					}
				}
			}

			throw lastError
		}

		// The single-flight promise tracks the WHOLE retry loop — no outer
		// Promise.race timeout. An external timeout would resolve the guard while
		// runWithRetries() kept running in the background, letting a subsequent
		// call start a second, concurrent upload. The loop can't hang because each
		// query() is given a bounded PREKEY_UPLOAD_QUERY_TIMEOUT_MS (the consumer's
		// timeout when set, else a 30s fallback — never the disable-able undefined),
		// so every attempt terminates and the guard is always released.
		uploadPreKeysPromise = runWithRetries()

		try {
			await uploadPreKeysPromise
		} finally {
			uploadPreKeysPromise = null
		}
	}

	const verifyCurrentPreKeyExists = async () => {
		const currentPreKeyId = creds.nextPreKeyId - 1
		if (currentPreKeyId <= 0) {
			return { exists: false, currentPreKeyId: 0 }
		}

		const preKeys = await keys.get('pre-key', [currentPreKeyId.toString()])
		const exists = !!preKeys[currentPreKeyId.toString()]

		return { exists, currentPreKeyId }
	}

	const uploadPreKeysToServerIfRequired = async () => {
		try {
			let count = 0
			const preKeyCount = await getAvailablePreKeysOnServer()
			if (preKeyCount === 0) count = INITIAL_PREKEY_COUNT
			else count = MIN_PREKEY_COUNT
			const { exists: currentPreKeyExists, currentPreKeyId } = await verifyCurrentPreKeyExists()

			const lowServerCount = preKeyCount <= count
			const missingCurrentPreKey = !currentPreKeyExists && currentPreKeyId > 0
			const shouldUpload = lowServerCount || missingCurrentPreKey

			logger.info(
				{ serverCount: preKeyCount, threshold: count, currentPreKeyId, currentPreKeyExists, willUpload: shouldUpload },
				`pre-keys: server has ${preKeyCount} (threshold ${count}), current prekey #${currentPreKeyId} ${currentPreKeyExists ? 'present' : 'MISSING'} in storage`
			)

			if (shouldUpload) {
				const reasons = []
				if (lowServerCount) reasons.push(`server count low (${preKeyCount} ≤ ${count})`)
				if (missingCurrentPreKey) reasons.push(`current prekey #${currentPreKeyId} missing from storage`)

				logger.info(`pre-keys: upload required — ${reasons.join('; ')}`)
				await uploadPreKeys(count)
			} else {
				logger.info(`pre-keys: validation passed — no upload needed (server ${preKeyCount} > ${count})`)
			}
		} catch (error) {
			logger.error({ error }, 'Failed to check/upload pre-keys during initialization')
			// Don't throw - allow connection to continue even if pre-key check fails
		}
	}

	/**
	 * PreKey Auto-Sync: Proactive validation every 6 hours
	 * Prevents "Identity key field not found" errors by ensuring keys are always valid
	 * Returns cleanup function to remove event listener
	 */
	const startPreKeyAutoSync = () => {
		const SYNC_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
		let syncTimer: NodeJS.Timeout | undefined
		let isRunning = false

		/**
		 * Cleanup flag - protected by atomic check-and-set in cleanup function
		 *
		 * THREAD SAFETY: This flag uses atomic check-and-set pattern (see cleanup return function)
		 * to prevent race conditions between:
		 * - syncLoop reschedule check (line 790) and cleanup setting flag to true
		 * - Multiple calls to cleanup function (reentrancy guard)
		 *
		 * CRITICAL: Prevents timer orphaning where syncLoop creates new timer
		 * after cleanup has cleared the existing timer, causing memory leak.
		 */
		let cleanedUp = false

		const syncLoop = async () => {
			// PROTECTION 1: Prevent overlapping runs
			if (isRunning) {
				logger.warn('🔑 PreKey sync already running, skipping this cycle')
				return
			}

			// PROTECTION 2: Check connection state AND cleanup flag
			// Safe to check these flags because:
			// - 'closed': Atomic check-and-set in end() (V7 fix)
			// - 'cleanedUp': Atomic check-and-set in cleanup() (V8 fix)
			// - If either is true, we return immediately (no resource access)
			// - If both are false, resources guaranteed available
			// - Race windows minimized by immediate flag setting after checks
			if (closed || !ws.isOpen || cleanedUp) {
				logger.debug('🔑 Connection closed, stopping PreKey sync')
				return
			}

			isRunning = true
			try {
				logger.info('🔑 PreKey auto-sync started (6h interval)')
				await uploadPreKeysToServerIfRequired()
				logger.info('🔑 PreKey auto-sync completed successfully')
			} catch (error) {
				logger.error({ error }, '🔑 PreKey auto-sync failed')
			} finally {
				isRunning = false

				// PROTECTION 3: Prevent timer accumulation and post-cleanup rescheduling
				// Check flags inside finally to minimize race window
				// CRITICAL: Even with minimal race window, cleanup's atomic check-and-set
				// ensures cleanedUp=true BEFORE clearTimeout, so if we create a timer here
				// after cleanup check but before our check, cleanup will clear it.
				// If cleanup sets cleanedUp=true after our check, new timer won't be cleared,
				// but V8 fix ensures cleanedUp is set IMMEDIATELY, minimizing this window.
				if (!closed && !cleanedUp && ws.isOpen) {
					syncTimer = setTimeout(syncLoop, SYNC_INTERVAL)
				}
			}
		}

		// PROTECTION 4: Initial delay (avoid duplicate at startup)
		// CB:success already calls uploadPreKeysToServerIfRequired(), so wait 6h before first auto-sync
		const connectionHandler = (update: Partial<ConnectionState>) => {
			if (update.connection === 'open') {
				logger.info('🔑 Starting PreKey auto-sync timer (first sync in 6h)')
				syncTimer = setTimeout(syncLoop, SYNC_INTERVAL)
			} else if (update.connection === 'close') {
				// PROTECTION 5: Cleanup on disconnect
				if (syncTimer) {
					clearTimeout(syncTimer)
					syncTimer = undefined
					isRunning = false
					logger.info('🔑 PreKey auto-sync stopped')
				}
			}
		}

		ev.on('connection.update', connectionHandler)

		// PROTECTION 6: Return cleanup function with atomic check-and-set
		return () => {
			// PROTECTION: Atomic check-and-set to prevent race conditions
			// Flag is set IMMEDIATELY after check, BEFORE any operations
			// This prevents:
			// 1. Multiple calls to cleanup (reentrancy guard)
			// 2. Timer orphaning: syncLoop creating timer after clearTimeout
			if (cleanedUp) {
				return // Already cleaned up
			}

			cleanedUp = true // ← Set IMMEDIATELY to close race window

			ev.off('connection.update', connectionHandler)
			if (syncTimer) {
				clearTimeout(syncTimer)
				syncTimer = undefined
			}
		}
	}

	// Initialize PreKey auto-sync and store cleanup function
	const cleanupPreKeyAutoSync = startPreKeyAutoSync()

	/**
	 * Session TTL Management: Graceful cleanup after 7 days
	 * Prevents memory leaks and allows credential rotation in long-running sessions
	 * Returns cleanup function to remove event listener
	 */
	const startSessionTTL = () => {
		/**
		 * Cleanup flag - protected by atomic check-and-set in cleanup function
		 *
		 * THREAD SAFETY: This flag uses atomic check-and-set pattern to prevent
		 * race conditions between:
		 * - ttlTimer callback creating ttlGraceTimer after cleanup cleared timers
		 * - Multiple cleanup calls (connectionHandler + cleanup function)
		 *
		 * CRITICAL: Prevents timer orphaning where ttlTimer expires and creates
		 * ttlGraceTimer after cleanup has cleared ttlTimer, causing end() to be
		 * called after socket cleanup is complete.
		 */
		let cleanedUp = false

		const connectionHandler = (update: Partial<ConnectionState>) => {
			if (update.connection === 'open') {
				sessionStartTime = Date.now()

				// PROTECTION 1: Long TTL (7 days)
				ttlTimer = setTimeout(() => {
					// PROTECTION: Check cleanup flag to prevent orphan timer creation
					// If cleanup was called while ttlTimer was pending, abort immediately
					if (cleanedUp) {
						logger.debug('🕐 TTL timer fired but cleanup already called, aborting')
						return
					}

					if (!sessionStartTime) {
						logger.debug('TTL timer: sessionStartTime not set, skipping')
						return
					}

					const duration = Date.now() - sessionStartTime
					const durationHours = Math.floor(duration / 1000 / 60 / 60)

					logger.info(`🕐 Session TTL reached after ${durationHours}h, initiating graceful cleanup`)

					// PROTECTION 2: Event-based (app decides)
					ev.emit('session.ttl-expired', {
						startTime: sessionStartTime,
						duration: duration
					})

					// PROTECTION 3: Graceful delay before cleanup (with proper cleanup)
					// Check cleanup flag again before creating grace timer to prevent orphaning
					if (cleanedUp) {
						logger.debug('🕐 Cleanup called before grace timer creation, aborting')
						return
					}

					ttlGraceTimer = setTimeout(() => {
						// PROTECTION: Check cleanup flag before calling end()
						// Prevents calling end() after socket cleanup is complete
						if (cleanedUp) {
							logger.debug('🕐 Grace timer fired but cleanup already called, aborting')
							return
						}

						logger.info('🕐 Proceeding with TTL cleanup after grace period')
						end(new Error('SESSION_TTL_EXPIRED'))
					}, 5000) // 5s grace period
				}, SESSION_TTL)

				const ttlHours = SESSION_TTL / 1000 / 60 / 60
				logger.info(`🕐 Session TTL started (${ttlHours}h = 7 days)`)
			} else if (update.connection === 'close') {
				// PROTECTION 4: Cleanup ALL timers on disconnect
				// Safe to check cleanedUp here - if cleanup function already ran,
				// we return early to avoid redundant cleanup
				if (cleanedUp) {
					logger.debug('🕐 Session TTL already cleaned up via cleanup function')
					return
				}

				// Clear all timers - cleanedUp flag in callbacks prevents orphaning
				if (ttlTimer) {
					clearTimeout(ttlTimer)
					ttlTimer = undefined
				}

				if (ttlGraceTimer) {
					clearTimeout(ttlGraceTimer)
					ttlGraceTimer = undefined
				}

				sessionStartTime = undefined
				logger.info('🕐 Session TTL timers cleared on disconnect')
			}
		}

		ev.on('connection.update', connectionHandler)

		// PROTECTION 5: Return cleanup function with atomic check-and-set
		return () => {
			// PROTECTION: Atomic check-and-set to prevent race conditions
			// Flag is set IMMEDIATELY after check, BEFORE any operations
			// This prevents:
			// 1. Multiple cleanup calls (reentrancy guard)
			// 2. Timer callbacks from creating new timers or calling end()
			if (cleanedUp) {
				logger.debug('🕐 Session TTL cleanup already called')
				return
			}

			cleanedUp = true // ← Set IMMEDIATELY to close race window

			ev.off('connection.update', connectionHandler)
			if (ttlTimer) {
				clearTimeout(ttlTimer)
				ttlTimer = undefined
			}

			if (ttlGraceTimer) {
				clearTimeout(ttlGraceTimer)
				ttlGraceTimer = undefined
			}

			logger.debug('🕐 Session TTL cleanup function executed')
		}
	}

	// Initialize Session TTL and store cleanup function
	const cleanupSessionTTL = startSessionTTL()

	const onMessageReceived = async (data: Buffer) => {
		try {
			await noise.decodeFrame(data, frame => {
				try {
					// reset ping timeout
					lastDateRecv = new Date()

					let anyTriggered = false

					try {
						anyTriggered = ws.emit('frame', frame)
					} catch (error) {
						logger.error(
							{ connectionId, jid: authState.creds.me?.id, transportProfile: transportSession.profile, error },
							'generic frame listener failed; continuing authenticated TAG/CB dispatch'
						)
					}

					// if it's a binary node
					if (!(frame instanceof Uint8Array)) {
						const msgId = frame.attrs.id

						// Update server time offset from any node with timestamp 't'
						// This keeps the offset accurate even after long connections
						const serverTime = extractServerTime(frame)
						if (serverTime) {
							unifiedSessionManager?.updateServerTimeOffset(serverTime)
						}

						if (logger.level === 'trace') {
							logger.trace({ xml: binaryNodeToString(frame), msg: 'recv xml' })
						}

						/* Check if this is a response to a message we sent */
						anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered
						/* Check if this is a response to a message we are expecting */
						const l0 = frame.tag
						const l1 = frame.attrs || {}
						const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : ''

						for (const key of Object.keys(l1)) {
							anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered
							anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered
							anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered
						}

						anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered
						anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered

						if (!anyTriggered && logger.level === 'debug') {
							logger.debug({ unhandled: true, msgId, fromMe: false, frame }, 'communication recv')
						}
					}
				} catch (error) {
					logger.error(
						{
							connectionId,
							jid: authState.creds.me?.id,
							transportProfile: transportSession.profile,
							error
						},
						'transport frame listener failed; authenticated socket remains open'
					)
				}
			})
		} catch (error) {
			logger.error(
				{
					connectionId,
					jid: authState.creds.me?.id,
					transportProfile: transportSession.profile,
					error
				},
				'transport frame authentication failed; closing affected socket'
			)
			await end(
				new Boom('Transport frame authentication failed', {
					statusCode: DisconnectReason.connectionClosed,
					data: { connectionId, cause: error instanceof Error ? error.message : String(error) }
				})
			)
		}
	}

	const end = async (error: Error | undefined) => {
		// PROTECTION: Atomic check-and-set to prevent race conditions
		// Flag is set IMMEDIATELY after check, BEFORE any async operations
		// This minimizes the race window and prevents:
		// 1. Multiple simultaneous calls to end() from destroying resources twice
		// 2. Operations checking 'closed' while resources are being destroyed
		if (closed) {
			logger.trace({ trace: error?.stack }, 'connection already closed')
			return
		}

		closed = true // ← Set IMMEDIATELY to close race window

		// Close admission before the first await in teardown. Each async drain
		// handler executes its synchronous prefix immediately, preventing new
		// message/receipt/notification work from entering while lifecycle
		// services are stopping.
		const drainPromises = socketDrainHandlers.map(async handler => {
			try {
				await handler(error)
			} catch (err) {
				logger.error({ err, connectionId }, 'error draining socket processing')
			}
		})

		const statusCode = error ? (error as Boom)?.output?.statusCode || 0 : 0
		const restartRequired = statusCode === DisconnectReason.restartRequired

		if (restartRequired) {
			logger.debug(
				{ statusCode, reason: 'restartRequired' },
				'closing initial socket for the required authenticated restart'
			)
			recordConnectionRestart('restart_required')
		} else {
			logger.info({ trace: error?.stack }, error ? 'connection errored' : 'connection closed')
		}

		// Record connection error metric
		// restartRequired (515) is expected control flow after pairing or
		// registration, not a failed connection attempt.
		if (error && !restartRequired) {
			let errorType = 'unknown'
			switch (statusCode) {
				case DisconnectReason.connectionClosed:
					errorType = 'connection_closed'
					break
				case DisconnectReason.connectionLost:
					errorType = 'connection_lost'
					break
				case DisconnectReason.connectionReplaced:
					errorType = 'connection_replaced'
					break
				case DisconnectReason.timedOut:
					errorType = 'timed_out'
					break
				case DisconnectReason.loggedOut:
					errorType = 'logged_out'
					break
				case DisconnectReason.badSession:
					errorType = 'bad_session'
					break
				case DisconnectReason.multideviceMismatch:
					errorType = 'multidevice_mismatch'
					break
				default:
					// Audit SEC-003 — antes `error_${statusCode}` criava UMA série
					// Prometheus por código distinto. Servidor sob carga ou
					// codes exóticos → cardinality explosion no `/metrics` e
					// OOM no scraper. Agora bucketamos por faixa HTTP/WS pra
					// limitar a cardinalidade do label a ~5 valores.
					if (typeof statusCode === 'number' && statusCode >= 500) {
						errorType = 'error_5xx'
					} else if (typeof statusCode === 'number' && statusCode >= 400) {
						errorType = 'error_4xx'
					} else if (typeof statusCode === 'number' && statusCode >= 300) {
						errorType = 'error_3xx'
					} else {
						errorType = 'error_other'
					}
			}

			recordConnectionError(errorType)
			recordConnectionAttempt('failure')
		}

		// Mark this socket inactive. Idempotent + keyed by the per-instance
		// connectionId: if the socket reached end() WITHOUT ever opening
		// (QR timeout, 515 before success, auth failure, ws close mid-
		// handshake), its id was never added, so this is a no-op and the
		// gauge can't drift negative. (fix: active-connections gauge drift)
		markConnectionInactive(connectionId)

		clearInterval(keepAliveReq)
		clearTimeout(qrTimer)

		// Clear offline-buffer safety timer so its callback cannot call ev.flush()
		// on an already-closed socket (e.g. auth failure or early network drop before
		// CB:ib,,offline ever arrives).  Mirrors how awaitingSyncTimeout is cleared in
		// chats.ts on connection close. (audit TST-06)
		offlineBuffer.onClose()

		// Stop session cleanup scheduler
		sessionCleanup.stop()

		// Stop session activity tracker and flush pending data
		await sessionActivityTracker.stop()

		// Clean up unified session manager
		unifiedSessionManager?.destroy()

		// CRITICAL: Wait for pending pre-key upload before destroying transaction capability
		// This prevents destroying resources while they're in use
		if (uploadPreKeysPromise) {
			logger.debug('Waiting for pending pre-key upload to complete before cleanup')
			try {
				await Promise.race([
					uploadPreKeysPromise,
					new Promise<void>(resolve => setTimeout(resolve, 5000)) // 5s timeout
				])
				logger.debug('Pending pre-key upload completed or timed out')
			} catch (error) {
				logger.warn({ error }, 'Pending pre-key upload failed during cleanup')
			}
		}

		// Closing the transport rejects every waitForMessage() through its
		// close listener. Without this step, a synthetic keep-alive disconnect
		// leaves pending app-state/USync queries waiting for their full timeout,
		// while teardown waits for those same handlers to drain.
		if (!ws.isClosed && !ws.isClosing) {
			try {
				await ws.close()
			} catch {}
		}

		await Promise.allSettled(drainPromises)
		socketDrainHandlers.length = 0

		// Drain Signal/LID work while the transaction capability and backing
		// auth store are still alive. Closing keys first caused history-sync
		// mapping batches to retry against an already-destroyed transaction
		// capability and permanently drop valid PN↔LID mappings.
		let signalRepositoryDrained = true
		try {
			const closeResult = await signalRepository.close?.()
			signalRepositoryDrained = closeResult !== false
		} catch (err) {
			signalRepositoryDrained = false
			logger.error({ err, connectionId }, 'error draining signal repository')
		}

		if (signalRepositoryDrained) {
			// Only after Signal/LID work is drained may the transaction
			// capability tear down its PreKeyManager and reject new work.
			await keys.destroy?.()
		} else {
			logger.warn({ connectionId }, 'deferring auth-key teardown until active Signal/LID operations have drained')
			const deferredDrain = signalRepository
				.waitForClose()
				.then(() => keys.destroy?.())
				.catch(err => logger.error({ err, connectionId }, 'error completing deferred auth-key teardown'))
			registerAuthStoreDrainBarrier(authState.keys, deferredDrain)
		}

		// Keep the raw message listener alive until the drain finishes: in-flight
		// IQ/USync requests may still need one final response while the socket is
		// usable. Removing it earlier can strand already-sent queries.
		ws.removeAllListeners('close')
		ws.removeAllListeners('open')
		ws.removeAllListeners('message')

		// Detect socket-level session errors that require recreation
		const isSessionError = statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.restartRequired

		if (restartRequired) {
			logger.info(
				{ statusCode, reason: DisconnectReason[statusCode], action: 'recreate-socket' },
				'pairing completed; restarting socket to continue with the authenticated session'
			)
		} else if (isSessionError) {
			logger.warn(
				{ statusCode, reason: DisconnectReason[statusCode] },
				'socket-level session error; consumer should recreate socket'
			)
		}

		// CRITICAL: Emit close event BEFORE cleaning up listeners
		// This allows handlers (PreKey auto-sync, Session TTL) to receive the final close event
		ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: {
				error,
				date: new Date()
			},
			isSessionError
		})

		// NOW clean up our internal listeners (after they've received the close event)
		cleanupPreKeyAutoSync()
		cleanupSessionTTL()

		for (const handler of socketEndHandlers) {
			try {
				await handler(error)
			} catch (err) {
				logger.error({ err }, 'error in socket end handler')
			}
		}

		// Release the handler closures themselves — each captures per-socket caches/timers, and we
		// deliberately keep the event emitter alive for reconnection, so anything the consumer still
		// references would otherwise pin all that captured scope.
		socketEndHandlers.length = 0

		// IMPORTANT: Do NOT use removeAllListeners('connection.update')
		// It would remove consumer listeners, breaking their reconnection logic
	}

	const waitForSocketOpen = async () => {
		if (closed) throw createExpectedSocketTeardownError()

		if (ws.isOpen) {
			return
		}

		if (ws.isClosed || ws.isClosing) {
			throw new Boom('Connection Closed', { statusCode: DisconnectReason.connectionClosed })
		}

		let onOpen: () => void
		let onClose: (err: Error) => void
		await new Promise((resolve, reject) => {
			onOpen = () => resolve(undefined)
			onClose = mapSocketLifecycleError(reject)
			ws.on('open', onOpen)
			ws.on('close', onClose)
			ws.on('error', onClose)
		}).finally(() => {
			ws.off('open', onOpen)
			ws.off('close', onClose)
			ws.off('error', onClose)
		})
	}

	const startKeepAliveRequest = () =>
		(keepAliveReq = setInterval(() => {
			if (!lastDateRecv) {
				lastDateRecv = new Date()
			}

			const diff = Date.now() - lastDateRecv.getTime()
			/*
				check if it's been a suspicious amount of time since the server responded with our last seen
				it could be that the network is down
			*/
			if (diff > keepAliveIntervalMs + 5000) {
				void end(new Boom('Connection was lost', { statusCode: DisconnectReason.connectionLost }))
			} else if (ws.isOpen) {
				// Send keep-alive ping via sendNode() (fire-and-forget) instead of query();
				// WA's ping response arrives as an incoming frame and updates lastDateRecv.
				sendNode({
					tag: 'iq',
					attrs: {
						id: generateMessageTag(),
						to: S_WHATSAPP_NET,
						type: 'get',
						xmlns: 'w:p'
					},
					content: [{ tag: 'ping', attrs: {} }]
				}).catch(err => {
					if (isExpectedSocketTeardownError(err)) {
						logger.debug('keep alive cancelled by socket teardown')
					} else {
						logger.error({ trace: err.stack }, 'error in sending keep alive')
					}
				})
			} else {
				logger.warn('keep alive called when WS not open')
			}
		}, keepAliveIntervalMs))
	/** i have no idea why this exists. pls enlighten me */
	const sendPassiveIq = (tag: 'passive' | 'active') =>
		query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				xmlns: 'passive',
				type: 'set'
			},
			content: [{ tag, attrs: {} }]
		})

	/** logout & invalidate connection */
	const logout = async (msg?: string) => {
		const jid = authState.creds.me?.id
		if (jid) {
			await sendNode({
				tag: 'iq',
				attrs: {
					to: S_WHATSAPP_NET,
					type: 'set',
					id: generateMessageTag(),
					xmlns: 'md'
				},
				content: [
					{
						tag: 'remove-companion-device',
						attrs: {
							jid,
							reason: 'user_initiated'
						}
					}
				]
			})
		}

		void end(new Boom(msg || 'Intentional Logout', { statusCode: DisconnectReason.loggedOut }))
	}

	const requestPairingCode = async (phoneNumber: string, customPairingCode?: string): Promise<string> => {
		if (isNativeAndroid) {
			throw new Boom(
				'native_android uses the official QR companion flow; phone-number pair code remains available only on the Web transport',
				{ statusCode: 400 }
			)
		}

		const pairingCode = customPairingCode ?? bytesToCrockford(randomBytes(5))

		if (customPairingCode && customPairingCode?.length !== 8) {
			throw new Error('Custom pairing code must be exactly 8 chars')
		}

		authState.creds.pairingCode = pairingCode

		authState.creds.me = {
			id: jidEncode(phoneNumber, 's.whatsapp.net'),
			name: '~'
		}

		// Pair code companion_platform_id must be Chrome (1) when using Android
		// browser preset. ANDROID_PHONE (16) causes silent timeout (server ignores),
		// UWP (21) causes "cannot connect device" rejection. Only Chrome (1) works
		// for pair code via web protocol (WA\x06\x03). The device still appears as
		// "Android" in linked devices because DeviceProps.platformType=ANDROID_PHONE
		// is set separately in the registration node.
		const isAndroid = isAndroidBrowser(browser)
		const pairPlatformId = isAndroid ? getPlatformId('Chrome') : getPlatformId(browser[1])
		const pairPlatformDisplay = isAndroid ? 'Chrome (Mac OS)' : `${browser[1]} (${browser[0]})`

		logger.info(
			{
				pairCode: pairingCode,
				jid: authState.creds.me.id,
				companionPlatformId: pairPlatformId,
				companionPlatformDisplay: pairPlatformDisplay,
				isAndroid
			},
			`pair code requested | companion: ${pairPlatformDisplay} | ${isAndroid ? 'android override -> Chrome' : 'native platform'}`
		)

		ev.emit('creds.update', authState.creds)
		await sendNode({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				id: generateMessageTag(),
				xmlns: 'md'
			},
			content: [
				{
					tag: 'link_code_companion_reg',
					attrs: {
						jid: authState.creds.me.id,
						stage: 'companion_hello',

						should_show_push_notification: 'true'
					},
					content: [
						{
							tag: 'link_code_pairing_wrapped_companion_ephemeral_pub',
							attrs: {},
							content: await generatePairingKey()
						},
						{
							tag: 'companion_server_auth_key_pub',
							attrs: {},
							content: authState.creds.noiseKey.public
						},
						{
							tag: 'companion_platform_id',
							attrs: {},
							content: pairPlatformId
						},
						{
							tag: 'companion_platform_display',
							attrs: {},
							content: pairPlatformDisplay
						},
						{
							tag: 'link_code_pairing_nonce',
							attrs: {},
							content: '0'
						}
					]
				}
			]
		})
		return authState.creds.pairingCode
	}

	async function generatePairingKey() {
		const salt = randomBytes(32)
		const randomIv = randomBytes(16)
		if (!authState.creds.pairingCode) {
			throw new Error('Pairing code not set')
		}

		const key = await derivePairingCodeKey(authState.creds.pairingCode, salt)
		const ciphered = aesEncryptCTR(authState.creds.pairingEphemeralKeyPair.public, key, randomIv)
		return Buffer.concat([salt, randomIv, ciphered])
	}

	const sendWAMBuffer = (wamBuffer: Buffer) => {
		return query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				id: generateMessageTag(),
				xmlns: 'w:stats'
			},
			content: [
				{
					tag: 'add',
					attrs: { t: Math.round(Date.now() / 1000) + '' },
					content: wamBuffer
				}
			]
		})
	}

	ws.on('message', onMessageReceived)

	ws.on('open', async () => {
		try {
			await validateConnection()
		} catch (err: any) {
			logger.error({ err }, 'error in validating connection')
			void end(err)
		}
	})
	ws.on('error', mapWebSocketError(end))
	ws.on('close', () => void end(new Boom('Connection Terminated', { statusCode: DisconnectReason.connectionClosed })))
	// the server terminated the connection
	ws.on(
		'CB:xmlstreamend',
		() => void end(new Boom('Connection Terminated by Server', { statusCode: DisconnectReason.connectionClosed }))
	)
	// QR gen
	ws.on('CB:iq,type:set,pair-device', async (stanza: BinaryNode) => {
		const iq: BinaryNode = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'result',
				id: stanza.attrs.id!
			}
		}
		await sendNode(iq)

		const pairDeviceNode = getBinaryNodeChild(stanza, 'pair-device')
		const refNodes = getBinaryNodeChildren(pairDeviceNode, 'ref')
		const noiseKeyB64 = Buffer.from(creds.noiseKey.public).toString('base64')
		const identityKeyB64 = Buffer.from(creds.signedIdentityKey.public).toString('base64')
		const advB64 = creds.advSecretKey

		let qrMs = qrTimeout || 60_000 // time to let a QR live
		const genPairQR = () => {
			if (!ws.isOpen) {
				return
			}

			const refNode = refNodes.shift()
			if (!refNode) {
				void end(new Boom('QR refs attempts ended', { statusCode: DisconnectReason.timedOut }))
				return
			}

			const ref = (refNode.content as Buffer).toString('utf-8')
			const qr = buildPairingQRData(ref, noiseKeyB64, identityKeyB64, advB64, browser, transportSession.profile)

			ev.emit('connection.update', { qr })

			qrTimer = setTimeout(genPairQR, qrMs)
			qrMs = qrTimeout || 20_000 // shorter subsequent qrs
		}

		genPairQR()
	})
	// device paired for the first time
	// if device pairs successfully, the server asks to restart the connection
	ws.on('CB:iq,,pair-success', async (stanza: BinaryNode) => {
		logger.debug('pair success recv')
		try {
			const { reply, creds: updatedCreds } = configureSuccessfulPairing(stanza, creds)
			if (isNativeAndroid) {
				const appResolution = resolveNativeAndroidPairingAppVariant(
					transportSession.nativeAndroid!,
					creds,
					updatedCreds.platform
				)
				if (appResolution.fallbackApplied) {
					logger.warn(
						{
							pairingPlatform: updatedCreds.platform,
							appVariant: appResolution.variant,
							packageName: appResolution.identity.packageName,
							selectedProfileId: transportSession.nativeAndroid!.device.profileId
						},
						'native_android: QR account type changed the pre-pair application identity'
					)
				} else {
					logger.info(
						{
							pairingPlatform: updatedCreds.platform,
							appVariant: appResolution.variant,
							packageName: appResolution.identity.packageName
						},
						'native_android: QR account type validated'
					)
				}

				const provider = transportSession.nativeAndroid!.attestationProvider
				if (!provider) {
					throw new Boom('native_android: pairing attestation provider was not initialized', {
						statusCode: DisconnectReason.badSession
					})
				}

				const attestation = await provider({
					stanza,
					profileId: transportSession.nativeAndroid!.device.profileId,
					appVariant: appResolution.variant,
					clientAppId: appResolution.identity.clientAppId,
					packageName: appResolution.identity.packageName
				})
				appendNativeAndroidPairingAttestation(reply, attestation, appResolution.identity.clientAppId)

				// QR pair-success is the authoritative transition from a fresh
				// native identity to a registered companion. Persist it together
				// with account/me so reconnects cannot rotate the device profile.
				updatedCreds.registered = true
				updatedCreds.nativeAndroidIdentity = authState.creds.nativeAndroidIdentity
			}

			logger.info(
				{ me: updatedCreds.me, platform: updatedCreds.platform },
				'pairing configured successfully, expect to restart the connection...'
			)

			ev.emit('creds.update', updatedCreds)
			ev.emit('connection.update', { isNewLogin: true, qr: undefined })

			await sendNode(reply)

			// Send unified_session telemetry on successful pairing
			sendUnifiedSession('pairing').catch(err => {
				logger.debug({ err }, 'Failed to send unified_session on pairing')
			})
		} catch (error: any) {
			logger.info({ trace: error.stack }, 'error in pairing')
			void end(error)
		}
	})
	// login complete
	ws.on('CB:success', async (node: BinaryNode) => {
		const isAndroid = isNativeAndroid || isAndroidBrowser(browser)
		const phoneId = authState.creds.me?.id?.split(':')[0]?.split('@')[0] || 'new session'
		const nativeAppPlatform = transportSession.nativeAndroid?.appVariant === 'consumer' ? 'ANDROID' : 'SMB_ANDROID'
		logger.info(
			`${isAndroid ? '\uD83D\uDCF1' : '\uD83D\uDDA5\uFE0F'} Connected to WA | ${phoneId} | platform: ${isAndroid ? nativeAppPlatform : 'MACOS'} | device: ${isAndroid ? 'Android' : 'Desktop'} | platformType: ${isAndroid ? 'ANDROID_PHONE' : 'CHROME'}`
		)
		clearTimeout(qrTimer) // will never happen in all likelyhood -- but just in case WA sends success on first try

		ev.emit('creds.update', { me: { ...authState.creds.me!, lid: node.attrs.lid } })

		if (isNativeAndroid && authState.creds.nativeAndroidIdentity && nativeClientPayloadContext) {
			const connectionLc = incrementNativeAndroidConnectionLc(nativeClientPayloadContext.connectionLc)
			authState.creds.nativeAndroidIdentity.connectionLc = connectionLc
			ev.emit('creds.update', { nativeAndroidIdentity: authState.creds.nativeAndroidIdentity })
			logger.debug(
				{
					transportProfile: transportSession.profile,
					selectedProfileId: transportSession.nativeAndroid?.device.profileId,
					connectionLc
				},
				'native_android: successful-login counter advanced after server success'
			)
		}

		// Mark this socket active BEFORE emitting `connection.update`. That
		// emit is NOT buffered (connection.update is absent from
		// BUFFERABLE_EVENT in event-buffer.ts), so it runs application
		// listeners SYNCHRONOUSLY. If a listener reacts to `open` by calling
		// end() synchronously (e.g. decides to drop the session on connect),
		// its markConnectionInactive must find this id already present to
		// delete it — otherwise the delete is a no-op and the subsequent
		// markConnectionActive would add an already-closed socket, leaking an
		// orphan +1 forever (the inverse of the orphan-dec drift this whole
		// change fixes). Ordering active→emit→(optional inactive) keeps the
		// final gauge correct in both branches. (audit PR #589: Codex)
		markConnectionActive(connectionId)

		// Emit connection:open immediately so the application layer begins processing
		// incoming messages without waiting for any WA round-trips.
		ev.emit('connection.update', { connection: 'open' })

		// ─── Background: sendPassiveIq + pre-key validation + key-bundle digest ──
		// sendPassiveIq('active') tells the WA edge server to start routing live
		// messages to this connection. All three operations involve WA round-trips
		// (100–500 ms each) but none need to complete before the app can handle
		// messages. Run them in parallel, fire-and-forget, non-blocking.
		Promise.allSettled([sendPassiveIq('active'), uploadPreKeysToServerIfRequired(), digestKeyBundle()])
			.then(results => {
				const [passiveResult] = results
				if (passiveResult.status === 'rejected') {
					logger.warn({ err: passiveResult.reason }, 'failed to send initial passive iq')
				}

				for (const result of results.slice(1)) {
					if (result.status === 'rejected') {
						logger.warn({ err: result.reason }, 'background key operation failed after login (non-critical)')
					}
				}
			})
			.catch(err => {
				logger.error({ err }, 'unexpected error in background post-login handler')
			})

		// Record successful connection metrics (markConnectionActive was
		// already called above, before the synchronous open emit).
		recordConnectionAttempt('success')

		// Defer session cleanup start by 5 s to avoid DB contention during the
		// initial message flood right after CB:success. The heavyweight
		// getAllSessionKeys() scan would otherwise compete with migrateSession()
		// for the same storage locks while the offline-message backlog is draining.
		// start() is idempotent (guarded by cleanupInterval check) so deferring is safe.
		const _cleanupStartTimer = setTimeout(() => sessionCleanup.start(), 5_000)
		if (typeof _cleanupStartTimer.unref === 'function') {
			_cleanupStartTimer.unref()
		}

		// Start session activity tracker immediately (lightweight, no DB scan)
		sessionActivityTracker.start()

		// Update server time offset from success node
		const serverTime = extractServerTime(node)
		if (serverTime) {
			unifiedSessionManager?.updateServerTimeOffset(serverTime)
		}

		// Send unified_session telemetry on successful login
		sendUnifiedSession('login').catch(err => {
			logger.debug({ err }, 'Failed to send unified_session on login')
		})

		if (node.attrs.lid && authState.creds.me?.id) {
			const myLID = node.attrs.lid
			process.nextTick(async () => {
				try {
					const myPN = authState.creds.me!.id

					// Store our own LID-PN mapping
					await signalRepository.lidMapping.storeLIDPNMappings([{ lid: myLID, pn: myPN }])

					// Create device list for our own user (needed for bulk migration)
					const { user, device } = jidDecode(myPN)!
					await authState.keys.set({
						'device-list': {
							[user]: [device?.toString() || '0']
						}
					})

					// migrate our own session
					await signalRepository.migrateSession(myPN, myLID)

					logger.info({ myPN, myLID }, 'Own LID session created successfully')
				} catch (error) {
					logger.error({ error, lid: myLID }, 'Failed to create own LID session')
				}
			})
		}
	})

	ws.on('CB:stream:error', (node: BinaryNode) => {
		const [reasonNode] = getAllBinaryNodeChildren(node)
		const { reason, statusCode } = getErrorCodeFromStreamError(node)

		if (reason === 'device_removed') {
			logger.error({ node }, 'stream error: device removed — logging out')
		} else if (reason === 'xml-not-well-formed') {
			logger.warn({ node }, 'stream error: sent malformed stanza (xml-not-well-formed)')
		} else if (reason === 'ack') {
			logger.warn({ ackId: reasonNode?.attrs?.id, node }, 'stream error: ack-based error')
		} else if (statusCode === DisconnectReason.restartRequired) {
			logger.debug({ reason, statusCode, action: 'recreate-socket' }, 'stream restart required after pairing')
		} else {
			logger.error({ reason, statusCode, node }, 'stream errored out')
		}

		void end(new Boom(`Stream Errored (${reason})`, { statusCode, data: reasonNode || node }))
	})
	// stream fail, possible logout
	ws.on('CB:failure', (node: BinaryNode) => {
		const reason = +(node.attrs.reason || 500)
		const currentNativeDevice = transportSession.nativeAndroid?.device
		if (
			isNativeAndroid &&
			currentNativeDevice &&
			shouldFallbackNativeAndroidProfile({
				registered: authState.creds.registered,
				hasAccount: Boolean(authState.creds.account),
				hasMe: Boolean(authState.creds.me),
				serverFailureReason: reason,
				profileId: currentNativeDevice.profileId
			})
		) {
			const fallback = createNativeAndroidFallbackDeviceProfile({
				mcc: currentNativeDevice.mcc,
				mnc: currentNativeDevice.mnc,
				localeLanguageIso6391: currentNativeDevice.localeLanguageIso6391,
				localeCountryIso31661Alpha2: currentNativeDevice.localeCountryIso31661Alpha2
			})
			authState.creds.nativeAndroidIdentity = {
				...authState.creds.nativeAndroidIdentity,
				schemaVersion: 1,
				profile: 'native_android',
				device: fallback
			}
			transportSession.nativeAndroid!.device = fallback
			ev.emit('creds.update', { nativeAndroidIdentity: authState.creds.nativeAndroidIdentity })
			logger.warn(
				{
					rejectedProfileId: currentNativeDevice.profileId,
					selectedProfileId: fallback.profileId,
					serverFailureReason: reason,
					fallbackAction: 'persisted-for-next-fresh-pairing'
				},
				'native_android catalog profile rejected before registration; generic captured profile selected as fallback'
			)
		}

		void end(new Boom('Connection Failure', { statusCode: reason, data: node.attrs }))
	})

	ws.on('CB:ib,,downgrade_webclient', () => {
		void end(new Boom('Multi-device beta not joined', { statusCode: DisconnectReason.multideviceMismatch }))
	})

	ws.on('CB:ib,,offline_preview', async (node: BinaryNode) => {
		logger.info('offline preview received', JSON.stringify(node))
		await sendNode({
			tag: 'ib',
			attrs: {},
			content: [{ tag: 'offline_batch', attrs: { count: '100' } }]
		})
	})

	ws.on('CB:ib,,edge_routing', (node: BinaryNode) => {
		const edgeRoutingNode = getBinaryNodeChild(node, 'edge_routing')
		const routingInfo = getBinaryNodeChild(edgeRoutingNode, 'routing_info')
		if (routingInfo?.content) {
			authState.creds.routingInfo = Buffer.from(routingInfo?.content as Uint8Array)
			ev.emit('creds.update', authState.creds)
		}
	})

	// perf(inbound-latency): safety timer that caps how long the offline-phase buffer may
	// block live message delivery. The server sends CB:ib,,offline only after transmitting
	// ALL queued offline messages; on busy accounts this can take 10-30+ seconds, holding
	// every buffered event hostage. This timer fires after OFFLINE_BUFFER_TIMEOUT_MS and
	// force-flushes so live messages are never delayed beyond that cap.
	// CB:ib,,offline clears the timer when it fires normally (fast path).
	//
	// INTENTIONALLY hardcoded — not controlled by BAILEYS_BUFFER_TIMEOUT_MS or any other
	// env var. BAILEYS_BUFFER_TIMEOUT_MS governs general-purpose buffer batching (for
	// Prometheus / history consolidation) and is typically set to 5-30 s by operators.
	// This constant must remain short regardless so that a large offline backlog cannot
	// hold live incoming messages hostage for minutes.
	// When clearRoutingInfoOnStart cleared a stale routingInfo, this is a restart of an
	// already-authenticated session (no QR re-scan needed). In this case we skip
	// the offline buffer entirely so live messages are not held hostage waiting for the
	// server to finish flushing the pending-message backlog (CB:ib,,offline).
	// For normal restarts (no stale routingInfo) the standard 2 s safety cap applies.
	const OFFLINE_BUFFER_TIMEOUT_MS = 2_000
	// State machine lives in `./offline-buffer-state` so it can be unit
	// tested directly without spinning up a socket. (audit TST-06)
	const offlineBuffer = createOfflineBufferState(
		() => ev.flush(),
		() =>
			logger.warn(
				{ timeoutMs: OFFLINE_BUFFER_TIMEOUT_MS },
				'perf: offline-buffer safety timeout reached, force-flushing before CB:ib,,offline'
			),
		OFFLINE_BUFFER_TIMEOUT_MS
	)

	process.nextTick(() => {
		if (creds.me?.id && !skipOfflineBuffer) {
			// First-time QR connection: buffer events until CB:ib,,offline signals all
			// offline messages have been delivered, then flush everything at once.
			ev.buffer()
			offlineBuffer.startBuffer()
		} else if (creds.me?.id && skipOfflineBuffer) {
			logger.info(
				'perf: skipping offline-phase buffer — reconnect of existing session, messages will be delivered immediately'
			)
		}

		ev.emit('connection.update', { connection: 'connecting', receivedPendingNotifications: false, qr: undefined })
	})

	// called when all offline notifs are handled
	ws.on('CB:ib,,offline', (node: BinaryNode) => {
		const child = getBinaryNodeChild(node, 'offline')
		const offlineNotifs = +(child?.attrs.count || 0)

		logger.info(`handled ${offlineNotifs} offline messages/notifications`)

		const wasBuffering = offlineBuffer.getState().didStartBuffer
		offlineBuffer.onOffline()
		if (wasBuffering) logger.trace('flushed events for initial buffer')

		ev.emit('connection.update', { receivedPendingNotifications: true })
	})

	// Network announcement state belongs to this socket, not to durable
	// credentials. A replacement socket starts undefined and announces the
	// persisted name again when CB:success emits its creds update.
	const pushNameAnnouncement = createPushNameAnnouncementTracker()

	// update credentials when required
	ev.on('creds.update', update => {
		// Persist first. Presence is a best-effort network announcement and
		// must never roll back server-provided credential state.
		Object.assign(creds, update)
		// Updates are frequently partial. Read the persisted name after the
		// merge so a failed announcement can retry on the next credentials
		// update even when that update does not include `me`.
		const name = getPushNameForAnnouncement(creds)

		if (typeof name === 'string' && pushNameAnnouncement.needsAnnouncement(name)) {
			if (!closed && ws.isOpen) {
				pushNameAnnouncement.markStarted(name)
				sendNode({
					tag: 'presence',
					attrs: { name }
				})
					.then(() => logger.debug('push name persisted and presence announcement sent'))
					.catch(err => {
						pushNameAnnouncement.markFailed(name)

						if (isExpectedSocketTeardownError(err)) {
							logger.debug(
								{ action: 'retry-on-next-socket' },
								'push name persisted; presence announcement cancelled because the socket is closing'
							)
						} else {
							logger.warn(
								{
									error: err instanceof Error ? err.message : 'unknown presence-send failure',
									action: 'retry-on-next-credentials-update'
								},
								'push name persisted, but presence announcement failed; the credential was not rolled back'
							)
						}
					})
			} else {
				logger.debug(
					{ action: 'announce-on-next-socket' },
					'push name persisted; presence announcement deferred because the socket is not active'
				)
			}
		}
	})

	/**
	 * Fetches your account's standing when it comes to restrictions.
	 * Port de upstream `4dbbba2891` (PR #2442).
	 *
	 * @param emitUpdate — quando `true` (default), emite `connection.update`
	 *   com o `ReachoutTimelockState` resultante. Quando `false`, apenas
	 *   retorna — usado pelo caminho fire-and-forget no handler de 463 pra
	 *   evitar double-emit com o push notification `NotificationUser-
	 *   ReachoutTimelockUpdate` que chega em paralelo (audit SEC #475 RACE-01).
	 * @returns Returns the state of the restrictions.
	 */
	const fetchAccountReachoutTimelock = async (emitUpdate = true): Promise<ReachoutTimelockState> => {
		// 10s timeout — fire-and-forget chamadores não podem ficar com
		// promise pendente indefinida em caso de socket instável (audit
		// ROBUST-01).
		const queryResult = await promiseTimeout<{
			is_active?: boolean
			time_enforcement_ends?: string
			enforcement_type: ReachoutTimelockEnforcementType
		}>(10_000, (resolve, reject) =>
			executeWMexQuery<{
				is_active?: boolean
				time_enforcement_ends?: string
				enforcement_type: ReachoutTimelockEnforcementType
			}>({}, QueryIds.REACHOUT_TIMELOCK, XWAPaths.xwa2_fetch_account_reachout_timelock, query, generateMessageTag)
				.then(resolve)
				.catch(reject)
		)
		// NaN guard — servidor pode mandar "abc", "0", "1abc"; sem proteção
		// caímos em `Invalid Date` ou `new Date(0)` (audit SEC-01).
		const tsRaw = queryResult?.time_enforcement_ends
		const tsParsed = tsRaw && tsRaw !== '0' ? parseInt(tsRaw, 10) : NaN
		const result: ReachoutTimelockState = {
			// Omission is not proof that the restriction was removed. Preserve
			// the tri-state contract consumed by the fail-closed remediation.
			isActive: typeof queryResult?.is_active === 'boolean' ? queryResult.is_active : undefined,
			timeEnforcementEnds: Number.isFinite(tsParsed) && tsParsed > 0 ? new Date(tsParsed * 1000) : undefined,
			enforcementType: queryResult?.enforcement_type ?? ReachoutTimelockEnforcementType.DEFAULT
		}
		if (emitUpdate) {
			ev.emit('connection.update', { reachoutTimeLock: result })
		}

		return result
	}

	const reachoutTimelockRemediation = makeReachoutTimelockRemediation({
		config: experimentalReachoutTimelockRemediation,
		fetchState: fetchAccountReachoutTimelock,
		removeOnServer: variables =>
			executeWMexQuery<RemoveReachoutTimelockServerResult>(
				variables,
				QueryIds.REMOVE_REACHOUT_TIMELOCK,
				XWAPaths.xwa2_remove_account_reachout_timelock,
				query,
				generateMessageTag
			),
		callerTimeoutMs: 10_000,
		log: (level, details, message) => logger[level](details, message)
	})

	/**
	 * Fetches your account's new chat limits.
	 * Port de upstream `4dbbba2891` (PR #2442).
	 * @returns Returns the quota and the usage.
	 */
	const fetchNewChatMessageCap = async (): Promise<NewChatMessageCapInfo> => {
		return executeWMexQuery<NewChatMessageCapInfo>(
			{ input: { type: 'INDIVIDUAL_NEW_CHAT_MSG' } },
			QueryIds.MESSAGE_CAPPING_INFO,
			XWAPaths.xwa2_message_capping_info,
			query,
			generateMessageTag
		)
	}

	return {
		type: 'md' as 'md',
		ws,
		ev,
		authState: { creds, keys },
		signalRepository,
		sessionCleanup,
		sessionActivityTracker,
		get user() {
			return authState.creds.me
		},
		generateMessageTag,
		query,
		waitForMessage,
		waitForSocketOpen,
		sendRawMessage,
		sendNode,
		logout,
		end,
		registerSocketEndHandler,
		registerSocketDrainHandler,
		// Internal lifecycle probe used by receive-path guards. It is exposed on
		// the composed socket object for local modules, not as a consumer API.
		isSocketClosed: () => closed,
		onUnexpectedError,
		uploadPreKeys,
		uploadPreKeysToServerIfRequired,
		digestKeyBundle,
		rotateSignedPreKey,
		requestPairingCode,
		wamBuffer: publicWAMBuffer,
		/** Waits for the connection to WA to reach a state */
		waitForConnectionUpdate: bindWaitForConnectionUpdate(ev),
		sendWAMBuffer,
		executeUSyncQuery,
		onWhatsApp,
		// Port de upstream `4dbbba2891` (PR #2442) — reachout timelock + new chat message cap
		fetchAccountReachoutTimelock,
		/** Returns fresh server eligibility plus the official video URL, without mutating state. */
		getReachoutTimelockRemediationEligibility: reachoutTimelockRemediation.getEligibility,
		/** Explicitly attempts the opt-in BIZ_QUALITY remediation and verifies the server state afterwards. */
		removeAccountReachoutTimelock: reachoutTimelockRemediation.remove,
		fetchNewChatMessageCap,
		// Unified Session Telemetry
		/** Send unified_session telemetry manually */
		sendUnifiedSession,
		/** Get unified session manager state (for debugging) */
		getUnifiedSessionState: () => unifiedSessionManager?.getState(),
		/** Update server time offset (call when receiving server timestamps) */
		updateServerTimeOffset: (serverTime: string | number) => {
			unifiedSessionManager?.updateServerTimeOffset(serverTime)
		},
		/**
		 * Whether the offline-phase buffer was skipped for this connection.
		 * true  → this is a reconnect of an existing session (skip all sync waits in chats.ts too)
		 * false → fresh QR-scan or first connection (normal sync flow applies)
		 */
		skipOfflineBuffer
	}
}

/**
 * map the websocket error to the right type
 * so it can be retried by the caller
 * */
function mapWebSocketError(handler: (err: Error) => void) {
	return (error: Error) => {
		handler(new Boom(`WebSocket Error (${error?.message})`, { statusCode: getCodeFromWSError(error), data: error }))
	}
}
