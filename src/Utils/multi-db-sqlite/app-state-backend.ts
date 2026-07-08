/**
 * Phase 9.7 — typed app-state sync storage backed by `sync.db`.
 *
 * Replaces the multi-file blob storage with the canonical mobile schema:
 *
 *   - `collection_versions` — one row per collection (regular, critical,
 *     etc.) with `version` (monotonic counter), `lt_hash` (LT-Hash digest
 *     of the collection contents), and `dirty_version` (sentinel for
 *     dirty-bit set during a resync attempt). Live capture confirms
 *     `dirty_version` holds an optimistic local high-water mark and
 *     `version` only advances on server-confirmed LT-Hash patches — since
 *     this gateway only ever processes confirmed patches/snapshots (no
 *     local-first mutation queue yet), writes here always report -1
 *     ("converged", the schema's own default), never a pending dirty value.
 *   - `syncd_mutations` — committed mutations log, ordered by `_id`.
 *     `mutation_index` is UNIQUE on the real mobile schema, and app-state
 *     actions are a replace-by-index CRDT (mute then unmute the same chat
 *     resyncs to the SAME index with a newer value) — `insertMutation` is
 *     an upsert to match.
 *   - `pending_mutations` — uncommitted mutations awaiting server ACK.
 *   - `peer_messages` — DSM/app-state peer events. Confirmed via live Frida
 *     capture: `message_type=38` is `appStateSyncKeyShare`, `data` is a JSON
 *     string `{appStateSyncKeyShareProtoString, isNewlyGeneratedKey}` (base64
 *     proto + flag), not a raw blob. Real Android treats this as transient
 *     staging (insert, then delete once fully processed) with no declared
 *     schema trigger — cleanup is application code, mirrored here as an
 *     explicit `deletePeerMessage` call rather than an implicit one.
 *
 * Column names match the canonical schema verbatim.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

/** Confirmed via live Frida capture against a real paired session — not inferred. */
export const PEER_MESSAGE_TYPE_APP_STATE_SYNC_KEY_SHARE = 38

export type CollectionVersionRow = {
	collectionName: string
	version: number
	ltHash?: Buffer | null
	dirtyVersion: number
}

export type SyncdMutationRow = {
	id: number
	mutationIndex: string
	mutationValue?: Buffer | null
	mutationVersion: number
	collectionName: string
	areDependenciesMissing: number
	mutationMac?: Buffer | null
	deviceId: number
	epoch: number
	chatJid?: string | null
	mutationName?: string | null
}

export type PeerMessageRow = {
	id: number
	messageType: number
	keyRemoteJid: string
	keyFromMe: number
	keyId: string
	deviceId?: string | null
	timestamp: number
	data?: string | null
	acked: number
}

export class AppStateBackend {
	private readonly stmts: {
		upsertCollectionVersion: SqliteStatementLike
		selectCollectionVersion: SqliteStatementLike
		listCollectionVersions: SqliteStatementLike
		insertSyncdMutation: SqliteStatementLike
		selectMutationsByCollection: SqliteStatementLike
		selectMutationsByVersionRange: SqliteStatementLike
		deleteMutationsByCollection: SqliteStatementLike
		insertPeerMessage: SqliteStatementLike
		ackPeerMessage: SqliteStatementLike
		deletePeerMessage: SqliteStatementLike
		listUnackedPeerMessages: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			upsertCollectionVersion: this.db.prepare(
				'INSERT INTO collection_versions (collection_name, version, lt_hash, dirty_version) ' +
					'VALUES (?, ?, ?, ?) ' +
					'ON CONFLICT(collection_name) DO UPDATE SET ' +
					'  version = excluded.version, lt_hash = excluded.lt_hash, dirty_version = excluded.dirty_version'
			),
			selectCollectionVersion: this.db.prepare(
				'SELECT collection_name, version, lt_hash, dirty_version FROM collection_versions ' +
					'WHERE collection_name = ?'
			),
			listCollectionVersions: this.db.prepare(
				'SELECT collection_name, version, lt_hash, dirty_version FROM collection_versions'
			),
			// `mutation_index` is UNIQUE on the real mobile schema (verified via
			// Frida dump) — app-state actions are a replace-by-index CRDT (e.g.
			// mute then unmute the same chat resyncs to the SAME index with a
			// newer value), so a later mutation for an already-seen index is the
			// normal case, not a conflict. ON CONFLICT DO UPDATE mirrors that
			// replace semantics instead of throwing SQLITE_CONSTRAINT.
			insertSyncdMutation: this.db.prepare(
				'INSERT INTO syncd_mutations (mutation_index, mutation_value, mutation_version, collection_name, ' +
					'are_dependencies_missing, mutation_mac, device_id, epoch, chat_jid, mutation_name) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(mutation_index) DO UPDATE SET ' +
					'  mutation_value = excluded.mutation_value, mutation_version = excluded.mutation_version, ' +
					'  collection_name = excluded.collection_name, are_dependencies_missing = excluded.are_dependencies_missing, ' +
					'  mutation_mac = excluded.mutation_mac, device_id = excluded.device_id, epoch = excluded.epoch, ' +
					'  chat_jid = excluded.chat_jid, mutation_name = excluded.mutation_name'
			),
			selectMutationsByCollection: this.db.prepare(
				'SELECT _id, mutation_index, mutation_value, mutation_version, collection_name, ' +
					'are_dependencies_missing, mutation_mac, device_id, epoch, chat_jid, mutation_name ' +
					'FROM syncd_mutations WHERE collection_name = ? ORDER BY _id ASC'
			),
			selectMutationsByVersionRange: this.db.prepare(
				'SELECT _id, mutation_index, mutation_value, mutation_version, collection_name, ' +
					'are_dependencies_missing, mutation_mac, device_id, epoch, chat_jid, mutation_name ' +
					'FROM syncd_mutations WHERE collection_name = ? AND mutation_version > ? ' +
					'ORDER BY mutation_version ASC'
			),
			deleteMutationsByCollection: this.db.prepare('DELETE FROM syncd_mutations WHERE collection_name = ?'),
			insertPeerMessage: this.db.prepare(
				'INSERT INTO peer_messages (message_type, key_remote_jid, key_from_me, key_id, device_id, timestamp, data, acked) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
			),
			ackPeerMessage: this.db.prepare('UPDATE peer_messages SET acked = 1 WHERE _id = ?'),
			deletePeerMessage: this.db.prepare('DELETE FROM peer_messages WHERE _id = ?'),
			listUnackedPeerMessages: this.db.prepare(
				'SELECT _id, message_type, key_remote_jid, key_from_me, key_id, device_id, timestamp, data, acked ' +
					'FROM peer_messages WHERE acked = 0 ORDER BY _id ASC'
			)
		}
	}

	setCollectionVersion(row: CollectionVersionRow): void {
		this.stmts.upsertCollectionVersion.run(row.collectionName, row.version, row.ltHash ?? null, row.dirtyVersion)
	}

	getCollectionVersion(collectionName: string): CollectionVersionRow | null {
		const r = this.stmts.selectCollectionVersion.get(collectionName) as
			| {
					collection_name: string
					version: number
					lt_hash: Buffer | null
					dirty_version: number
			  }
			| undefined
		if (!r) return null
		return {
			collectionName: r.collection_name,
			version: r.version,
			ltHash: r.lt_hash,
			dirtyVersion: r.dirty_version
		}
	}

	listCollectionVersions(): CollectionVersionRow[] {
		const rows = this.stmts.listCollectionVersions.all() as Array<{
			collection_name: string
			version: number
			lt_hash: Buffer | null
			dirty_version: number
		}>
		return rows.map(r => ({
			collectionName: r.collection_name,
			version: r.version,
			ltHash: r.lt_hash,
			dirtyVersion: r.dirty_version
		}))
	}

	insertMutation(row: Omit<SyncdMutationRow, 'id'>): number {
		const res = this.stmts.insertSyncdMutation.run(
			row.mutationIndex,
			row.mutationValue ?? null,
			row.mutationVersion,
			row.collectionName,
			row.areDependenciesMissing,
			row.mutationMac ?? null,
			row.deviceId,
			row.epoch,
			row.chatJid ?? null,
			row.mutationName ?? null
		)
		return Number(res.lastInsertRowid)
	}

	listMutations(collectionName: string): SyncdMutationRow[] {
		const rows = this.stmts.selectMutationsByCollection.all(collectionName) as Array<RawMutationRow>
		return rows.map(mapMutationRow)
	}

	listMutationsSince(collectionName: string, sinceVersion: number): SyncdMutationRow[] {
		const rows = this.stmts.selectMutationsByVersionRange.all(collectionName, sinceVersion) as Array<RawMutationRow>
		return rows.map(mapMutationRow)
	}

	clearCollection(collectionName: string): number {
		const r = this.stmts.deleteMutationsByCollection.run(collectionName)
		return r.changes
	}

	/**
	 * Record a peer-message event (DSM / app-state peer traffic). Returns the
	 * new row's `_id` — pass it to `ackPeerMessage`/`deletePeerMessage` for the
	 * insert → ack → delete lifecycle real Android exercises (transient
	 * staging, no declared cleanup trigger).
	 */
	recordPeerMessage(row: Omit<PeerMessageRow, 'id'>): number {
		const res = this.stmts.insertPeerMessage.run(
			row.messageType,
			row.keyRemoteJid,
			row.keyFromMe,
			row.keyId,
			row.deviceId ?? null,
			row.timestamp,
			row.data ?? null,
			row.acked
		)
		return Number(res.lastInsertRowid)
	}

	ackPeerMessage(id: number): void {
		this.stmts.ackPeerMessage.run(id)
	}

	deletePeerMessage(id: number): void {
		this.stmts.deletePeerMessage.run(id)
	}

	listUnackedPeerMessages(): PeerMessageRow[] {
		const rows = this.stmts.listUnackedPeerMessages.all() as Array<{
			_id: number
			message_type: number
			key_remote_jid: string
			key_from_me: number
			key_id: string
			device_id: string | null
			timestamp: number
			data: string | null
			acked: number
		}>
		return rows.map(r => ({
			id: r._id,
			messageType: r.message_type,
			keyRemoteJid: r.key_remote_jid,
			keyFromMe: r.key_from_me,
			keyId: r.key_id,
			deviceId: r.device_id,
			timestamp: r.timestamp,
			data: r.data,
			acked: r.acked
		}))
	}
}

type RawMutationRow = {
	_id: number
	mutation_index: string
	mutation_value: Buffer | null
	mutation_version: number
	collection_name: string
	are_dependencies_missing: number
	mutation_mac: Buffer | null
	device_id: number
	epoch: number
	chat_jid: string | null
	mutation_name: string | null
}

function mapMutationRow(r: RawMutationRow): SyncdMutationRow {
	return {
		id: r._id,
		mutationIndex: r.mutation_index,
		mutationValue: r.mutation_value,
		mutationVersion: r.mutation_version,
		collectionName: r.collection_name,
		areDependenciesMissing: r.are_dependencies_missing,
		mutationMac: r.mutation_mac,
		deviceId: r.device_id,
		epoch: r.epoch,
		chatJid: r.chat_jid,
		mutationName: r.mutation_name
	}
}
