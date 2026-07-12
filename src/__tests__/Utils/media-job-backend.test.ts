/**
 * `MediaJobBackend` smoke tests — the transient upload-transfer tracker in
 * `media.db`. Mirrors the mobile lifecycle: INSERT on transfer start
 * (job_type=1), DELETE by (uuid, job_type) on completion. Exercises insert +
 * read, delete, list-in-progress, and clear.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MediaJobBackend, MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

describe('MediaJobBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: MediaJobBackend

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'media-job-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new MediaJobBackend(store.handle('media.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('inserts an upload job (job_type=1) on start and reads it back', () => {
		backend.insertUpload({ uuid: 'JOB-1', createTime: 1_700_000_000, transferStartTime: 1_700_000_000 })
		const row = backend.getJob('JOB-1')
		expect(row).not.toBeNull()
		expect(row!.job_type).toBe(1)
		expect(row!.create_time).toBe(1_700_000_000)
		expect(row!.transferred_bytes).toBe(0)
		expect(row!.reupload_attempt_count).toBe(0)
		expect(backend.getJob('nope')).toBeNull()
	})

	it('deletes the job on completion by (uuid, job_type)', () => {
		backend.insertUpload({ uuid: 'JOB-2' })
		expect(backend.getJob('JOB-2')).not.toBeNull()
		expect(backend.deleteUpload('JOB-2')).toBe(true)
		expect(backend.getJob('JOB-2')).toBeNull()
		// Deleting a non-existent job is a no-op.
		expect(backend.deleteUpload('JOB-2')).toBe(false)
	})

	it('lists transfers currently in flight (transient — empty once drained)', () => {
		backend.insertUpload({ uuid: 'A' })
		backend.insertUpload({ uuid: 'B' })
		expect(
			backend
				.listInProgress()
				.map(j => j.uuid)
				.sort()
		).toEqual(['A', 'B'])

		backend.deleteUpload('A')
		expect(backend.listInProgress().map(j => j.uuid)).toEqual(['B'])

		backend.deleteUpload('B')
		expect(backend.listInProgress()).toEqual([])
	})

	it('clear wipes every in-flight row (socket close)', () => {
		backend.insertUpload({ uuid: 'A' })
		backend.insertUpload({ uuid: 'B' })
		expect(backend.listInProgress()).toHaveLength(2)
		backend.clear()
		expect(backend.listInProgress()).toEqual([])
	})
})
