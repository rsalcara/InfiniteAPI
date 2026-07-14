/**
 * `MessageMediaBackend.recordMmsThumbnail` test — the pre-download thumbnail
 * metadata mirror (`mms_thumbnail_metadata`). Confirms the columns that map
 * to proto fields are persisted, hashes are base64-encoded like the mobile
 * schema, and a payload with no thumbnail at all is skipped (no noise row).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MessageMediaBackend, MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('MessageMediaBackend — mms_thumbnail_metadata', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'media-backend-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	const row = (messageRowId: number) =>
		store
			.handle('msgstore.db')
			.prepare('SELECT * FROM mms_thumbnail_metadata WHERE message_row_id = ?')
			.get(messageRowId) as Record<string, unknown> | undefined

	it('persists thumbnail metadata with base64 hashes and transferred=0', () => {
		const backend = new MessageMediaBackend(store.handle('msgstore.db'))
		const mediaKey = Buffer.from([1, 2, 3, 4])
		const thumbSha = Buffer.from([9, 9])
		const thumbEnc = Buffer.from([8, 8])
		const micro = Buffer.from([0xff, 0xd8, 0xff])

		backend.recordMmsThumbnail({
			messageRowId: 100,
			directPath: '/v/t62.7118-24/thumb',
			mediaKey,
			mediaKeyTimestamp: 1770000000,
			thumbSha256: thumbSha,
			thumbEncSha256: thumbEnc,
			microThumbnail: micro,
			insertTimestamp: 1770000123
		})

		const r = row(100)!
		expect(r).toBeDefined()
		expect(r.direct_path).toBe('/v/t62.7118-24/thumb')
		expect(Buffer.from(r.media_key as Buffer)).toEqual(mediaKey)
		expect(r.media_key_timestamp).toBe(1770000000)
		expect(r.enc_thumb_hash).toBe(thumbEnc.toString('base64'))
		expect(r.thumb_hash).toBe(thumbSha.toString('base64'))
		expect(Buffer.from(r.micro_thumbnail as Buffer)).toEqual(micro)
		expect(r.insert_timestamp).toBe(1770000123)
		expect(r.transferred).toBe(0)
	})

	it('upserts (second write replaces the first for the same message_row_id)', () => {
		const backend = new MessageMediaBackend(store.handle('msgstore.db'))
		backend.recordMmsThumbnail({ messageRowId: 7, directPath: '/first' })
		backend.recordMmsThumbnail({ messageRowId: 7, directPath: '/second' })

		expect(row(7)!.direct_path).toBe('/second')
		const count = store
			.handle('msgstore.db')
			.prepare('SELECT COUNT(*) AS n FROM mms_thumbnail_metadata WHERE message_row_id = ?')
			.get(7) as { n: number }
		expect(count.n).toBe(1)
	})

	it('skips rows with no direct_path and no micro-thumbnail (no noise)', () => {
		const backend = new MessageMediaBackend(store.handle('msgstore.db'))
		backend.recordMmsThumbnail({ messageRowId: 42, mediaKeyTimestamp: 123 })
		expect(row(42)).toBeUndefined()
	})
})
