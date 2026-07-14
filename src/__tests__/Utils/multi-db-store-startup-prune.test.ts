/**
 * Startup-prune policy: transient in-flight tables are wiped every time the
 * store is opened (i.e. on process start), so a crash that skipped the owning
 * backend's teardown clear() can't leave stale rows accumulating across
 * restarts (audit #627/#628/#633). A persistent (source-of-truth) table must
 * survive the reopen — proving the prune is scoped, not a blanket wipe.
 */
import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

const LOCK_FILE = '.multi-db-sqlite.lock'

// Standalone holder: locks the SAME lock file the store uses, via a raw
// better-sqlite3 `BEGIN EXCLUSIVE`, in a SEPARATE OS process. Signals `HELD` on
// stdout, then holds until killed. Used to prove cross-process exclusion +
// auto-release on death against a real, independent process.
const HOLDER_SCRIPT = `
const Database = require('better-sqlite3')
const db = new Database(process.env.LOCK_PATH)
db.pragma('busy_timeout = 0')
db.pragma('journal_mode = DELETE')
db.exec('BEGIN EXCLUSIVE')
process.stdout.write('HELD')
setInterval(() => {}, 100000)
`

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

	// The session lock is an OS-held EXCLUSIVE SQLite lock. While one store holds
	// it, a SECOND open on the same sessionDir must be REFUSED — no reclaim. And
	// because the refusal happens at lock acquisition, BEFORE the store opens the
	// DBs and runs its startup-prune, the first store's in-flight rows are never
	// touched (the `lock → prune` ordering, guarded by the media_job sentinel).
	it('refuses a second store and does NOT prune the first store in-flight rows', async () => {
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		first.handle('media.db').prepare('INSERT INTO media_job (uuid, job_type) VALUES (?, ?)').run('LIVE', 1)

		const second = new MultiDbSqliteStore({ sessionDir: dir })
		try {
			await expect(second.open()).rejects.toThrow(/locked by another live store/)
			// The second open never reached its prune → the first store's live
			// media_job survives.
			expect(count(first, 'media.db', 'media_job')).toBe(1)
		} finally {
			second.close()
			first.close()
		}
	})

	// The lock is released on close() (the held EXCLUSIVE transaction rolls back),
	// so a legitimate reopen — the correct reconnect flow: close() then rebuild —
	// succeeds.
	it('releases the lock on close so a reopen succeeds', async () => {
		const first = new MultiDbSqliteStore({ sessionDir: dir })
		await first.open()
		first.close()

		const second = new MultiDbSqliteStore({ sessionDir: dir })
		await expect(second.open()).resolves.toBeUndefined()
		try {
			expect(count(second, 'msgstore.db', 'jid')).toBe(0)
		} finally {
			second.close()
		}
	})

	// Legacy upgrade: a pre-upgrade build wrote a JSON pidfile at the same path.
	// Opened as a SQLite db it raises SQLITE_NOTADB. We FAIL CLOSED (throw an
	// actionable error) rather than delete it — a silent delete could drop a lock
	// a live old instance still holds, and two migrators could race on
	// delete→create. The operator removes the stale file to finish upgrading.
	it('fails closed on a legacy JSON pidfile lock (does not delete it)', async () => {
		const legacy = JSON.stringify({ pid: 1, token: 'legacy' })
		writeFileSync(join(dir, LOCK_FILE), legacy)
		const store = new MultiDbSqliteStore({ sessionDir: dir })
		await expect(store.open()).rejects.toThrow(/legacy JSON lock file/)
		// The legacy file is left intact (not silently removed).
		expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toBe(legacy)
	})

	// Cross-process exclusion + auto-release on death, against a REAL independent
	// process (raw better-sqlite3 holder). A store cannot open while the holder is
	// alive; once the holder is SIGKILLed, the kernel releases the lock and a store
	// opens cleanly — no pidfile liveness guessing.
	it('excludes another live process and recovers after its death (SIGKILL)', async () => {
		const lockPath = join(dir, LOCK_FILE)
		const holder = spawn(process.execPath, ['-e', HOLDER_SCRIPT], {
			env: { ...process.env, LOCK_PATH: lockPath },
			stdio: ['ignore', 'pipe', 'ignore']
		})
		try {
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error('holder did not signal HELD in time')), 15000)
				holder.stdout!.on('data', chunk => {
					if (String(chunk).includes('HELD')) {
						clearTimeout(t)
						resolve()
					}
				})
				holder.once('exit', () => {
					clearTimeout(t)
					reject(new Error('holder exited before acquiring the lock'))
				})
			})

			// Holder is alive and holds the lock → a store must be refused.
			const blocked = new MultiDbSqliteStore({ sessionDir: dir })
			await expect(blocked.open()).rejects.toThrow(/locked by another live store/)
			blocked.close()

			// Kill the holder abruptly; the OS releases its lock on process death.
			const exited = new Promise<void>(resolve => holder.once('exit', () => resolve()))
			holder.kill('SIGKILL')
			await exited
			await new Promise(resolve => setTimeout(resolve, 300)) // let the OS reap the fd/lock

			const recovered = new MultiDbSqliteStore({ sessionDir: dir })
			await expect(recovered.open()).resolves.toBeUndefined()
			recovered.close()
		} finally {
			holder.kill('SIGKILL')
		}
	}, 30000)
})
