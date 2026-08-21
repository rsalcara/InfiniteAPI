import Database from 'better-sqlite3'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppStateSyncKeyStore, AuthenticationState } from '../../Types'
import { encodeAppStateSyncKeyRequestData } from '../../Utils/app-state-sync-key-lifecycle'
import { FileAppStateSyncKeyStore, SqliteAppStateSyncKeyStore } from '../../Utils/app-state-sync-key-store'
import { inspectAuthStateCapabilities } from '../../Utils/auth-state-capabilities'
import type { ILogger } from '../../Utils/logger'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const keyId = 'AAAAAEGV'

const silentLogger = (): ILogger => ({
	level: 'silent',
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger()
})

type OpenedBackend = {
	state: AuthenticationState
	close: () => void
	insertUnrelated?: () => void
}

const requireStore = (state: AuthenticationState): AppStateSyncKeyStore => {
	if (!state.appStateSyncKeys) throw new Error('built-in auth adapter did not expose appStateSyncKeys')
	return state.appStateSyncKeys
}

const exerciseDurableBackend = async (open: () => Promise<OpenedBackend>): Promise<void> => {
	const first = await open()
	const firstStore = requireStore(first.state)
	expect(firstStore.durable).toBe(true)
	expect(first.state.storage).toEqual(expect.objectContaining({ historySyncDurable: true, tcTokenDurable: true }))
	expect(first.state.storage?.backend).not.toBe('custom')
	expect(inspectAuthStateCapabilities(first.state, 'built-in').capabilities).toEqual(
		expect.objectContaining({
			appStateSyncRecovery: true,
			historySyncDurable: true,
			tcTokenDurable: true,
			issues: []
		})
	)
	if (!first.state.historySync) throw new Error('built-in auth adapter did not expose historySync')
	await first.state.historySync.enqueue({
		messageId: 'history-checkpoint-source',
		sourceMessageId: 'history-checkpoint-source',
		messageKey: { id: 'history-checkpoint-source', remoteJid: 'me@s.whatsapp.net', fromMe: true },
		notification: Buffer.from([1]),
		syncType: 0,
		chunkOrder: 1,
		progress: 100
	})
	await first.state.historySync.commit('history-checkpoint-source', {
		phase: 'INITIAL',
		syncType: 0,
		chunkOrder: 1,
		progress: 100,
		messageId: 'history-checkpoint-source',
		updatedAt: 1_700_000_000_000
	})
	await firstStore.recordMissingKey(keyId, 'regular')
	const request = await firstStore.enqueuePeerMessage({
		messageType: 39,
		remoteJid: '5511999999999@s.whatsapp.net',
		targetDeviceJid: '5511999999999:2@s.whatsapp.net',
		messageId: 'request-39',
		timestamp: 1_700_000_000_000,
		data: encodeAppStateSyncKeyRequestData([keyId])
	})
	await firstStore.markPeerMessageAcked(request.id)
	const share = await firstStore.enqueuePeerMessage({
		messageType: 38,
		remoteJid: '5511999999999@s.whatsapp.net',
		targetDeviceJid: '5511999999999:2@s.whatsapp.net',
		messageId: 'share-38',
		timestamp: 1_700_000_000_001,
		data: JSON.stringify({ appStateSyncKeyShareProtoString: '', isNewlyGeneratedKey: false })
	})
	await firstStore.markPeerMessageAcked(share.id)
	first.close()

	const reopened = await open()
	const reopenedStore = requireStore(reopened.state)
	expect(await reopened.state.historySync?.getCheckpoint('INITIAL')).toEqual({
		phase: 'INITIAL',
		syncType: 0,
		chunkOrder: 1,
		progress: 100,
		messageId: 'history-checkpoint-source',
		updatedAt: 1_700_000_000_000
	})
	expect(await reopenedStore.listMissingKeyIds()).toEqual([keyId])
	expect(await reopenedStore.listMissingCollections()).toEqual(['regular'])
	expect(await reopenedStore.listPeerMessages(39)).toEqual([
		expect.objectContaining({
			messageType: 39,
			targetDeviceJid: '5511999999999:2@s.whatsapp.net',
			messageId: 'request-39',
			acked: true
		})
	])
	expect(await reopenedStore.listUnackedPeerMessages()).toEqual([])
	expect(await reopenedStore.listPeerMessages(38)).toEqual([
		expect.objectContaining({ messageId: 'share-38', acked: true })
	])

	if (reopened.insertUnrelated) {
		reopened.insertUnrelated()
		expect(await reopenedStore.listUnackedPeerMessages()).toEqual([])
	}

	expect(await reopenedStore.resolveKeys([keyId])).toEqual(['regular'])
	expect(await reopenedStore.listMissingKeyIds()).toEqual([])
	expect(await reopened.state.historySync?.getCheckpoint('INITIAL')).toEqual(
		expect.objectContaining({ messageId: 'history-checkpoint-source', progress: 100 })
	)
	await reopenedStore.deletePeerMessages((await reopenedStore.listPeerMessages(38)).map(row => row.id))
	expect(await reopenedStore.listPeerMessages(38)).toEqual([])
	expect(await reopenedStore.listPeerMessages(39)).toHaveLength(1)
	await reopenedStore.deletePeerMessages((await reopenedStore.listPeerMessages(39)).map(row => row.id))
	expect(await reopenedStore.listPeerMessages(39)).toEqual([])
	reopened.close()
}

describe('durable App State key recovery — independent built-in auth backends', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'app-state-key-backends-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('persists independently in multifile', async () => {
		await exerciseDurableBackend(async () => {
			const result = await useMultiFileAuthState(dir)
			return { state: result.state, close: () => {} }
		})
	})

	it('recovers the newest complete temporary file before a stale primary', async () => {
		const path = join(dir, 'app-state-sync-key-recovery.json')
		const stale = new FileAppStateSyncKeyStore(path)
		await stale.recordMissingKey(keyId, 'regular')
		const newerKeyId = 'AAAAAEGW'
		await writeFile(
			`${path}.tmp`,
			JSON.stringify({ nextPeerMessageId: 1, missingKeys: { [newerKeyId]: ['critical_block'] }, peerMessages: [] })
		)

		const recovered = new FileAppStateSyncKeyStore(path)
		await expect(recovered.listMissingKeyIds()).resolves.toEqual([newerKeyId])
		await expect(recovered.listMissingCollections()).resolves.toEqual(['critical_block'])
	})

	it('rejects malformed missing-key ids when importing into the file backend', async () => {
		const store = new FileAppStateSyncKeyStore(join(dir, 'app-state-sync-key-recovery.json'))
		await expect(
			store.importState({ missingKeys: [{ keyId: 'malformed', collectionName: 'regular' }], peerMessages: [] })
		).rejects.toThrow('invalid app-state sync key id')
		await expect(store.listMissingKeyIds()).resolves.toEqual([])
	})

	it('persists independently in monolithic sqlite', async () => {
		const dbPath = join(dir, 'auth.db')
		await exerciseDurableBackend(async () => {
			const result = await useSqliteAuthState({ dbPath, logger: silentLogger() })
			return { state: result.state, close: result.close }
		})
	})

	it('persists independently in multidb-sqlite sync.db', async () => {
		await exerciseDurableBackend(async () => {
			const result = await useMultiDbSqliteAuthState({ sessionDir: dir, logger: silentLogger() })
			return {
				state: result.state,
				close: result.close,
				insertUnrelated: () => {
					result.store
						.handle('sync.db')
						.prepare(
							'INSERT INTO peer_messages (message_type, key_remote_jid, key_from_me, key_id, device_id, timestamp, data, acked) VALUES (?, ?, 1, ?, ?, ?, ?, 0)'
						)
						.run(70, '5511999999999@s.whatsapp.net', 'unrelated', '5511999999999:2@s.whatsapp.net', 1, '{}')
				}
			}
		})
	})

	it('filters unrelated peer types in the shared sqlite table', async () => {
		const db = new Database(':memory:')
		try {
			const store = new SqliteAppStateSyncKeyStore(db as never)
			db.prepare(
				'INSERT INTO peer_messages (message_type, key_remote_jid, key_from_me, key_id, device_id, timestamp, data, acked) VALUES (70, ?, 1, ?, ?, ?, ?, 0)'
			).run('5511999999999@s.whatsapp.net', 'unrelated', '5511999999999:2@s.whatsapp.net', 1, '{}')
			expect(await store.listUnackedPeerMessages()).toEqual([])
			expect(await store.listPeerMessages()).toEqual([])
			await store.clear()
			expect(db.prepare('SELECT message_type FROM peer_messages').all() as Array<{ message_type: number }>).toEqual([
				{ message_type: 70 }
			])
		} finally {
			db.close()
		}
	})

	it('preserves unrelated peer rows when monolithic auth keys are cleared', async () => {
		const db = new Database(':memory:')
		try {
			const auth = await useSqliteAuthState({ dbPath: ':memory:', database: db, logger: silentLogger() })
			db.prepare(
				'INSERT INTO peer_messages (message_type, key_remote_jid, key_from_me, key_id, device_id, timestamp, data, acked) VALUES (70, ?, 1, ?, ?, ?, ?, 0)'
			).run('5511999999999@s.whatsapp.net', 'unrelated-clear', '5511999999999:2@s.whatsapp.net', 1, '{}')
			await auth.state.appStateSyncKeys!.enqueuePeerMessage({
				messageType: 39,
				remoteJid: '5511999999999@s.whatsapp.net',
				targetDeviceJid: '5511999999999:2@s.whatsapp.net',
				messageId: 'app-state-clear',
				timestamp: 1,
				data: encodeAppStateSyncKeyRequestData([keyId])
			})

			await auth.state.keys.clear!()

			expect(db.prepare('SELECT message_type FROM peer_messages').all()).toEqual([{ message_type: 70 }])
			auth.close()
		} finally {
			db.close()
		}
	})

	it('exports missing keys and peer messages from one SQLite read transaction', async () => {
		const db = new Database(':memory:')
		try {
			const store = new SqliteAppStateSyncKeyStore(db as never)
			await store.recordMissingKey(keyId, 'regular')
			await store.enqueuePeerMessage({
				messageType: 39,
				remoteJid: '5511999999999@s.whatsapp.net',
				targetDeviceJid: '5511999999999:2@s.whatsapp.net',
				messageId: 'snapshot-peer-39',
				timestamp: 1,
				data: encodeAppStateSyncKeyRequestData([keyId])
			})

			const internal = store as unknown as {
				listMissingRows: () => Array<{ deviceId: number; epoch: number; collectionName: string }>
			}
			const listMissingRows = internal.listMissingRows.bind(store)
			internal.listMissingRows = () => {
				expect(db.inTransaction).toBe(true)
				return listMissingRows()
			}

			await expect(store.exportState()).resolves.toEqual({
				missingKeys: [{ keyId, collectionName: 'regular' }],
				peerMessages: [expect.objectContaining({ messageId: 'snapshot-peer-39', messageType: 39 })]
			})
		} finally {
			db.close()
		}
	})

	it('retries contended IMMEDIATE recovery deletes', async () => {
		const dbPath = join(dir, 'busy-recovery.db')
		const blocker = new Database(dbPath)
		const writer = new Database(dbPath)
		let releaseTimer: ReturnType<typeof setTimeout> | undefined
		writer.pragma('busy_timeout = 1')
		try {
			const store = new SqliteAppStateSyncKeyStore(writer as never)
			await store.recordMissingKey(keyId, 'regular')
			const peer = await store.enqueuePeerMessage({
				messageType: 39,
				remoteJid: '5511999999999@s.whatsapp.net',
				targetDeviceJid: '5511999999999:2@s.whatsapp.net',
				messageId: 'busy-peer-39',
				timestamp: 1,
				data: encodeAppStateSyncKeyRequestData([keyId])
			})

			blocker.exec('BEGIN IMMEDIATE')
			releaseTimer = setTimeout(() => blocker.exec('COMMIT'), 5)
			await expect(store.resolveKeys([keyId])).resolves.toEqual(['regular'])

			blocker.exec('BEGIN IMMEDIATE')
			releaseTimer = setTimeout(() => blocker.exec('COMMIT'), 5)
			await expect(store.deletePeerMessages([peer.id])).resolves.toBeUndefined()
			await expect(store.listPeerMessages(39)).resolves.toEqual([])
		} finally {
			if (releaseTimer) clearTimeout(releaseTimer)
			if (blocker.inTransaction) blocker.exec('ROLLBACK')
			writer.close()
			blocker.close()
		}
	})
})
