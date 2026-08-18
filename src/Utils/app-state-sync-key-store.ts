import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises'
import { dirname, resolve } from 'path'
import type {
	AppStateSyncKeyStore,
	AppStateSyncKeyStoreSnapshot,
	AppStateSyncPeerMessageInput,
	AppStateSyncPeerMessageType,
	StoredAppStateSyncPeerMessage
} from '../Types'
import type { SqliteDbLike, SqliteStatementLike } from './multi-db-sqlite/types'
import { BufferJSON } from './generics'
import { makeKeyedMutex } from './make-mutex'

type MissingKeyParts = { deviceId: number; epoch: number }

export const parseAppStateSyncKeyId = (keyId: string): MissingKeyParts => {
	const bytes = Buffer.from(keyId, 'base64')
	if (bytes.length !== 6 || bytes.toString('base64') !== keyId) {
		throw new Error(`invalid app-state sync key id: ${keyId}`)
	}

	return { deviceId: bytes.readUInt32BE(0), epoch: bytes.readUInt16BE(4) }
}

export const encodeAppStateSyncKeyId = ({ deviceId, epoch }: MissingKeyParts): string => {
	const bytes = Buffer.allocUnsafe(6)
	bytes.writeUInt32BE(deviceId, 0)
	bytes.writeUInt16BE(epoch, 4)
	return bytes.toString('base64')
}

type FileState = {
	nextPeerMessageId: number
	missingKeys: Record<string, string[]>
	peerMessages: StoredAppStateSyncPeerMessage[]
}

const emptyFileState = (): FileState => ({ nextPeerMessageId: 1, missingKeys: {}, peerMessages: [] })
const fileLocks = makeKeyedMutex()

const errorCode = (error: unknown): string | undefined =>
	error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined

const unlinkIfPresent = async (path: string): Promise<void> => {
	try {
		await unlink(path)
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') throw error
	}
}

export class FileAppStateSyncKeyStore implements AppStateSyncKeyStore {
	private readonly lockKey: string

	constructor(private readonly path: string) {
		const resolved = resolve(path)
		this.lockKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
	}

	private async load(): Promise<FileState> {
		let firstError: unknown
		// The temporary file is fsync'ed and closed before the rename sequence.
		// If the process dies after primary -> backup but before tmp -> primary,
		// the tmp file is the newest complete state and must win over the backup.
		for (const candidate of [this.path, `${this.path}.tmp`, `${this.path}.bak`]) {
			try {
				const parsed = JSON.parse(await readFile(candidate, 'utf8'), BufferJSON.reviver) as Partial<FileState>
				return {
					nextPeerMessageId: parsed.nextPeerMessageId ?? 1,
					missingKeys: parsed.missingKeys ?? {},
					peerMessages: parsed.peerMessages ?? []
				}
			} catch (error) {
				if (errorCode(error) !== 'ENOENT' && firstError === undefined) firstError = error
			}
		}

		if (firstError) throw firstError
		return emptyFileState()
	}

	private async persist(state: FileState): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true })
		const temporary = `${this.path}.tmp`
		const backup = `${this.path}.bak`
		const handle = await open(temporary, 'w')
		try {
			await handle.writeFile(JSON.stringify(state, BufferJSON.replacer))
			await handle.sync()
		} finally {
			await handle.close()
		}

		let primaryExists = false
		try {
			primaryExists = (await stat(this.path)).isFile()
		} catch (error) {
			if (errorCode(error) !== 'ENOENT') throw error
		}

		if (primaryExists) {
			await unlinkIfPresent(backup)
			await rename(this.path, backup)
		}

		await rename(temporary, this.path)
	}

	private async read<T>(work: (state: FileState) => T): Promise<T> {
		return fileLocks.mutex(this.lockKey, async () => work(await this.load()))
	}

	private async mutate<T>(work: (state: FileState) => T): Promise<T> {
		return fileLocks.mutex(this.lockKey, async () => {
			const state = await this.load()
			const result = work(state)
			await this.persist(state)
			return result
		})
	}

	async recordMissingKey(keyId: string, collectionName: string): Promise<void> {
		parseAppStateSyncKeyId(keyId)
		await this.mutate(state => {
			const collections = new Set(state.missingKeys[keyId] ?? [])
			collections.add(collectionName)
			state.missingKeys[keyId] = [...collections].sort()
		})
	}

	listMissingKeyIds(): Promise<string[]> {
		return this.read(state => Object.keys(state.missingKeys).sort())
	}

	listMissingCollections(): Promise<string[]> {
		return this.read(state => [...new Set(Object.values(state.missingKeys).flat())].sort())
	}

	resolveKeys(keyIds: string[]): Promise<string[]> {
		return this.mutate(state => {
			const affected = new Set<string>()
			for (const keyId of keyIds) {
				for (const collection of state.missingKeys[keyId] ?? []) affected.add(collection)
				delete state.missingKeys[keyId]
			}

			const stillBlocked = new Set(Object.values(state.missingKeys).flat())
			return [...affected].filter(collection => !stillBlocked.has(collection)).sort()
		})
	}

	enqueuePeerMessage(input: AppStateSyncPeerMessageInput): Promise<StoredAppStateSyncPeerMessage> {
		return this.mutate(state => {
			const row: StoredAppStateSyncPeerMessage = {
				...input,
				id: String(state.nextPeerMessageId++),
				acked: false
			}
			state.peerMessages.push(row)
			return { ...row }
		})
	}

	listPeerMessages(messageType?: AppStateSyncPeerMessageType): Promise<StoredAppStateSyncPeerMessage[]> {
		return this.read(state =>
			state.peerMessages
				.filter(row =>
					messageType === undefined ? row.messageType === 38 || row.messageType === 39 : row.messageType === messageType
				)
				.map(row => ({ ...row }))
		)
	}

	listUnackedPeerMessages(): Promise<StoredAppStateSyncPeerMessage[]> {
		return this.read(state =>
			state.peerMessages
				.filter(row => (row.messageType === 38 || row.messageType === 39) && !row.acked)
				.map(row => ({ ...row }))
		)
	}

	async markPeerMessageAcked(id: string): Promise<void> {
		await this.mutate(state => {
			const row = state.peerMessages.find(candidate => candidate.id === id)
			if (row) row.acked = true
		})
	}

	async deletePeerMessages(ids: string[]): Promise<void> {
		if (!ids.length) return
		const selected = new Set(ids)
		await this.mutate(state => {
			state.peerMessages = state.peerMessages.filter(row => !selected.has(row.id))
		})
	}

	async exportState(): Promise<AppStateSyncKeyStoreSnapshot> {
		return this.read(state => ({
			missingKeys: Object.entries(state.missingKeys).flatMap(([keyId, collections]) =>
				collections.map(collectionName => ({ keyId, collectionName }))
			),
			peerMessages: state.peerMessages
				.filter(row => row.messageType === 38 || row.messageType === 39)
				.map(row => ({ ...row }))
		}))
	}

	async importState(snapshot: AppStateSyncKeyStoreSnapshot): Promise<void> {
		await this.mutate(state => {
			for (const { keyId, collectionName } of snapshot.missingKeys) {
				const collections = new Set(state.missingKeys[keyId] ?? [])
				collections.add(collectionName)
				state.missingKeys[keyId] = [...collections].sort()
			}

			const existing = new Set(state.peerMessages.map(row => row.messageId))
			for (const row of snapshot.peerMessages) {
				if (existing.has(row.messageId)) continue
				state.peerMessages.push({ ...row, id: String(state.nextPeerMessageId++), acked: row.acked })
				existing.add(row.messageId)
			}
		})
	}

	async clear(): Promise<void> {
		await fileLocks.mutex(this.lockKey, async () => {
			await unlinkIfPresent(`${this.path}.bak`)
			await unlinkIfPresent(`${this.path}.tmp`)
			await unlinkIfPresent(this.path)
		})
	}
}

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS missing_keys (
  device_id INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  collection_name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (device_id, epoch, collection_name)
);
CREATE TABLE IF NOT EXISTS peer_messages (
  _id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_type INTEGER NOT NULL DEFAULT 0,
  key_remote_jid TEXT NOT NULL DEFAULT '',
  key_from_me INTEGER,
  key_id TEXT NOT NULL DEFAULT '',
  device_id TEXT,
  timestamp INTEGER,
  data TEXT,
  acked INTEGER
);
CREATE INDEX IF NOT EXISTS peer_messages_type_idx ON peer_messages(message_type);
`

type PeerRow = {
	_id: number
	message_type: AppStateSyncPeerMessageType
	key_remote_jid: string
	key_id: string
	device_id: string
	timestamp: number
	data: string
	acked: number
}

const mapPeerRow = (row: PeerRow): StoredAppStateSyncPeerMessage => ({
	id: String(row._id),
	messageType: row.message_type,
	remoteJid: row.key_remote_jid,
	targetDeviceJid: row.device_id,
	messageId: row.key_id,
	timestamp: row.timestamp,
	data: row.data,
	acked: row.acked === 1
})

export class SqliteAppStateSyncKeyStore implements AppStateSyncKeyStore {
	private readonly stmts: Record<string, SqliteStatementLike>

	constructor(private readonly db: SqliteDbLike) {
		db.exec(SQLITE_SCHEMA)
		this.stmts = {
			insertMissing: db.prepare(
				'INSERT OR REPLACE INTO missing_keys (device_id, epoch, collection_name) VALUES (?, ?, ?)'
			),
			listMissing: db.prepare('SELECT device_id, epoch, collection_name FROM missing_keys ORDER BY device_id, epoch'),
			deleteMissing: db.prepare('DELETE FROM missing_keys WHERE device_id = ? AND epoch = ?'),
			insertPeer: db.prepare(
				'INSERT INTO peer_messages (message_type, key_remote_jid, key_from_me, key_id, device_id, timestamp, data, acked) VALUES (?, ?, 1, ?, ?, ?, ?, 0)'
			),
			listPeer: db.prepare(
				'SELECT _id, message_type, key_remote_jid, key_id, device_id, timestamp, data, acked FROM peer_messages WHERE message_type IN (38, 39) ORDER BY _id'
			),
			listPeerByType: db.prepare(
				'SELECT _id, message_type, key_remote_jid, key_id, device_id, timestamp, data, acked FROM peer_messages WHERE message_type = ? ORDER BY _id'
			),
			listUnacked: db.prepare(
				'SELECT _id, message_type, key_remote_jid, key_id, device_id, timestamp, data, acked ' +
					'FROM peer_messages WHERE message_type IN (38, 39) AND acked = 0 ORDER BY _id'
			),
			ackPeer: db.prepare('UPDATE peer_messages SET acked = 1 WHERE _id = ? AND message_type IN (38, 39)'),
			deletePeer: db.prepare('DELETE FROM peer_messages WHERE _id = ? AND message_type IN (38, 39)'),
			clearMissing: db.prepare('DELETE FROM missing_keys'),
			clearPeer: db.prepare('DELETE FROM peer_messages WHERE message_type IN (38, 39)')
		}
	}

	async recordMissingKey(keyId: string, collectionName: string): Promise<void> {
		const parts = parseAppStateSyncKeyId(keyId)
		this.stmts.insertMissing!.run(parts.deviceId, parts.epoch, collectionName)
	}

	private listMissingRows(): Array<MissingKeyParts & { collectionName: string }> {
		return (this.stmts.listMissing!.all() as Array<{ device_id: number; epoch: number; collection_name: string }>).map(
			row => ({ deviceId: row.device_id, epoch: row.epoch, collectionName: row.collection_name })
		)
	}

	async listMissingKeyIds(): Promise<string[]> {
		return [...new Set(this.listMissingRows().map(encodeAppStateSyncKeyId))].sort()
	}

	async listMissingCollections(): Promise<string[]> {
		return [...new Set(this.listMissingRows().map(row => row.collectionName))].sort()
	}

	async resolveKeys(keyIds: string[]): Promise<string[]> {
		const affected = new Set<string>()
		const remove = this.db.transaction((ids: string[]) => {
			const before = this.listMissingRows()
			for (const keyId of ids) {
				const parts = parseAppStateSyncKeyId(keyId)
				for (const row of before) {
					if (row.deviceId === parts.deviceId && row.epoch === parts.epoch) affected.add(row.collectionName)
				}

				this.stmts.deleteMissing!.run(parts.deviceId, parts.epoch)
			}
		})
		remove(keyIds)
		const stillBlocked = new Set(this.listMissingRows().map(row => row.collectionName))
		return [...affected].filter(collection => !stillBlocked.has(collection)).sort()
	}

	async enqueuePeerMessage(input: AppStateSyncPeerMessageInput): Promise<StoredAppStateSyncPeerMessage> {
		const result = this.stmts.insertPeer!.run(
			input.messageType,
			input.remoteJid,
			input.messageId,
			input.targetDeviceJid,
			input.timestamp,
			input.data
		)
		return { ...input, id: String(result.lastInsertRowid), acked: false }
	}

	async listPeerMessages(messageType?: AppStateSyncPeerMessageType): Promise<StoredAppStateSyncPeerMessage[]> {
		const rows = (
			messageType === undefined ? this.stmts.listPeer!.all() : this.stmts.listPeerByType!.all(messageType)
		) as PeerRow[]
		return rows.map(mapPeerRow)
	}

	async listUnackedPeerMessages(): Promise<StoredAppStateSyncPeerMessage[]> {
		return (this.stmts.listUnacked!.all() as PeerRow[]).map(mapPeerRow)
	}

	async markPeerMessageAcked(id: string): Promise<void> {
		this.stmts.ackPeer!.run(id)
	}

	async deletePeerMessages(ids: string[]): Promise<void> {
		if (!ids.length) return
		this.db.transaction((selected: string[]) => {
			for (const id of selected) this.stmts.deletePeer!.run(id)
		})(ids)
	}

	async exportState(): Promise<AppStateSyncKeyStoreSnapshot> {
		const missingKeys = this.listMissingRows().map(row => ({
			keyId: encodeAppStateSyncKeyId(row),
			collectionName: row.collectionName
		}))
		return { missingKeys, peerMessages: await this.listPeerMessages() }
	}

	async importState(snapshot: AppStateSyncKeyStoreSnapshot): Promise<void> {
		const tx = this.db.transaction((value: AppStateSyncKeyStoreSnapshot) => {
			for (const row of value.missingKeys) {
				const parts = parseAppStateSyncKeyId(row.keyId)
				this.stmts.insertMissing!.run(parts.deviceId, parts.epoch, row.collectionName)
			}

			const existing = new Set((this.stmts.listPeer!.all() as PeerRow[]).map(row => row.key_id))
			for (const row of value.peerMessages) {
				if (existing.has(row.messageId)) continue
				const inserted = this.stmts.insertPeer!.run(
					row.messageType,
					row.remoteJid,
					row.messageId,
					row.targetDeviceJid,
					row.timestamp,
					row.data
				)
				if (row.acked) this.stmts.ackPeer!.run(inserted.lastInsertRowid)
				existing.add(row.messageId)
			}
		})
		tx.immediate(snapshot)
	}

	async clear(): Promise<void> {
		this.db
			.transaction(() => {
				this.stmts.clearMissing!.run()
				this.stmts.clearPeer!.run()
			})
			.immediate()
	}
}
