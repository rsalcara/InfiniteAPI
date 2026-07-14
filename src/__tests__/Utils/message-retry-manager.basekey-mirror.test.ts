/**
 * Verifies the `message_base_key` typed mirror stays in lockstep with the
 * in-memory base-key LRU — the fix for the leak where a base key saved at
 * retry==2 that then delivered successfully (no retry>2 → deleteBaseKey never
 * fired) left an orphan row forever.
 *
 * The mirror is dropped by the LRU `dispose` hook (delete / evict / TTL) and
 * wiped on `clear()`, so the typed table is genuinely transient like the
 * mobile client's.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import P from 'pino'
import { MessageRetryManager } from '../../Utils/message-retry-manager'
import { MultiDbSqliteStore, SignalTypedBackend } from '../../Utils/multi-db-sqlite'

const silent = P({ level: 'silent' })

describe('MessageRetryManager — message_base_key mirror lifecycle', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: SignalTypedBackend

	const countRows = () =>
		(store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM message_base_key').get() as { n: number }).n

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'basekey-mirror-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new SignalTypedBackend(store.handle('axolotl.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('mirrors saveBaseKey and drops the row on deleteBaseKey (via dispose)', () => {
		const mgr = new MessageRetryManager(silent, 5, backend)
		mgr.saveBaseKey('5515991426667.0', 'MSG-1', new Uint8Array([1, 2, 3]))
		expect(countRows()).toBe(1)

		// The retry>2 path (delete). dispose drops the mirror row.
		mgr.deleteBaseKey('5515991426667.0', 'MSG-1')
		expect(countRows()).toBe(0)
	})

	it('wipes every mirror row on clear() (socket close)', () => {
		const mgr = new MessageRetryManager(silent, 5, backend)
		mgr.saveBaseKey('a.0', 'MSG-A', new Uint8Array([1]))
		mgr.saveBaseKey('b.0', 'MSG-B', new Uint8Array([2]))
		expect(countRows()).toBe(2)

		// clear() does not fire LRU dispose — the explicit wipe must run.
		mgr.clear()
		expect(countRows()).toBe(0)
	})

	it('overwriting the same key keeps a single mirror row', () => {
		const mgr = new MessageRetryManager(silent, 5, backend)
		mgr.saveBaseKey('a.0', 'MSG-A', new Uint8Array([1]))
		mgr.saveBaseKey('a.0', 'MSG-A', new Uint8Array([9]))
		expect(countRows()).toBe(1)
	})

	it('is a no-op without a backend (mirror is opt-in)', () => {
		const mgr = new MessageRetryManager(silent, 5)
		expect(() => {
			mgr.saveBaseKey('a.0', 'MSG-A', new Uint8Array([1]))
			mgr.deleteBaseKey('a.0', 'MSG-A')
			mgr.clear()
		}).not.toThrow()
	})
})
