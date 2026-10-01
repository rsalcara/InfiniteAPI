/**
 * Benchmark for audit S-02 / S-05 / S-12 (PR-04). Not part of the test suite.
 *
 *   npx tsx scripts/bench/sqlite-app-pragmas.ts [messages=300000] [driver=better-sqlite3|node:sqlite]
 *
 * 1. cache_size: a msgstore.db with N messages spread over 5 large groups
 *    (real schema), then, in a fresh process per configuration, live inserts
 *    (one transaction each), status updates by key_id, and lookups by key_id
 *    (recent and uniformly random), with 512 KiB vs 2000 KiB of page cache.
 *    RSS growth after the workload shows how much of the cap is really used.
 * 2. Single-file auth state (useSqliteAuthState): signal_keys with 50k
 *    sessions/sender keys, reads and upserts with 16000 KiB (current driver
 *    default) vs 2000 KiB (the app value for the key store).
 * 3. signal_kv write cost with and without the duplicate `type` index.
 * 4. secure_delete cost on deletes.
 */
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { SCHEMAS } from '../../src/Utils/multi-db-sqlite/schemas'
import { loadSqliteDriver, type SqliteDatabase, type SqliteDriverName } from '../../src/Utils/sqlite-driver'

const BASE_PRAGMAS = ['journal_mode = WAL', 'synchronous = NORMAL', 'mmap_size = 0', 'secure_delete = ON']
const GROUPS = 5
const PARTICIPANTS = 1000
const LIVE = 20_000
const LOOKUPS = 50_000
const RUNS = 5

const keyId = () => '3EB0' + randomBytes(10).toString('hex').toUpperCase()
const text = () => randomBytes(60).toString('base64')
const time = (fn: () => void) => {
	const start = process.hrtime.bigint()
	fn()
	return Number(process.hrtime.bigint() - start) / 1e6
}

const open = async (driverName: SqliteDriverName, path: string, cacheKiB: number) => {
	const driver = await loadSqliteDriver({ driver: driverName })
	const db = driver.open(path)
	for (const pragma of BASE_PRAGMAS) db.pragma(pragma)
	db.pragma(`cache_size = -${cacheKiB}`)
	return db
}

const insertMessage = (db: SqliteDatabase) =>
	db.prepare(
		`INSERT INTO message (chat_row_id, from_me, key_id, sender_jid_row_id, status, timestamp, message_type, text_data, sort_id)
		 VALUES (?, 0, ?, ?, 0, ?, 0, ?, ?)`
	)

async function seed(driverName: SqliteDriverName, path: string, messages: number) {
	const db = await open(driverName, path, 2000)
	db.exec(SCHEMAS['msgstore.db'])
	const insert = insertMessage(db)
	const batch = db.transaction((from: number, to: number) => {
		for (let i = from; i < to; i++) {
			insert.run(1 + (i % GROUPS), keyId(), 1 + (i % PARTICIPANTS), 1_700_000_000_000 + i * 1000, text(), i)
		}
	})
	for (let i = 0; i < messages; i += 10_000) batch(i, Math.min(messages, i + 10_000))
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
	db.close()
}

async function measureCache(driverName: SqliteDriverName, path: string, cacheKiB: number) {
	const db = await open(driverName, path, cacheKiB)
	const keys = (db.prepare('SELECT key_id FROM message ORDER BY _id').all() as Array<{ key_id: string }>).map(
		row => row.key_id
	)
	if (global.gc) global.gc()
	const rssBefore = process.memoryUsage().rss

	const insert = insertMessage(db)
	const base = keys.length
	const liveMs = time(() => {
		for (let i = 0; i < LIVE; i++) {
			db.transaction(() =>
				insert.run(1 + (i % GROUPS), keyId(), 1 + (i % PARTICIPANTS), 1_800_000_000_000 + i, text(), base + i)
			)()
		}
	})

	const update = db.prepare('UPDATE message SET status = ? WHERE key_id = ?')
	const recent = keys.slice(-10_000)
	const updateMs = time(() => {
		for (let i = 0; i < LIVE; i++) db.transaction(() => update.run(5, recent[i % recent.length]))()
	})

	const lookup = db.prepare('SELECT _id, chat_row_id, status FROM message WHERE key_id = ?')
	const recentLookupMs = time(() => {
		for (let i = 0; i < LOOKUPS; i++) lookup.get(recent[(i * 7919) % recent.length])
	})
	const randomLookupMs = time(() => {
		for (let i = 0; i < LOOKUPS; i++) lookup.get(keys[Math.floor(Math.random() * keys.length)])
	})

	const rssGrowthMiB = (process.memoryUsage().rss - rssBefore) / 1024 / 1024
	db.close()
	return {
		liveInsertPerSec: Math.round(LIVE / (liveMs / 1000)),
		statusUpdatePerSec: Math.round(LIVE / (updateMs / 1000)),
		recentLookupPerSec: Math.round(LOOKUPS / (recentLookupMs / 1000)),
		randomLookupPerSec: Math.round(LOOKUPS / (randomLookupMs / 1000)),
		rssGrowthMiB: Math.round(rssGrowthMiB * 10) / 10
	}
}

async function measureKeys(driverName: SqliteDriverName, path: string, cacheKiB: number) {
	const db = await open(driverName, path, cacheKiB)
	const ids = db.prepare('SELECT type, id FROM signal_keys').all() as Array<{ type: string; id: string }>
	if (global.gc) global.gc()
	const rssBefore = process.memoryUsage().rss
	const read = db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?')
	const upsert = db.prepare(
		'INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'
	)
	const value = randomBytes(1500).toString('base64')
	// Group fan-out: a burst of session reads for consecutive participants, then a write each.
	const readMs = time(() => {
		for (let i = 0; i < LOOKUPS; i++) {
			const key = ids[Math.floor(Math.random() * ids.length)]!
			read.get(key.type, key.id)
		}
	})
	const upsertMs = time(() => {
		for (let i = 0; i < LIVE; i++) {
			const key = ids[Math.floor(Math.random() * ids.length)]!
			db.transaction(() => upsert.run(key.type, key.id, value))()
		}
	})
	const rssGrowthMiB = (process.memoryUsage().rss - rssBefore) / 1024 / 1024
	db.close()
	return {
		randomReadPerSec: Math.round(LOOKUPS / (readMs / 1000)),
		upsertPerSec: Math.round(LIVE / (upsertMs / 1000)),
		rssGrowthMiB: Math.round(rssGrowthMiB * 10) / 10
	}
}

async function seedKeys(driverName: SqliteDriverName, path: string, keys: number) {
	const db = await open(driverName, path, 2000)
	db.exec(
		'CREATE TABLE signal_keys (type TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (type, id))'
	)
	const insert = db.prepare('INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?)')
	const types = ['session', 'sender-key', 'pre-key', 'identity-key']
	db.transaction(() => {
		for (let i = 0; i < keys; i++)
			insert.run(types[i % types.length], `${100_000_000 + i}.0`, randomBytes(1500).toString('base64'))
	})()
	db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
	db.close()
}

async function measureIndex(driverName: SqliteDriverName, dir: string, withIndex: boolean) {
	const path = join(dir, `signal-kv-${withIndex ? 'idx' : 'noidx'}-${process.pid}.db`)
	const db = await open(driverName, path, 2000)
	db.exec('CREATE TABLE signal_kv (type TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (type, id))')
	if (withIndex) db.exec('CREATE INDEX signal_kv_by_type ON signal_kv(type)')
	const upsert = db.prepare(
		'INSERT INTO signal_kv (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'
	)
	const types = ['session', 'pre-key', 'sender-key', 'identity-key', 'lid-mapping']
	const value = randomBytes(1500).toString('base64')
	const ids = Array.from({ length: 20_000 }, (_, i) => `${100_000_000 + i}.0`)
	const ms = time(() => {
		for (let i = 0; i < 50_000; i++)
			db.transaction(() => upsert.run(types[i % types.length], ids[i % ids.length], value))()
	})
	db.close()
	rmSync(path, { force: true })
	rmSync(`${path}-wal`, { force: true })
	rmSync(`${path}-shm`, { force: true })
	return Math.round(50_000 / (ms / 1000))
}

async function measureSecureDelete(driverName: SqliteDriverName, dir: string, on: boolean) {
	const path = join(dir, `delete-${on ? 'on' : 'off'}-${process.pid}.db`)
	const db = await open(driverName, path, 2000)
	db.pragma(`secure_delete = ${on ? 'ON' : 'OFF'}`)
	db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
	const insert = db.prepare('INSERT INTO t (value) VALUES (?)')
	const value = randomBytes(1500).toString('base64')
	db.transaction(() => {
		for (let i = 0; i < 50_000; i++) insert.run(value)
	})()
	const del = db.prepare('DELETE FROM t WHERE id = ?')
	const ms = time(() => {
		for (let i = 1; i <= 20_000; i++) db.transaction(() => del.run(i))()
	})
	db.close()
	for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
	return Math.round(20_000 / (ms / 1000))
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

async function child(args: string[]) {
	const [mode, driverName, target, option] = args as [string, SqliteDriverName, string, string]
	let result: unknown
	if (mode === 'cache') result = await measureCache(driverName, target, Number(option))
	else if (mode === 'keys') result = await measureKeys(driverName, target, Number(option))
	else if (mode === 'index') result = await measureIndex(driverName, target, option === 'true')
	else result = await measureSecureDelete(driverName, target, option === 'true')
	process.stdout.write(JSON.stringify(result))
}

async function main() {
	const messages = Number(process.argv[2] ?? 300_000)
	const driverName = (process.argv[3] ?? 'better-sqlite3') as SqliteDriverName
	const self = fileURLToPath(import.meta.url)
	// Each measurement mutates its database, so every child gets its own copy
	// of the checkpointed seed: all configurations read identical data.
	let copies = 0
	const fresh = (seedPath: string) => {
		const copy = join(dir, `copy-${copies++}.db`)
		copyFileSync(seedPath, copy)
		return copy
	}

	const dropCopy = (copy: string) => {
		for (const suffix of ['', '-wal', '-shm']) rmSync(`${copy}${suffix}`, { force: true })
	}

	const runOn = (mode: string, seedPath: string, option: string) => {
		const copy = fresh(seedPath)
		try {
			return run(mode, driverName, copy, option)
		} finally {
			dropCopy(copy)
		}
	}

	const run = (...args: string[]) =>
		JSON.parse(
			execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', self, '--child', ...args], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'inherit']
			})
		)

	const dir = mkdtempSync(join(tmpdir(), 'bench-sqlite-pragmas-'))
	try {
		const path = join(dir, 'msgstore.db')
		const seedStart = Date.now()
		await seed(driverName, path, messages)
		console.log(
			`driver ${driverName}; seeded ${messages} messages in ${((Date.now() - seedStart) / 1000).toFixed(1)} s`
		)

		console.log('\n== cache_size (median of %d runs, fresh process each) ==', RUNS)
		const results: Record<string, Array<Record<string, number>>> = { '512': [], '2000': [] }
		for (let r = 0; r < RUNS; r++) {
			// Alternate the order so neither configuration always runs second.
			const order = r % 2 === 0 ? ['512', '2000'] : ['2000', '512']
			for (const kib of order) results[kib]!.push(runOn('cache', path, kib))
		}

		const rows = Object.keys(results['512']![0]!).map(metric => ({
			metric,
			'512 KiB': median(results['512']!.map(r => r[metric]!)),
			'2000 KiB': median(results['2000']!.map(r => r[metric]!))
		}))
		console.table(rows)

		console.log('\n== single-file auth state: signal_keys with 50000 keys (median of %d) ==', RUNS)
		const keysPath = join(dir, 'auth.db')
		await seedKeys(driverName, keysPath, 50_000)
		const keyResults: Record<string, Array<Record<string, number>>> = { '16000': [], '2000': [] }
		for (let r = 0; r < RUNS; r++) {
			const order = r % 2 === 0 ? ['16000', '2000'] : ['2000', '16000']
			for (const kib of order) keyResults[kib]!.push(runOn('keys', keysPath, kib))
		}

		console.table(
			Object.keys(keyResults['2000']![0]!).map(metric => ({
				metric,
				'16000 KiB': median(keyResults['16000']!.map(r => r[metric]!)),
				'2000 KiB': median(keyResults['2000']!.map(r => r[metric]!))
			}))
		)

		console.log('\n== signal_kv upserts/s (median of %d) ==', RUNS)
		const withIdx = median(Array.from({ length: RUNS }, () => run('index', driverName, dir, 'true')))
		const withoutIdx = median(Array.from({ length: RUNS }, () => run('index', driverName, dir, 'false')))
		console.table([{ 'with signal_kv_by_type': withIdx, without: withoutIdx }])

		console.log('\n== deletes/s with secure_delete (median of %d) ==', RUNS)
		const off = median(Array.from({ length: RUNS }, () => run('delete', driverName, dir, 'false')))
		const on = median(Array.from({ length: RUNS }, () => run('delete', driverName, dir, 'true')))
		console.table([{ OFF: off, ON: on }])
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

if (process.argv[2] === '--child') await child(process.argv.slice(3))
else await main()
