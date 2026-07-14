/**
 * Startup-prune policy: transient in-flight tables are wiped every time the
 * store is opened (i.e. on process start), so a crash that skipped the owning
 * backend's teardown clear() can't leave stale rows accumulating across
 * restarts (audit #627/#628/#633). A persistent (source-of-truth) table must
 * survive the reopen — proving the prune is scoped, not a blanket wipe.
 */
import { type ChildProcess, spawn } from 'child_process'
import { writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

const LOCK_FILE = '.multi-db-sqlite.lock'

describe('MultiDbSqliteStore startup prune', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'multi-db-startup-prune-test-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const count = (store: MultiDbSqliteStore, file: Parameters<MultiDbSqliteStore['handle']>[0], table: string) =>
		(store.handle(file).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

	it('wipes transient tables on reopen but keeps persistent ones', async () => {
		// First session: seed one transient row per transient table + one
		// persistent row (jid_map, a source-of-truth mapping) as a control.
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		try {
			first
				.handle('axolotl.db')
				.prepare(
					'INSERT INTO message_base_key (msg_key_remote_jid, msg_key_from_me, msg_key_id, recipient_id, ' +
						'recipient_type, device_id, last_alice_base_key, timestamp) VALUES (?, 0, ?, ?, 0, 0, ?, ?)'
				)
				.run('a@s.whatsapp.net', 'K1', 1, Buffer.from([1]), 1_000)
			first
				.handle('axolotl.db')
				.prepare(
					'INSERT INTO unordered_stanza_queue (stanza_id, stanza_key, stanza_class, stanza_type, stanza_payload, ' +
						'time_sec, create_time_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.run('S1', Buffer.from('k1'), 0, 0, Buffer.from([1]), 1_000, 1_000_000)
			first.handle('axolotl.db').prepare('INSERT INTO preacks (ptn) VALUES (?)').run('p1')
			first.handle('media.db').prepare('INSERT INTO media_job (uuid, job_type) VALUES (?, ?)').run('U1', 1)
			first.handle('sync.db').prepare('INSERT INTO history_sync_companion (message_id) VALUES (?)').run('H1')
			// Persistent control: a jid + jid_map row (source of truth).
			first
				.handle('msgstore.db')
				.prepare("INSERT INTO jid (user, server, raw_string) VALUES ('a', 's.whatsapp.net', 'a@s.whatsapp.net')")
				.run()
			first
				.handle('msgstore.db')
				.prepare('INSERT INTO jid_map (lid_row_id, jid_row_id, sort_id) VALUES (1, 1, 1)')
				.run()

			expect(count(first, 'axolotl.db', 'message_base_key')).toBe(1)
			expect(count(first, 'media.db', 'media_job')).toBe(1)
		} finally {
			first.close()
		}

		// Second session over the SAME directory (simulates a process restart
		// after a crash that skipped teardown).
		const second = new MultiDbSqliteStore({ sessionDir: dir })
		await second.open()
		try {
			// Every transient table was wiped on open …
			expect(count(second, 'axolotl.db', 'message_base_key')).toBe(0)
			expect(count(second, 'axolotl.db', 'unordered_stanza_queue')).toBe(0)
			expect(count(second, 'axolotl.db', 'preacks')).toBe(0)
			expect(count(second, 'media.db', 'media_job')).toBe(0)
			expect(count(second, 'sync.db', 'history_sync_companion')).toBe(0)
			// … but the persistent source-of-truth row survived.
			expect(count(second, 'msgstore.db', 'jid_map')).toBe(1)
		} finally {
			second.close()
		}
	})

	// The session lock's job is CROSS-PROCESS mutual exclusion. A lock owned by a
	// different, still-live OS process must still be refused — that protection is
	// preserved.
	it('refuses a lock held by a DIFFERENT live process (cross-process protection)', async () => {
		// Spawn a real, still-alive child (a different, guaranteed-live pid — more
		// robust than process.ppid, which is 0 when the test runner is a container
		// PID 1). open() must refuse rather than steal it.
		let child: ChildProcess | undefined
		try {
			child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
			await new Promise(resolve => setTimeout(resolve, 200)) // let it come up
			expect(typeof child.pid).toBe('number')

			writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ pid: child.pid, nonce: 'someone-elses-nonce', token: 'x' }))
			const store = new MultiDbSqliteStore({ sessionDir: dir })
			await expect(store.open()).rejects.toThrow(/already owned by process/)
		} finally {
			child?.kill()
		}
	})

	// The bug this fixes: in a container the app is ALWAYS pid 1, so a stale lock
	// left by a previous (dead) incarnation carries `pid: 1` == our pid and looks
	// "alive" — which made the lock unrecoverable forever (bricking QR pairing on
	// the post-pair restart_required reconnect, and every container restart). A
	// lock with our pid but a FOREIGN nonce is a previous incarnation → recover.
	it('recovers a stale same-pid lock left by a previous incarnation (container restart)', async () => {
		writeFileSync(
			join(dir, LOCK_FILE),
			JSON.stringify({ pid: process.pid, nonce: 'previous-incarnation-nonce', token: 'x' })
		)
		const store = new MultiDbSqliteStore({ sessionDir: dir })
		await expect(store.open()).resolves.toBeUndefined() // no throw — lock recovered
		try {
			expect(count(store, 'msgstore.db', 'jid')).toBe(0) // opened & queryable
		} finally {
			store.close()
		}
	})

	// A same-PROCESS reopen (a reconnect that rebuilt the store before closing the
	// old one) must not brick either — the second open recovers (and warns). We
	// can't distinguish it from a container pid-1 stale lock, and bricking the
	// reconnect is worse than the leaked-handles hint. (This is why consumers
	// should still close() the old store on disconnect — a resource concern, not a
	// correctness one.)
	it('recovers a same-process lock so a reconnect that rebuilt the store is not bricked', async () => {
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		const second = new MultiDbSqliteStore({ sessionDir: dir })
		try {
			await expect(second.open()).resolves.toBeUndefined() // recovered, not thrown
			expect(count(second, 'msgstore.db', 'jid')).toBe(0)
		} finally {
			second.close()
			first.close()
		}
	})
})
