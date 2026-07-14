/**
 * Verifies the `unordered_stanza_queue` typed mirror follows the retry
 * counter's lifetime. A held stanza is enqueued at `sendRetryRequest` (keyed
 * by message id); the row must:
 *   - SURVIVE a `tryIncrement` overwrite (dispose reason 'set' → process_count
 *     bump, not delete)
 *   - be DROPPED when the counter is removed on markRetrySuccess / markRetryFailed
 *   - be WIPED on clear() (socket close — LRUCache.clear does not fire dispose)
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import P from 'pino'
import { MessageRetryManager } from '../../Utils/message-retry-manager'
import { MultiDbSqliteStore, SignalTypedBackend } from '../../Utils/multi-db-sqlite'

const silent = P({ level: 'silent' })

describe('MessageRetryManager — unordered_stanza_queue mirror lifecycle', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: SignalTypedBackend

	const countRows = () =>
		(store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM unordered_stanza_queue').get() as { n: number }).n

	const hold = (msgId: string) => backend.enqueueUnorderedStanza({ stanzaId: msgId, stanzaPayload: Buffer.from([1]) })

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'unordered-mirror-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new SignalTypedBackend(store.handle('axolotl.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('keeps the held stanza across a tryIncrement overwrite, drops it on success', () => {
		const mgr = new MessageRetryManager(silent, 5, undefined, backend)
		mgr.tryIncrement('MSG-1') // first attempt (counter created)
		hold('MSG-1')
		expect(countRows()).toBe(1)

		// Second attempt overwrites the counter (dispose reason 'set') — the row
		// must survive so process_count can keep climbing.
		mgr.tryIncrement('MSG-1')
		expect(countRows()).toBe(1)

		// Retry resolved → counter deleted → mirror row dropped.
		mgr.markRetrySuccess('MSG-1')
		expect(countRows()).toBe(0)
	})

	it('drops the held stanza on markRetryFailed (retries exhausted)', () => {
		const mgr = new MessageRetryManager(silent, 5, undefined, backend)
		mgr.tryIncrement('MSG-2')
		hold('MSG-2')
		expect(countRows()).toBe(1)

		mgr.markRetryFailed('MSG-2')
		expect(countRows()).toBe(0)
	})

	it('wipes every held stanza on clear() (socket close)', () => {
		const mgr = new MessageRetryManager(silent, 5, undefined, backend)
		mgr.tryIncrement('MSG-A')
		mgr.tryIncrement('MSG-B')
		hold('MSG-A')
		hold('MSG-B')
		expect(countRows()).toBe(2)

		mgr.clear()
		expect(countRows()).toBe(0)
	})

	it('is a no-op without a backend (mirror is opt-in)', () => {
		const mgr = new MessageRetryManager(silent, 5)
		expect(() => {
			mgr.tryIncrement('MSG-X')
			mgr.markRetrySuccess('MSG-X')
			mgr.markRetryFailed('MSG-X')
			mgr.clear()
		}).not.toThrow()
	})
})
