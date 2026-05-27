/**
 * Phase 9.7 — typed app-state sync storage backed by `sync.db`.
 *
 * Replaces the multi-file blob storage with the canonical mobile schema:
 *
 *   - `collection_versions` — one row per collection (regular, critical,
 *     etc.) with `version` (monotonic counter), `lt_hash` (LT-Hash digest
 *     of the collection contents), and `dirty_version` (sentinel for
 *     dirty-bit set during a resync attempt).
 *   - `syncd_mutations` — committed mutations log, ordered by `_id`. The
 *     gateway replays from this table when a peer device requests an
 *     incremental sync.
 *   - `pending_mutations` — uncommitted mutations awaiting server ACK.
 *
 * Column names match the canonical schema verbatim.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

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

export class AppStateBackend {
	private readonly stmts: {
		upsertCollectionVersion: SqliteStatementLike
		selectCollectionVersion: SqliteStatementLike
		listCollectionVersions: SqliteStatementLike
		insertSyncdMutation: SqliteStatementLike
		selectMutationsByCollection: SqliteStatementLike
		selectMutationsByVersionRange: SqliteStatementLike
		deleteMutationsByCollection: SqliteStatementLike
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
			insertSyncdMutation: this.db.prepare(
				'INSERT INTO syncd_mutations (mutation_index, mutation_value, mutation_version, collection_name, ' +
					'are_dependencies_missing, mutation_mac, device_id, epoch, chat_jid, mutation_name) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
			deleteMutationsByCollection: this.db.prepare('DELETE FROM syncd_mutations WHERE collection_name = ?')
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
