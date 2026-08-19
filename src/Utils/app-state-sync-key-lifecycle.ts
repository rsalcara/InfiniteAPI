import { proto } from '../../WAProto/index.js'
import type { AppStateSyncKeyStore, SignalKeyStoreWithTransaction, StoredAppStateSyncPeerMessage } from '../Types'
import { APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE, APP_STATE_SYNC_KEY_SHARE_MESSAGE_TYPE } from '../Types/AppStateSync'
import { areJidsSameUser, jidDecode } from '../WABinary'
import { parseAppStateSyncKeyId } from './app-state-sync-key-store'
import type { ILogger } from './logger'
import { makeMutex } from './make-mutex'

const REQUEST_RETRY_DELAY_MS = 1_000

type LifecycleDependencies = {
	store: AppStateSyncKeyStore
	keyStore: SignalKeyStoreWithTransaction
	logger: ILogger
	getOwnJid: () => string
	getOwnLid: () => string | undefined
	getActiveKeyId: () => string | undefined
	listOwnDevices: () => Promise<string[]>
	sendPeerMessage: (targetDeviceJid: string, message: proto.IMessage, messageId: string) => Promise<void>
	retryCollections: (collections: string[]) => Promise<void>
	generateMessageId: () => string
	retryDelayMs?: number
}

type RequestData = { 'key-ids': string[] }

const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort()
const setsEqual = (left: string[], right: string[]): boolean => {
	const a = uniqueSorted(left)
	const b = uniqueSorted(right)
	return a.length === b.length && a.every((value, index) => value === b[index])
}

const sameDeviceNumber = (left: string, right: string): boolean => {
	const a = jidDecode(left)
	const b = jidDecode(right)
	return Boolean(a && b && (a.device ?? 0) === (b.device ?? 0))
}

const isNewerKeyId = (candidate: string, current: string | undefined): boolean => {
	if (!current) return true

	const next = parseAppStateSyncKeyId(candidate)
	const active = parseAppStateSyncKeyId(current)
	return next.epoch > active.epoch || (next.epoch === active.epoch && next.deviceId < active.deviceId)
}

const rawKeyId = (keyId: proto.Message.IAppStateSyncKeyId): string | null => {
	if (!keyId.keyId) return null
	const encoded = Buffer.from(keyId.keyId).toString('base64')
	parseAppStateSyncKeyId(encoded)
	return encoded
}

export const encodeAppStateSyncKeyRequestData = (keyIds: string[]): string =>
	JSON.stringify({
		'key-ids': uniqueSorted(keyIds).map(keyId =>
			Buffer.from(proto.Message.AppStateSyncKeyId.encode({ keyId: Buffer.from(keyId, 'base64') }).finish()).toString(
				'base64'
			)
		)
	} satisfies RequestData)

export const decodeAppStateSyncKeyRequestData = (data: string): string[] => {
	const parsed = JSON.parse(data) as Partial<RequestData>
	if (!Array.isArray(parsed['key-ids'])) throw new Error('invalid syncd-key-request peer message data')
	return uniqueSorted(
		parsed['key-ids'].map(encoded => {
			const keyId = proto.Message.AppStateSyncKeyId.decode(Buffer.from(encoded, 'base64'))
			const value = rawKeyId(keyId)
			if (!value) throw new Error('syncd-key-request contains an empty key id')
			return value
		})
	)
}

const encodeShareData = (share: proto.Message.IAppStateSyncKeyShare): string =>
	JSON.stringify({
		appStateSyncKeyShareProtoString: Buffer.from(proto.Message.AppStateSyncKeyShare.encode(share).finish()).toString(
			'base64'
		),
		isNewlyGeneratedKey: false
	})

const decodeShareData = (data: string): proto.Message.IAppStateSyncKeyShare => {
	const parsed = JSON.parse(data) as { appStateSyncKeyShareProtoString?: unknown }
	if (typeof parsed.appStateSyncKeyShareProtoString !== 'string') {
		throw new Error('invalid syncd-key-share peer message data')
	}

	return proto.Message.AppStateSyncKeyShare.decode(Buffer.from(parsed.appStateSyncKeyShareProtoString, 'base64'))
}

const validateKeyData = (keyData: proto.Message.IAppStateSyncKeyData): void => {
	if (keyData.keyData?.length !== 32) throw new Error('invalid app-state sync key data')
	if (keyData.timestamp === null || keyData.timestamp === undefined)
		throw new Error('missing app-state sync key timestamp')
	if (!keyData.fingerprint) throw new Error('missing app-state sync key fingerprint')
	if (keyData.fingerprint.rawId === null || keyData.fingerprint.rawId === undefined) {
		throw new Error('missing app-state sync key fingerprint rawId')
	}

	if (keyData.fingerprint.currentIndex === null || keyData.fingerprint.currentIndex === undefined) {
		throw new Error('missing app-state sync key fingerprint currentIndex')
	}
}

export class AppStateSyncKeyLifecycle {
	private readonly mutex = makeMutex()
	private drainPromise: Promise<void> | undefined
	private drainRequested = false
	private retryTimer: NodeJS.Timeout | undefined
	private recoveryTimer: NodeJS.Timeout | undefined
	private retryAttempt = 0
	private recoveryAttempt = 0
	private stopped = true

	constructor(private readonly deps: LifecycleDependencies) {}

	async startRecovery(): Promise<void> {
		this.stopped = false
		try {
			const missing = await this.deps.store.listMissingKeyIds()
			if (missing.length) {
				const existing = await this.deps.keyStore.get('app-state-sync-key', missing)
				const recovered = missing.filter(keyId => Boolean(existing[keyId]))
				if (recovered.length) {
					const ready = await this.deps.store.resolveKeys(recovered)
					if (ready.length) await this.deps.retryCollections(ready)
				}
			}

			await this.runRecovery()
		} catch (error) {
			this.scheduleRecoveryRetry()
			throw error
		}
	}

	/** Runs persisted request creation and delivery now; safe to call repeatedly. */
	async runRecovery(): Promise<void> {
		if (this.stopped) return
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.recoveryTimer = undefined
		this.retryTimer = undefined
		try {
			await this.ensureRequestsForMissingKeys()
			this.recoveryAttempt = 0
		} catch (error) {
			this.scheduleRecoveryRetry()
			throw error
		}

		await this.drain()
	}

	stop(): void {
		this.stopped = true
		if (this.retryTimer) clearTimeout(this.retryTimer)
		if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
		this.retryTimer = undefined
		this.recoveryTimer = undefined
	}

	async requestMissingKey(collectionName: string, keyId: string): Promise<void> {
		parseAppStateSyncKeyId(keyId)
		await this.deps.store.recordMissingKey(keyId, collectionName)

		// resyncAppState runs inside the auth-key transaction. The official job
		// queue persists the peer row and only sends after that transaction can
		// commit; doing a USync/IQ and Signal encryption inline would hold the
		// same transaction across network I/O. A restart will recover from the
		// durable missing_keys row even if this timer has not fired yet.
		if (!this.stopped && !this.recoveryTimer) {
			this.recoveryTimer = setTimeout(() => {
				this.recoveryTimer = undefined
				this.runRecovery().catch(error =>
					this.deps.logger.error({ error }, 'app-state sync key recovery scheduling failed')
				)
			}, 0)
		}
	}

	private async ensureRequestsForMissingKeys(): Promise<void> {
		await this.mutex.mutex(async () => {
			const missing = await this.deps.store.listMissingKeyIds()
			if (!missing.length) return
			const requests = await this.deps.store.listPeerMessages(APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE)
			const devices = uniqueSorted(await this.deps.listOwnDevices())
			if (!devices.length) {
				const requested = new Set(requests.flatMap(row => decodeAppStateSyncKeyRequestData(row.data)))
				const unrequested = missing.filter(keyId => !requested.has(keyId))
				// Existing rows can still receive a late response. They must not,
				// however, hide a different key that has never been requested.
				if (!unrequested.length) return
				const snapshot = await this.deps.store.exportState()
				const collections = [
					...new Set(snapshot.missingKeys.filter(row => unrequested.includes(row.keyId)).map(row => row.collectionName))
				].sort()
				this.deps.logger.error(
					{
						collections,
						keyIds: unrequested,
						state: 'MissingKeyOnAllClients'
					},
					'app-state sync key is missing on every registered client'
				)
				return
			}

			const persisted: Array<{ targetDeviceJid: string; keyIds: string[] }> = []
			for (const targetDeviceJid of devices) {
				const alreadyRequested = new Set(
					requests
						.filter(row => sameDeviceNumber(row.targetDeviceJid, targetDeviceJid))
						.flatMap(row => decodeAppStateSyncKeyRequestData(row.data))
				)
				const newMissing = missing.filter(keyId => !alreadyRequested.has(keyId))
				if (!newMissing.length) continue
				await this.deps.store.enqueuePeerMessage({
					messageType: APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE,
					remoteJid: this.deps.getOwnJid(),
					targetDeviceJid,
					messageId: this.deps.generateMessageId(),
					timestamp: Date.now(),
					data: encodeAppStateSyncKeyRequestData(newMissing)
				})
				persisted.push({ targetDeviceJid, keyIds: newMissing })
			}

			if (persisted.length) {
				this.deps.logger.info({ requests: persisted }, 'app-state sync missing-key requests persisted')
			}
		})
	}

	private async isKnownOwnDevice(senderJid: string, acceptRequestedTarget = false): Promise<boolean> {
		const decoded = jidDecode(senderJid)
		if (!decoded) return false
		const ownJid = this.deps.getOwnJid()
		const ownLid = this.deps.getOwnLid()
		if (!areJidsSameUser(senderJid, ownJid) && (!ownLid || !areJidsSameUser(senderJid, ownLid))) return false
		if (acceptRequestedTarget) {
			const requests = await this.deps.store.listPeerMessages(APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE)
			if (requests.some(row => sameDeviceNumber(row.targetDeviceJid, senderJid))) return true
		}

		return (await this.deps.listOwnDevices()).some(device => sameDeviceNumber(device, senderJid))
	}

	async handleKeyRequest(senderJid: string, request: proto.Message.IAppStateSyncKeyRequest): Promise<void> {
		if (!(await this.isKnownOwnDevice(senderJid))) {
			this.deps.logger.warn({ senderJid }, 'dropping app-state sync key request from unknown device')
			return
		}

		const keyIds = uniqueSorted(
			(request.keyIds ?? []).map(key => {
				const value = rawKeyId(key)
				if (!value) throw new Error('app-state sync key request contains an empty key id')
				return value
			})
		)
		if (!keyIds.length) return
		const known = await this.deps.keyStore.get('app-state-sync-key', keyIds)
		const share: proto.Message.IAppStateSyncKeyShare = {
			keys: keyIds.map(keyId => ({
				keyId: { keyId: Buffer.from(keyId, 'base64') },
				keyData: known[keyId]
			}))
		}

		await this.mutex.mutex(async () => {
			await this.deps.store.enqueuePeerMessage({
				messageType: APP_STATE_SYNC_KEY_SHARE_MESSAGE_TYPE,
				remoteJid: this.deps.getOwnJid(),
				targetDeviceJid: senderJid,
				messageId: this.deps.generateMessageId(),
				timestamp: Date.now(),
				data: encodeShareData(share)
			})
		})
		await this.drain()
	}

	async handleKeyShare(senderJid: string, share: proto.Message.IAppStateSyncKeyShare): Promise<string | undefined> {
		if (!(await this.isKnownOwnDevice(senderJid, true))) {
			this.deps.logger.warn({ senderJid }, 'dropping app-state sync key share from unknown device')
			return undefined
		}

		const responseKeyIds: string[] = []
		const supplied: Record<string, proto.Message.IAppStateSyncKeyData> = {}
		for (const item of share.keys ?? []) {
			if (!item.keyId) throw new Error('app-state sync key share contains an empty key id')
			const keyId = rawKeyId(item.keyId)
			if (!keyId) throw new Error('app-state sync key share contains an empty key id')
			responseKeyIds.push(keyId)
			if (item.keyData) {
				validateKeyData(item.keyData)
				supplied[keyId] = item.keyData
			}
		}

		const exactResponseKeyIds = uniqueSorted(responseKeyIds)
		if (!exactResponseKeyIds.length) return undefined
		const suppliedKeyIds = Object.keys(supplied)
		const result = await this.mutex.mutex(async () => {
			await this.deps.keyStore.transaction(async () => {
				if (suppliedKeyIds.length) await this.deps.keyStore.set({ 'app-state-sync-key': supplied })
			}, this.deps.getOwnJid())

			const readyCollections = suppliedKeyIds.length ? await this.deps.store.resolveKeys(suppliedKeyIds) : []
			const allSupplied = suppliedKeyIds.length === exactResponseKeyIds.length
			const requests = await this.deps.store.listPeerMessages(APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE)
			const completed = requests
				.filter(row => {
					if (!setsEqual(decodeAppStateSyncKeyRequestData(row.data), exactResponseKeyIds)) return false
					return allSupplied || sameDeviceNumber(row.targetDeviceJid, senderJid)
				})
				.map(row => row.id)
			await this.deps.store.deletePeerMessages(completed)

			const stillMissing = await this.deps.store.listMissingCollections()
			const remainingRequests = await this.deps.store.listPeerMessages(APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE)
			if (stillMissing.length && !remainingRequests.length) {
				this.deps.logger.error(
					{ collections: stillMissing, state: 'MissingKeyOnAllClients', keyIds: exactResponseKeyIds },
					'app-state sync key is missing on every registered client'
				)
			}

			const activeKeyId = this.deps.getActiveKeyId()
			const activeCandidate = uniqueSorted(suppliedKeyIds)
				.filter(keyId => isNewerKeyId(keyId, activeKeyId))
				.sort((left, right) => {
					const a = parseAppStateSyncKeyId(left)
					const b = parseAppStateSyncKeyId(right)
					return b.epoch - a.epoch || a.deviceId - b.deviceId
				})[0]

			return { activeCandidate, readyCollections }
		})

		if (result.readyCollections.length) await this.deps.retryCollections(result.readyCollections)
		return result.activeCandidate
	}

	private async sendStored(row: StoredAppStateSyncPeerMessage): Promise<void> {
		let protocolMessage: proto.Message.IProtocolMessage
		if (row.messageType === APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE) {
			protocolMessage = {
				type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST,
				appStateSyncKeyRequest: {
					keyIds: decodeAppStateSyncKeyRequestData(row.data).map(keyId => ({
						keyId: Buffer.from(keyId, 'base64')
					}))
				}
			}
		} else {
			protocolMessage = {
				type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
				appStateSyncKeyShare: decodeShareData(row.data)
			}
		}

		await this.deps.sendPeerMessage(row.targetDeviceJid, { protocolMessage }, row.messageId)
		await this.deps.store.markPeerMessageAcked(row.id)
	}

	private scheduleRetry(): void {
		if (this.stopped || this.retryTimer) return
		const delay = Math.min((this.deps.retryDelayMs ?? REQUEST_RETRY_DELAY_MS) * 2 ** this.retryAttempt, 60_000)
		this.retryAttempt++
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined
			this.drain().catch(error => this.deps.logger.error({ error }, 'app-state sync peer-message retry failed'))
		}, delay)
	}

	private scheduleRecoveryRetry(): void {
		if (this.stopped || this.recoveryTimer) return
		const delay = Math.min((this.deps.retryDelayMs ?? REQUEST_RETRY_DELAY_MS) * 2 ** this.recoveryAttempt, 60_000)
		this.recoveryAttempt++
		this.recoveryTimer = setTimeout(() => {
			this.recoveryTimer = undefined
			this.runRecovery().catch(error =>
				this.deps.logger.warn({ error }, 'app-state sync own-device discovery failed; durable retry retained')
			)
		}, delay)
	}

	private drain(): Promise<void> {
		if (this.stopped) return Promise.resolve()
		if (this.drainPromise) {
			this.drainRequested = true
			return this.drainPromise
		}

		this.drainPromise = (async () => {
			do {
				this.drainRequested = false
				for (const row of await this.deps.store.listUnackedPeerMessages()) {
					if (this.stopped) return
					try {
						await this.sendStored(row)
					} catch (error) {
						this.deps.logger.warn(
							{ error, peerMessageId: row.id, messageType: row.messageType, targetDeviceJid: row.targetDeviceJid },
							'app-state sync peer message send failed; durable retry retained'
						)
						this.scheduleRetry()
						return
					}
				}
			} while (this.drainRequested)

			this.retryAttempt = 0
		})().finally(() => {
			this.drainPromise = undefined
		})
		return this.drainPromise
	}
}
