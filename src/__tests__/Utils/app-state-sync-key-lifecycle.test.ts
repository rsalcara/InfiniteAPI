import { jest } from '@jest/globals'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import type { AppStateSyncKeyStore, SignalDataSet, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'
import {
	AppStateSyncKeyLifecycle,
	decodeAppStateSyncKeyRequestData,
	encodeAppStateSyncKeyRequestData
} from '../../Utils/app-state-sync-key-lifecycle'
import {
	encodeAppStateSyncKeyId,
	FileAppStateSyncKeyStore,
	parseAppStateSyncKeyId
} from '../../Utils/app-state-sync-key-store'
import { decodeSyncdMutations, isMissingKeyError, newLTHashState } from '../../Utils/chat-utils'
import { aesEncrypt } from '../../Utils/crypto'
import type { ILogger } from '../../Utils/logger'
import { expandAppStateKeys } from '../../Utils/wasm-bridge'

type AnySignalValue = SignalDataTypeMap[keyof SignalDataTypeMap]

const ownJid = '5511999999999@s.whatsapp.net'
const ownLid = '123456789@lid'
const deviceOne = '5511999999999:1@s.whatsapp.net'
const deviceTwo = '5511999999999:2@s.whatsapp.net'
const missingKeyId = 'AAAAAEGV'

const silentLogger = (): ILogger => ({
	level: 'silent',
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger()
})

const makeKeyStore = () => {
	const values = new Map<string, AnySignalValue>()
	const recordKey = (type: keyof SignalDataTypeMap, id: string) => `${type}:${id}`
	const store = {
		get: jest.fn(async (type: keyof SignalDataTypeMap, ids: string[]) =>
			Object.fromEntries(
				ids.flatMap(id => (values.has(recordKey(type, id)) ? [[id, values.get(recordKey(type, id))]] : []))
			)
		),
		set: jest.fn(async (data: SignalDataSet) => {
			for (const [rawType, bucket] of Object.entries(data)) {
				const type = rawType as keyof SignalDataTypeMap
				for (const [id, value] of Object.entries(bucket ?? {})) {
					if (value === null || value === undefined) values.delete(recordKey(type, id))
					else values.set(recordKey(type, id), value as AnySignalValue)
				}
			}
		}),
		transaction: jest.fn(async (work: () => Promise<unknown>) => work())
	} as unknown as SignalKeyStoreWithTransaction

	return { store, values, recordKey }
}

const keyData = (seed: number, epoch: number): proto.Message.IAppStateSyncKeyData => ({
	keyData: Buffer.alloc(32, seed),
	fingerprint: { rawId: 1, currentIndex: 2, deviceIndexes: [0, 1, 2] },
	timestamp: epoch
})

const flushTimers = async (delay = 10): Promise<void> => {
	await new Promise(resolve => setTimeout(resolve, delay))
}

const waitFor = async (condition: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> => {
	const deadline = Date.now() + timeoutMs
	while (!(await condition())) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for lifecycle condition')
		await flushTimers(5)
	}
}

type LifecycleOverrides = Partial<ConstructorParameters<typeof AppStateSyncKeyLifecycle>[0]>

const makeLifecycle = (store: AppStateSyncKeyStore, overrides: LifecycleOverrides = {}) => {
	const keyStore = makeKeyStore()
	let id = 0
	const sendPeerMessage = jest.fn<(target: string, message: proto.IMessage, messageId: string) => Promise<void>>(
		async () => {}
	)
	const retryCollections = jest.fn(async () => {})
	const logger = silentLogger()
	logger.info = jest.fn()
	logger.debug = jest.fn()
	logger.error = jest.fn()
	logger.warn = jest.fn()
	const lifecycle = new AppStateSyncKeyLifecycle({
		store,
		keyStore: keyStore.store,
		logger,
		getOwnJid: () => ownJid,
		getOwnLid: () => ownLid,
		getActiveKeyId: () => undefined,
		listOwnDevices: async () => [deviceOne, deviceTwo],
		sendPeerMessage,
		retryCollections,
		generateMessageId: () => `peer-${++id}`,
		retryDelayMs: 5,
		...overrides
	})
	activeLifecycles.push(lifecycle)

	return { lifecycle, keyStore, sendPeerMessage, retryCollections, logger }
}

const tempDirs: string[] = []
const activeLifecycles: AppStateSyncKeyLifecycle[] = []
const makeFileStore = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'app-state-key-lifecycle-'))
	tempDirs.push(dir)
	return { store: new FileAppStateSyncKeyStore(join(dir, 'state.json')) }
}

describe('AppStateSyncKeyLifecycle — official types 38/39 recovery', () => {
	afterEach(async () => {
		for (const lifecycle of activeLifecycles.splice(0)) lifecycle.stop()
		await flushTimers()
		await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
	})

	it('parses AAAAAEGV as device 0 / epoch 16789 and round-trips the official six-byte id', () => {
		expect(parseAppStateSyncKeyId(missingKeyId)).toEqual({ deviceId: 0, epoch: 16789 })
		expect(encodeAppStateSyncKeyId({ deviceId: 0, epoch: 16789 })).toBe(missingKeyId)
		expect(() => parseAppStateSyncKeyId('not-base64')).toThrow('invalid app-state sync key id')
	})

	it('uses the exact official JSON/protobuf representation for type 39 key sets', () => {
		const second = encodeAppStateSyncKeyId({ deviceId: 2, epoch: 17000 })
		const encoded = encodeAppStateSyncKeyRequestData([second, missingKeyId, second])
		const parsed = JSON.parse(encoded) as { 'key-ids': string[] }

		expect(Object.keys(parsed)).toEqual(['key-ids'])
		expect(parsed['key-ids']).toHaveLength(2)
		expect(decodeAppStateSyncKeyRequestData(encoded)).toEqual([missingKeyId, second].sort())
	})

	it('deduplicates five blocked collections into one request per own device', async () => {
		const { store } = await makeFileStore()
		const { lifecycle, sendPeerMessage } = makeLifecycle(store)
		await lifecycle.startRecovery()

		for (const collection of ['regular', 'regular_low', 'regular_high', 'critical_block', 'critical_unblock_low']) {
			await lifecycle.requestMissingKey(collection, missingKeyId)
		}

		await lifecycle.runRecovery()

		const requests = await store.listPeerMessages(39)
		expect(requests).toHaveLength(2)
		expect(new Set(requests.map(row => row.targetDeviceJid))).toEqual(new Set([deviceOne, deviceTwo]))
		expect(requests.every(row => row.acked)).toBe(true)
		expect(sendPeerMessage).toHaveBeenCalledTimes(2)
		expect(await store.listMissingCollections()).toEqual([
			'critical_block',
			'critical_unblock_low',
			'regular',
			'regular_high',
			'regular_low'
		])
		lifecycle.stop()
	})

	it('requests outstanding keys from a newly discovered own device', async () => {
		const { store } = await makeFileStore()
		let devices = [deviceOne]
		const { lifecycle, sendPeerMessage } = makeLifecycle(store, { listOwnDevices: async () => devices })
		await lifecycle.startRecovery()
		await lifecycle.requestMissingKey('regular', missingKeyId)
		await lifecycle.runRecovery()
		expect(sendPeerMessage).toHaveBeenCalledTimes(1)

		devices = [deviceOne, deviceTwo]
		await lifecycle.runRecovery()
		expect(sendPeerMessage).toHaveBeenCalledTimes(2)
		expect((await store.listPeerMessages(39)).map(row => row.targetDeviceJid)).toEqual([deviceOne, deviceTwo])
	})

	it('reports MissingKeyOnAllClients without enqueueing a request when no other device exists', async () => {
		const { store } = await makeFileStore()
		const { lifecycle, logger, sendPeerMessage } = makeLifecycle(store, { listOwnDevices: async () => [] })
		await lifecycle.startRecovery()
		await lifecycle.requestMissingKey('regular', missingKeyId)
		await lifecycle.runRecovery()

		expect(await store.listPeerMessages(39)).toEqual([])
		expect(sendPeerMessage).not.toHaveBeenCalled()
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ state: 'MissingKeyOnAllClients', collections: ['regular'], keyIds: [missingKeyId] }),
			'app-state sync key is missing on every registered client'
		)
	})

	it('reports a newly missing unrequested key even when an older request is still pending', async () => {
		const { store } = await makeFileStore()
		const olderKeyId = encodeAppStateSyncKeyId({ deviceId: 0, epoch: 16788 })
		await store.recordMissingKey(olderKeyId, 'regular_low')
		await store.enqueuePeerMessage({
			messageType: 39,
			remoteJid: ownJid,
			targetDeviceJid: deviceOne,
			messageId: 'older-pending-request',
			timestamp: 1,
			data: encodeAppStateSyncKeyRequestData([olderKeyId])
		})
		await store.recordMissingKey(missingKeyId, 'regular')
		const { lifecycle, logger } = makeLifecycle(store, { listOwnDevices: async () => [] })

		await lifecycle.startRecovery()

		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				state: 'MissingKeyOnAllClients',
				collections: ['regular'],
				keyIds: [missingKeyId]
			}),
			'app-state sync key is missing on every registered client'
		)
		lifecycle.stop()
	})

	it('retries device discovery after a transient failure without requiring a restart', async () => {
		const { store } = await makeFileStore()
		await store.recordMissingKey(missingKeyId, 'regular')
		const listOwnDevices = jest
			.fn<() => Promise<string[]>>()
			.mockRejectedValueOnce(new Error('USync unavailable'))
			.mockResolvedValue([deviceOne])
		const { lifecycle, sendPeerMessage } = makeLifecycle(store, { listOwnDevices })

		await expect(lifecycle.startRecovery()).rejects.toThrow('USync unavailable')
		await flushTimers(30)

		expect(listOwnDevices).toHaveBeenCalledTimes(2)
		expect(sendPeerMessage).toHaveBeenCalledTimes(1)
		expect(await store.listPeerMessages(39)).toEqual([
			expect.objectContaining({ targetDeviceJid: deviceOne, acked: true })
		])
	})

	it('persists inside the sync transaction but defers USync/send work until after it returns', async () => {
		const { store } = await makeFileStore()
		let transactionOpen = true
		const send = jest.fn(async () => {
			expect(transactionOpen).toBe(false)
		})
		const { lifecycle } = makeLifecycle(store, { listOwnDevices: async () => [deviceOne], sendPeerMessage: send })
		await lifecycle.startRecovery()

		await lifecycle.requestMissingKey('regular', missingKeyId)
		expect(await store.listMissingKeyIds()).toEqual([missingKeyId])
		expect(send).not.toHaveBeenCalled()
		transactionOpen = false
		await lifecycle.runRecovery()
		expect(send).toHaveBeenCalledTimes(1)
	})

	it('closes detection -> request 39 -> share 38 -> key commit -> collection retry', async () => {
		const { store } = await makeFileStore()
		const material = keyData(7, 1_700_000_000)
		let retriedMutation: unknown
		const activeKeyStore: { current?: ReturnType<typeof makeKeyStore> } = {}
		const retryCollections = jest.fn(async (collections: string[]) => {
			const holder = activeKeyStore.current!
			const stored = await holder.store.get('app-state-sync-key', [missingKeyId])
			const { valueEncryptionKey } = expandAppStateKeys(Buffer.from(stored[missingKeyId]!.keyData!))
			const action: proto.ISyncActionData = {
				index: Buffer.from(JSON.stringify(['mute', 'chat@s.whatsapp.net'])),
				value: { muteAction: { muted: true } }
			}
			const encrypted = aesEncrypt(Buffer.from(proto.SyncActionData.encode(action).finish()), valueEncryptionKey)
			await decodeSyncdMutations(
				[
					{
						keyId: { id: Buffer.from(missingKeyId, 'base64') },
						value: { blob: Buffer.concat([encrypted, Buffer.alloc(32)]) },
						index: { blob: Buffer.alloc(16) }
					}
				],
				newLTHashState(),
				async id => (await holder.store.get('app-state-sync-key', [id]))[id],
				mutation => {
					retriedMutation = mutation
				},
				false
			)
			expect(collections).toEqual(['regular'])
		})
		const { lifecycle, keyStore, sendPeerMessage, logger } = makeLifecycle(store, {
			listOwnDevices: async () => [deviceOne],
			retryCollections
		})
		activeKeyStore.current = keyStore
		await lifecycle.startRecovery()

		let missing: unknown
		try {
			await decodeSyncdMutations(
				[
					{
						keyId: { id: Buffer.from(missingKeyId, 'base64') },
						value: { blob: Buffer.alloc(64) },
						index: { blob: Buffer.alloc(16) }
					}
				],
				newLTHashState(),
				async () => undefined,
				() => {},
				false
			)
		} catch (error) {
			missing = error
		}

		expect(isMissingKeyError(missing)).toBe(true)
		const missingData = (missing as { data: { keyId: string } }).data
		await lifecycle.requestMissingKey('regular', missingData.keyId)
		await lifecycle.runRecovery()
		expect(sendPeerMessage).toHaveBeenCalledWith(
			deviceOne,
			expect.objectContaining({
				protocolMessage: expect.objectContaining({
					type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST
				})
			}),
			'peer-1'
		)
		expect(await store.listMissingKeyIds()).toEqual([missingKeyId])

		await lifecycle.handleKeyShare(deviceOne, {
			keys: [{ keyId: { keyId: Buffer.from(missingKeyId, 'base64') }, keyData: material }]
		})

		expect(await keyStore.store.get('app-state-sync-key', [missingKeyId])).toEqual({ [missingKeyId]: material })
		expect(retryCollections).toHaveBeenCalledTimes(1)
		expect(retriedMutation).toEqual(expect.objectContaining({ index: ['mute', 'chat@s.whatsapp.net'] }))
		expect(await store.listMissingKeyIds()).toEqual([])
		for (const phase of [
			'missing-key-persisted',
			'type-39-persisted',
			'transport-ack',
			'type-38-received-validated',
			'type-38-keys-stored',
			'collections-retried'
		]) {
			expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ phase }), expect.any(String))
		}

		lifecycle.stop()
	})

	it('responds to type 39 with type 38 entries both with and without keyData', async () => {
		const { store } = await makeFileStore()
		const knownId = encodeAppStateSyncKeyId({ deviceId: 0, epoch: 20000 })
		const absentId = encodeAppStateSyncKeyId({ deviceId: 0, epoch: 20001 })
		const knownData = keyData(4, 20_000)
		const { lifecycle, keyStore, sendPeerMessage } = makeLifecycle(store, {
			listOwnDevices: async () => [deviceOne]
		})
		await keyStore.store.set({ 'app-state-sync-key': { [knownId]: knownData } })
		await lifecycle.startRecovery()

		await lifecycle.handleKeyRequest(deviceOne, {
			keyIds: [{ keyId: Buffer.from(knownId, 'base64') }, { keyId: Buffer.from(absentId, 'base64') }]
		})

		expect(sendPeerMessage).toHaveBeenCalledTimes(1)
		const message = sendPeerMessage.mock.calls[0]![1]
		const keys = message.protocolMessage?.appStateSyncKeyShare?.keys
		expect(keys).toHaveLength(2)
		const returnedKnown = keys?.find(item => Buffer.from(item.keyId!.keyId!).toString('base64') === knownId)?.keyData
		expect(Buffer.from(returnedKnown!.keyData!)).toEqual(Buffer.from(knownData.keyData!))
		expect(returnedKnown?.fingerprint).toEqual(knownData.fingerprint)
		expect(returnedKnown?.timestamp?.toString()).toBe(knownData.timestamp?.toString())
		expect(keys?.find(item => Buffer.from(item.keyId!.keyId!).toString('base64') === absentId)?.keyData).toBeNull()
		lifecycle.stop()
	})

	it('redrains a peer message enqueued while another send is in flight', async () => {
		const { store } = await makeFileStore()
		let releaseFirst!: () => void
		const firstBlocked = new Promise<void>(resolve => {
			releaseFirst = resolve
		})
		const send = jest.fn(async () => {
			if (send.mock.calls.length === 1) await firstBlocked
		})
		const { lifecycle } = makeLifecycle(store, {
			listOwnDevices: async () => [deviceOne, deviceTwo],
			sendPeerMessage: send
		})
		await lifecycle.startRecovery()
		const request = { keyIds: [{ keyId: Buffer.from(missingKeyId, 'base64') }] }
		const first = lifecycle.handleKeyRequest(deviceOne, request)
		await waitFor(() => send.mock.calls.length === 1)
		const second = lifecycle.handleKeyRequest(deviceTwo, request)
		expect(send).toHaveBeenCalledTimes(1)

		releaseFirst()
		await Promise.all([first, second])
		expect(send).toHaveBeenCalledTimes(2)
		expect(await store.listUnackedPeerMessages()).toEqual([])
	})

	it('keeps a request unacked until send completion and retries a transient failure', async () => {
		const { store } = await makeFileStore()
		let release!: () => void
		const delayed = new Promise<void>(resolve => {
			release = resolve
		})
		let attempts = 0
		const send = jest.fn(async () => {
			attempts++
			if (attempts === 1) throw new Error('temporary network failure')
			await delayed
		})
		const { lifecycle } = makeLifecycle(store, { listOwnDevices: async () => [deviceOne], sendPeerMessage: send })
		await lifecycle.startRecovery()
		await lifecycle.requestMissingKey('regular', missingKeyId)
		await lifecycle.runRecovery()
		await lifecycle.runRecovery()
		await waitFor(() => send.mock.calls.length === 2)

		expect(send).toHaveBeenCalledTimes(2)
		expect((await store.listPeerMessages(39))[0]?.acked).toBe(false)
		release()
		await waitFor(async () => Boolean((await store.listPeerMessages(39))[0]?.acked))
		expect((await store.listPeerMessages(39))[0]?.acked).toBe(true)
		lifecycle.stop()
	})

	it('recovers an unacked persisted request after restart without creating another row', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'app-state-key-restart-'))
		const path = join(dir, 'state.json')
		try {
			const firstStore = new FileAppStateSyncKeyStore(path)
			const first = makeLifecycle(firstStore, {
				listOwnDevices: async () => [deviceOne],
				sendPeerMessage: async () => {
					throw new Error('offline')
				}
			})
			await first.lifecycle.startRecovery()
			await first.lifecycle.requestMissingKey('regular', missingKeyId)
			await first.lifecycle.runRecovery()
			first.lifecycle.stop()
			expect((await firstStore.listPeerMessages(39))[0]?.acked).toBe(false)

			const reopenedStore = new FileAppStateSyncKeyStore(path)
			const reopened = makeLifecycle(reopenedStore, { listOwnDevices: async () => [deviceOne] })
			await reopened.lifecycle.startRecovery()
			expect(reopened.sendPeerMessage).toHaveBeenCalledTimes(1)
			expect(await reopenedStore.listPeerMessages(39)).toHaveLength(1)
			expect((await reopenedStore.listPeerMessages(39))[0]?.acked).toBe(true)
			reopened.lifecycle.stop()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('removes a persisted type-39 request on restart when every requested key is already stored', async () => {
		const { store } = await makeFileStore()
		await store.recordMissingKey(missingKeyId, 'regular')
		await store.enqueuePeerMessage({
			messageType: 39,
			remoteJid: ownJid,
			targetDeviceJid: deviceOne,
			messageId: 'satisfied-before-restart',
			timestamp: 1,
			data: encodeAppStateSyncKeyRequestData([missingKeyId])
		})
		const { lifecycle, keyStore, sendPeerMessage, retryCollections } = makeLifecycle(store)
		keyStore.values.set(keyStore.recordKey('app-state-sync-key', missingKeyId), keyData(1, 1))

		await lifecycle.startRecovery()

		expect(await store.listMissingKeyIds()).toEqual([])
		expect(await store.listPeerMessages(39)).toEqual([])
		expect(sendPeerMessage).not.toHaveBeenCalled()
		expect(retryCollections).toHaveBeenCalledWith(['regular'])
	})

	it('keeps the scheduled peer-send backoff authoritative during a new recovery pass', async () => {
		const { store } = await makeFileStore()
		const secondId = encodeAppStateSyncKeyId({ deviceId: 0, epoch: 16790 })
		const sendPeerMessage = jest.fn(async () => {
			throw new Error('offline')
		})
		const { lifecycle } = makeLifecycle(store, {
			listOwnDevices: async () => [deviceOne],
			sendPeerMessage,
			retryDelayMs: 10_000
		})
		await lifecycle.startRecovery()
		await lifecycle.requestMissingKey('regular', missingKeyId)
		await lifecycle.runRecovery()
		expect(sendPeerMessage).toHaveBeenCalledTimes(1)

		await lifecycle.requestMissingKey('critical_block', secondId)
		await flushTimers(50)

		expect(sendPeerMessage).toHaveBeenCalledTimes(1)
		expect(await store.listPeerMessages(39)).toHaveLength(2)
	})

	it('correlates partial responses by exact key set and reports all-clients-missing only after the final device', async () => {
		const { store } = await makeFileStore()
		const secondId = encodeAppStateSyncKeyId({ deviceId: 0, epoch: 16790 })
		const requestData = encodeAppStateSyncKeyRequestData([missingKeyId, secondId])
		for (const [index, targetDeviceJid] of [deviceOne, deviceTwo].entries()) {
			await store.enqueuePeerMessage({
				messageType: 39,
				remoteJid: ownJid,
				targetDeviceJid,
				messageId: `request-${index}`,
				timestamp: 1,
				data: requestData
			})
		}

		await store.recordMissingKey(missingKeyId, 'regular')
		await store.recordMissingKey(secondId, 'regular')
		const { lifecycle, retryCollections, logger } = makeLifecycle(store, { listOwnDevices: async () => [] })
		await lifecycle.startRecovery()

		await lifecycle.handleKeyShare(deviceOne, {
			keys: [
				{ keyId: { keyId: Buffer.from(missingKeyId, 'base64') }, keyData: keyData(1, 1) },
				{ keyId: { keyId: Buffer.from(secondId, 'base64') } }
			]
		})
		expect(await store.listPeerMessages(39)).toHaveLength(1)
		expect(await store.listMissingKeyIds()).toEqual([secondId])
		expect(retryCollections).not.toHaveBeenCalled()
		expect(logger.error).not.toHaveBeenCalledWith(
			expect.objectContaining({ state: 'MissingKeyOnAllClients' }),
			expect.any(String)
		)

		await lifecycle.handleKeyShare(deviceTwo, {
			keys: [
				{ keyId: { keyId: Buffer.from(missingKeyId, 'base64') } },
				{ keyId: { keyId: Buffer.from(secondId, 'base64') } }
			]
		})
		expect(await store.listPeerMessages(39)).toHaveLength(0)
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ state: 'MissingKeyOnAllClients', collections: ['regular'] }),
			'app-state sync key is missing on every registered client'
		)
		lifecycle.stop()
	})

	it('retries collections unblocked by a partial response even when another collection remains missing', async () => {
		const { store } = await makeFileStore()
		const secondId = encodeAppStateSyncKeyId({ deviceId: 0, epoch: 16790 })
		await store.recordMissingKey(missingKeyId, 'regular')
		await store.recordMissingKey(secondId, 'regular_low')
		await store.enqueuePeerMessage({
			messageType: 39,
			remoteJid: ownJid,
			targetDeviceJid: deviceOne,
			messageId: 'partial-ready',
			timestamp: 1,
			data: encodeAppStateSyncKeyRequestData([missingKeyId, secondId])
		})
		const { lifecycle, retryCollections } = makeLifecycle(store, { listOwnDevices: async () => [] })
		await lifecycle.startRecovery()

		await lifecycle.handleKeyShare(deviceOne, {
			keys: [
				{ keyId: { keyId: Buffer.from(missingKeyId, 'base64') }, keyData: keyData(3, 3) },
				{ keyId: { keyId: Buffer.from(secondId, 'base64') } }
			]
		})

		expect(retryCollections).toHaveBeenCalledWith(['regular'])
		expect(await store.listMissingCollections()).toEqual(['regular_low'])
	})

	it('rejects foreign/unknown devices but accepts PN/LID aliases with the same device number', async () => {
		const { store } = await makeFileStore()
		await store.recordMissingKey(missingKeyId, 'regular')
		await store.enqueuePeerMessage({
			messageType: 39,
			remoteJid: ownJid,
			targetDeviceJid: `${jidUser(ownLid)}:2@lid`,
			messageId: 'request-alias',
			timestamp: 1,
			data: encodeAppStateSyncKeyRequestData([missingKeyId])
		})
		const { lifecycle, keyStore } = makeLifecycle(store, { listOwnDevices: async () => [] })
		await lifecycle.startRecovery()
		const share = {
			keys: [{ keyId: { keyId: Buffer.from(missingKeyId, 'base64') }, keyData: keyData(9, 9) }]
		}

		await lifecycle.handleKeyShare('999999999999:2@s.whatsapp.net', share)
		await lifecycle.handleKeyShare('5511999999999:9@s.whatsapp.net', share)
		expect(await keyStore.store.get('app-state-sync-key', [missingKeyId])).toEqual({})

		await lifecycle.handleKeyShare(deviceTwo, share)
		expect(await keyStore.store.get('app-state-sync-key', [missingKeyId])).toHaveProperty(missingKeyId)
		lifecycle.stop()
	})

	it('does not replace a newer active key when an older missing key is recovered', async () => {
		const { store } = await makeFileStore()
		const active = encodeAppStateSyncKeyId({ deviceId: 0, epoch: 20000 })
		const sameEpochHigherDevice = encodeAppStateSyncKeyId({ deviceId: 4, epoch: 20000 })
		const { lifecycle } = makeLifecycle(store, {
			getActiveKeyId: () => active,
			listOwnDevices: async () => [deviceOne]
		})
		await lifecycle.startRecovery()

		await expect(
			lifecycle.handleKeyShare(deviceOne, {
				keys: [{ keyId: { keyId: Buffer.from(missingKeyId, 'base64') }, keyData: keyData(1, 1) }]
			})
		).resolves.toBeUndefined()
		await expect(
			lifecycle.handleKeyShare(deviceOne, {
				keys: [{ keyId: { keyId: Buffer.from(sameEpochHigherDevice, 'base64') }, keyData: keyData(2, 2) }]
			})
		).resolves.toBeUndefined()
		lifecycle.stop()
	})

	it('deletes an acked type-38 only after the matching own-device peer receipt', async () => {
		const { store } = await makeFileStore()
		const share = await store.enqueuePeerMessage({
			messageType: 38,
			remoteJid: ownJid,
			targetDeviceJid: deviceTwo,
			messageId: 'share-delivered',
			timestamp: 1,
			data: JSON.stringify({ appStateSyncKeyShareProtoString: '', isNewlyGeneratedKey: false })
		})
		const { lifecycle } = makeLifecycle(store)

		await lifecycle.handlePeerDeliveryReceipt(ownJid, ['share-delivered'])
		expect(await store.listPeerMessages(38)).toHaveLength(1)
		await store.markPeerMessageAcked(share.id)
		await lifecycle.handlePeerDeliveryReceipt('999999999999:2@s.whatsapp.net', ['share-delivered'])
		await lifecycle.handlePeerDeliveryReceipt(deviceOne, ['share-delivered'])
		await lifecycle.handlePeerDeliveryReceipt(deviceTwo, ['another-id'])
		expect(await store.listPeerMessages(38)).toHaveLength(1)

		await lifecycle.handlePeerDeliveryReceipt(`${jidUser(ownLid)}:2@lid`, ['share-delivered'])
		expect(await store.listPeerMessages(38)).toEqual([])
	})

	it('lets the peer receipt complete type-38 across a crash before the transport ACK flag is persisted', async () => {
		const { store } = await makeFileStore()
		await store.enqueuePeerMessage({
			messageType: 38,
			remoteJid: ownJid,
			targetDeviceJid: deviceOne,
			messageId: 'share-before-local-ack',
			timestamp: 1,
			data: JSON.stringify({ appStateSyncKeyShareProtoString: '', isNewlyGeneratedKey: false })
		})
		const { lifecycle } = makeLifecycle(store)

		await lifecycle.handlePeerDeliveryReceipt(deviceOne, ['share-before-local-ack'])
		expect(await store.listPeerMessages(38)).toEqual([])
	})

	it('retains type-39 requests when a peer delivery receipt completes type-38', async () => {
		const { store } = await makeFileStore()
		const share = await store.enqueuePeerMessage({
			messageType: 38,
			remoteJid: ownJid,
			targetDeviceJid: deviceOne,
			messageId: 'shared-message-id',
			timestamp: 1,
			data: JSON.stringify({ appStateSyncKeyShareProtoString: '', isNewlyGeneratedKey: false })
		})
		await store.markPeerMessageAcked(share.id)
		await store.enqueuePeerMessage({
			messageType: 39,
			remoteJid: ownJid,
			targetDeviceJid: deviceOne,
			messageId: 'shared-message-id',
			timestamp: 2,
			data: encodeAppStateSyncKeyRequestData([missingKeyId])
		})
		const { lifecycle } = makeLifecycle(store)

		await lifecycle.handlePeerDeliveryReceipt(deviceOne, ['shared-message-id'])
		expect(await store.listPeerMessages(38)).toEqual([])
		expect(await store.listPeerMessages(39)).toHaveLength(1)
	})

	it('retains type-38 when durable receipt completion fails so the stanza can be retried', async () => {
		const { store } = await makeFileStore()
		const share = await store.enqueuePeerMessage({
			messageType: 38,
			remoteJid: ownJid,
			targetDeviceJid: deviceOne,
			messageId: 'share-delete-failure',
			timestamp: 1,
			data: JSON.stringify({ appStateSyncKeyShareProtoString: '', isNewlyGeneratedKey: false })
		})
		await store.markPeerMessageAcked(share.id)
		const deletePeerMessages = store.deletePeerMessages.bind(store)
		store.deletePeerMessages = jest.fn(async () => {
			throw new Error('disk unavailable')
		})
		const { lifecycle } = makeLifecycle(store)

		await expect(lifecycle.handlePeerDeliveryReceipt(deviceOne, ['share-delete-failure'])).rejects.toThrow(
			'disk unavailable'
		)
		expect(await store.listPeerMessages(38)).toHaveLength(1)
		store.deletePeerMessages = deletePeerMessages
		await lifecycle.handlePeerDeliveryReceipt(deviceOne, ['share-delete-failure'])
		expect(await store.listPeerMessages(38)).toEqual([])
	})
})

const jidUser = (jid: string): string => jid.slice(0, jid.indexOf('@'))
