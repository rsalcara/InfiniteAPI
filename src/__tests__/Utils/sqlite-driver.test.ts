import { jest } from '@jest/globals'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ILogger } from '../../Utils/logger'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite/store'
import type { SqliteDriverName } from '../../Utils/sqlite-driver'
import {
	assertNodeSqliteCapabilities,
	loadSqliteDriver,
	openSqliteDatabase,
	translateSqliteError
} from '../../Utils/sqlite-driver'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const nodeMajor = Number(process.versions.node.split('.')[0])
const supportedDrivers: SqliteDriverName[] = nodeMajor >= 22 ? ['better-sqlite3', 'node:sqlite'] : ['better-sqlite3']

async function temporaryPath(filename: string): Promise<{ directory: string; path: string }> {
	const directory = await mkdtemp(join(tmpdir(), 'infiniteapi-sqlite-driver-'))
	return { directory, path: join(directory, filename) }
}

/**
 * better-sqlite3 raises its TypeError from the native addon's realm, so
 * `toThrow(new TypeError(...))` cannot match it by class inside Jest's VM.
 * Compare the observable contract instead: error name and exact message.
 */
function expectTypeError(fn: () => unknown, message: string): void {
	let thrown: unknown
	try {
		fn()
	} catch (error) {
		thrown = error
	}

	expect(thrown).toMatchObject({ name: 'TypeError', message })
}

describe('sqlite driver fallback', () => {
	it.each(supportedDrivers)('pins %s through options', async driver => {
		const loaded = await loadSqliteDriver(undefined, { driver })
		expect(loaded.name).toBe(driver)
	})

	it('rejects an unsupported pinned driver', async () => {
		await expect(
			loadSqliteDriver(undefined, {
				// The runtime boundary intentionally accepts untyped host input.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				driver: 'sqlite-javascript' as any
			})
		).rejects.toThrow(TypeError)
	})

	it.each(supportedDrivers)('%s: exposes the statement surface used by InfiniteAPI', async driver => {
		const database = (await loadSqliteDriver(undefined, { driver })).open(':memory:')

		database.exec('CREATE TABLE surface (id INTEGER PRIMARY KEY AUTOINCREMENT, payload BLOB, label TEXT)')
		const insert = database.prepare('INSERT INTO surface (payload, label) VALUES (?, ?)')
		const result = insert.run(Buffer.from([1, 2, 3, 254]), 'first')

		expect(Number(result.changes)).toBe(1)
		expect(Number(result.lastInsertRowid)).toBe(1)

		const select = database.prepare('SELECT id, payload, label FROM surface WHERE id = ?')
		const row = select.get(1) as { id: number; payload: Buffer; label: string }
		expect(Buffer.isBuffer(row.payload)).toBe(true)
		expect([...row.payload]).toEqual([1, 2, 3, 254])
		expect(row.label).toBe('first')

		expect(database.prepare('SELECT COUNT(*) AS total FROM surface').all()).toEqual([{ total: 1 }])
		expect([...database.prepare('SELECT label FROM surface').iterate()]).toEqual([{ label: 'first' }])

		database.close()
	})

	it.each(supportedDrivers)('%s: applies file pragmas and persists data', async driver => {
		const { directory, path } = await temporaryPath('driver.db')
		const database = (await loadSqliteDriver(undefined, { driver })).open(path)

		expect(database.pragma('journal_mode = WAL', { simple: true })).toBe('wal')
		database.exec('CREATE TABLE persistence (value TEXT)')
		database.prepare('INSERT INTO persistence VALUES (?)').run('kept')
		database.close()

		// WAL creates sidecar files when supported; the file itself must survive.
		expect((await readFile(path)).length).toBeGreaterThan(0)
		await rm(directory, { recursive: true, force: true })
	})

	it.each(supportedDrivers)('%s: commits and rolls back transactions', async driver => {
		const database = (await loadSqliteDriver(undefined, { driver })).open(':memory:')
		database.exec('CREATE TABLE transactions (value TEXT)')
		const insert = database.prepare('INSERT INTO transactions VALUES (?)')
		const count = () => {
			const row = database.prepare('SELECT COUNT(*) AS total FROM transactions').get() as { total: number }
			return Number(row.total)
		}

		database.transaction((value: string) => insert.run(value)).immediate('committed')
		expect(count()).toBe(1)

		const nested = database.transaction((value: string) => {
			insert.run(value)
			throw new Error('inner rollback')
		})
		expect(() => nested('discarded')).toThrow('inner rollback')

		const outer = database.transaction(() => {
			try {
				nested('discarded')
			} catch {
				// A savepoint rollback must not poison its enclosing transaction.
			}

			return count()
		})
		expect(outer()).toBe(1)

		expect(() =>
			database.transaction(() => {
				insert.run('discarded')
				throw new Error('outer rollback')
			})()
		).toThrow('outer rollback')
		expect(count()).toBe(1)

		database.close()
	})

	it('starts node:sqlite transaction variants in their own modes', async () => {
		if (nodeMajor < 22) return
		const database = await openSqliteDatabase(':memory:', undefined, { driver: 'node:sqlite' })
		const originalExec = database.exec.bind(database)
		const executed: string[] = []
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		jest.spyOn(database, 'exec' as any).mockImplementation(((sql: string) => {
			executed.push(sql)
			return originalExec(sql)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any)

		database.transaction(() => {})()
		database.transaction(() => {}).deferred()
		database.transaction(() => {}).immediate()
		database.transaction(() => {}).exclusive()

		const beginStatements = executed.filter(sql => sql.startsWith('BEGIN '))
		expect(beginStatements).toEqual(['BEGIN DEFERRED', 'BEGIN DEFERRED', 'BEGIN IMMEDIATE', 'BEGIN EXCLUSIVE'])
		database.close()
	})

	it.each(supportedDrivers)('%s: takes immediate and exclusive locks before the callback runs', async driver => {
		const { directory, path } = await temporaryPath('transaction-locks.db')
		const writer = (await loadSqliteDriver(undefined, { driver })).open(path)
		const contender = (await loadSqliteDriver(undefined, { driver })).open(path)
		contender.pragma('busy_timeout = 0', { simple: true })

		writer.exec('CREATE TABLE lock_probe (value TEXT)')
		const count = () => writer.prepare('SELECT COUNT(*) AS total FROM lock_probe').get() as { total: number }

		// IMMEDIATE and EXCLUSIVE acquire their write lock while BEGIN runs, so a
		// second connection cannot acquire its own write lock before the callback.
		for (const mode of ['immediate', 'exclusive'] as const) {
			expect(() =>
				writer
					.transaction(() => {
						contender.exec('BEGIN IMMEDIATE')
						contender.exec('ROLLBACK')
					})
					[mode]()
			).toThrow(/database is locked/i)
			expect(count()).toEqual({ total: 0 })
		}

		// The same pre-callback write acquisition succeeds under DEFERRED because
		// no lock has been taken yet. This is the behavioral distinction that an
		// in-memory commit test cannot prove.
		writer
			.transaction(() => {
				contender.exec('BEGIN IMMEDIATE')
				contender.exec('ROLLBACK')
			})
			.deferred()

		writer.close()
		contender.close()
		await rm(directory, { recursive: true, force: true })
	})

	it.each(supportedDrivers)('%s: reads large INT64 values as better-sqlite3 does', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.exec('CREATE TABLE int64_values (value INTEGER)')
		database.exec('INSERT INTO int64_values VALUES (9223372036854775807)')

		const row = database.prepare('SELECT value FROM int64_values').get() as { value: number }
		expect(row.value).toBe(9223372036854775807)
		expect(Number.isFinite(row.value)).toBe(true)
		database.close()
	})

	it.each(supportedDrivers)('%s: returns pragma values and simple values', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.pragma('user_version = 42')
		expect(database.pragma('user_version')).toEqual([{ user_version: 42 }])
		expect(database.pragma('user_version', { simple: true })).toBe(42)
		expect(database.pragma('busy_timeout', { simple: true })).toBe(5000)
		database.exec('CREATE TABLE schema_info (id INTEGER PRIMARY KEY, label TEXT, flag INTEGER)')
		const tableInfo = database.pragma('table_info(schema_info)') as Array<Record<string, unknown>>
		expect(tableInfo).toHaveLength(3)
		expect(tableInfo.map(row => row.name)).toEqual(['id', 'label', 'flag'])
		database.close()
	})

	it.each(supportedDrivers)('%s: validates positional parameters like better-sqlite3', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.exec('CREATE TABLE positional (first TEXT, second TEXT)')
		const insert = database.prepare('INSERT INTO positional VALUES (?, ?)')

		expect(() => insert.run()).toThrow('Too few parameter values were provided')
		expect(() => insert.run('one', 'two', 'three')).toThrow('Too many parameter values were provided')

		expect(database.prepare('SELECT * FROM positional').all()).toEqual([])
		expect(database.prepare('SELECT ? AS a, ? AS b').get([1, 2])).toEqual({ a: 1, b: 2 })
		database.exec('CREATE TABLE buffers (label TEXT, first_blob BLOB, second_blob BLOB)')
		expect(() => database.prepare('INSERT INTO buffers VALUES (?, ?, ?)').run('blob', Buffer.from([1, 2]))).toThrow(
			'Too few parameter values were provided'
		)
		database.exec('CREATE TABLE quoted ([c?d] TEXT)')
		database.exec('INSERT INTO quoted VALUES (NULL)')
		expect(database.prepare('SELECT [c?d] AS identifier FROM quoted').get()).toEqual({ identifier: null })
		expect(() => database.prepare('SELECT ?1 AS a, ?1 AS b').get(1)).toThrow('Too many parameter values were provided')

		let prepareError: NodeJS.ErrnoException | undefined
		try {
			database.prepare('SELECT *')
		} catch (error) {
			prepareError = error as NodeJS.ErrnoException
		}

		expect(prepareError?.code).toBe('SQLITE_ERROR')
		database.close()
	})

	it.each(supportedDrivers)('%s: exposes transaction state and supports manual transactions', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		expect(database.inTransaction).toBe(false)

		database.exec('BEGIN IMMEDIATE')
		expect(database.inTransaction).toBe(true)

		const manualTransaction = database.transaction((value: string) => {
			database.prepare('CREATE TABLE manual (value TEXT)').run()
			database.prepare('INSERT INTO manual VALUES (?)').run(value)
			return database.inTransaction
		})
		const committed = manualTransaction('kept')
		expect(committed).toBe(true)
		// A savepoint did not consume the manually opened outer transaction.
		expect(database.inTransaction).toBe(true)
		database.exec('COMMIT')
		expect(database.prepare('SELECT value FROM manual').get()).toEqual({ value: 'kept' })
		expect(database.inTransaction).toBe(false)

		database.exec('BEGIN IMMEDIATE')
		expect(() =>
			database.transaction(() => {
				throw new Error('manual rollback')
			})()
		).toThrow('manual rollback')
		database.exec('COMMIT')
		expect(database.inTransaction).toBe(false)
		database.close()
	})

	it.each(supportedDrivers)('%s: rejects async transaction callbacks without an early commit', async driver => {
		const { directory, path } = await temporaryPath('async-transaction.db')
		const database = await openSqliteDatabase(path, undefined, { driver })
		database.exec('CREATE TABLE async_transactions (value TEXT)')

		const asyncCallback = async () => {
			database.prepare('INSERT INTO async_transactions VALUES (?)').run('discarded')
		}

		expect(() => database.transaction(asyncCallback)()).toThrow(TypeError)
		expect(database.inTransaction).toBe(false)
		expect(database.prepare('SELECT COUNT(*) AS total FROM async_transactions').get()).toEqual({ total: 0 })

		database.close()
		await rm(directory, { recursive: true, force: true })
	})

	it.each(supportedDrivers)('%s: preserves errors while rolling back and binds undefined as NULL', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.exec('CREATE TABLE bindings (value TEXT)')

		expect(() =>
			database.transaction(() => {
				database.prepare('INSERT INTO bindings VALUES (?)').run('discarded')
				throw new Error('original application error')
			})()
		).toThrow('original application error')

		const result = database.prepare('INSERT INTO bindings VALUES (?)').run(undefined)
		expect(Number(result.changes)).toBe(1)
		expect(database.prepare('SELECT value FROM bindings').get()).toEqual({ value: null })
		database.close()
	})

	it('preserves the original node:sqlite error when rollback also fails', async () => {
		if (nodeMajor < 22) return
		const database = await openSqliteDatabase(':memory:', undefined, { driver: 'node:sqlite' })
		database.exec('CREATE TABLE rollback_failure (value TEXT)')
		const originalExec = database.exec.bind(database)
		const rollbackError = new Error('rollback transport failed')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const spy = jest.spyOn(database, 'exec' as any).mockImplementation(((sql: string) => {
			if (sql === 'ROLLBACK') throw rollbackError
			return originalExec(sql)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any)

		let originalError: (Error & { sqliteRollbackError?: unknown }) | undefined
		try {
			database.transaction(() => {
				database.prepare('INSERT INTO rollback_failure VALUES (?)').run('discarded')
				throw new Error('original application error')
			})()
		} catch (error) {
			originalError = error as Error & { sqliteRollbackError?: unknown }
		} finally {
			spy.mockRestore()
		}

		expect(originalError?.message).toBe('original application error')
		expect(originalError?.sqliteRollbackError).toBe(rollbackError)
		database.exec('DELETE FROM rollback_failure')
		database.close()
	})

	it.each(supportedDrivers)('%s: iterates lazily and validates named parameters', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.exec('CREATE TABLE names (value TEXT)')
		database.prepare('INSERT INTO names VALUES (?)').run('first')

		const iterator = database.prepare('SELECT value FROM names').iterate()
		expect(iterator.next()).toEqual({ done: false, value: { value: 'first' } })
		expect(iterator.next().done).toBe(true)

		const named = database.prepare('INSERT INTO names VALUES (:value)')
		expect(Number(named.run({ unrelated: 'extra', value: 'named' }).changes)).toBe(1)
		expect(() => named.run({ unrelated: 'missing' })).toThrow('Missing named parameter')
		database.close()
	})

	it.each(supportedDrivers)('%s: iterates BLOB values as Buffers', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.exec('CREATE TABLE blobs (payload BLOB)')
		database.prepare('INSERT INTO blobs VALUES (?)').run(Buffer.from([9, 254, 0]))

		const [row] = [...database.prepare('SELECT payload FROM blobs').iterate()] as [{ payload: Buffer }]
		expect(Buffer.isBuffer(row.payload)).toBe(true)
		expect([...row.payload]).toEqual([9, 254, 0])
		database.close()
	})

	it.each(supportedDrivers)('%s: uses better-sqlite3 connection defaults', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		expect(database.pragma('busy_timeout', { simple: true })).toBe(5000)
		expect(database.pragma('cache_size', { simple: true })).toBe(-16000)
		database.close()
	})

	it('closes the node driver twice without throwing', async () => {
		if (nodeMajor < 22) return
		const database = await openSqliteDatabase(':memory:', undefined, { driver: 'node:sqlite' })
		expect(() => {
			database.close()
			database.close()
		}).not.toThrow()
	})

	it('rejects a non-SQLite file before node:sqlite leaks a handle', async () => {
		if (nodeMajor < 22) return
		const { directory, path } = await temporaryPath('not-a-database.txt')
		await writeFile(path, 'definitely not SQLite', 'utf8')

		await expect(openSqliteDatabase(path, undefined, { driver: 'node:sqlite' })).rejects.toMatchObject({
			code: 'SQLITE_NOTADB',
			message: 'file is not a database'
		})
		// On Windows this is also the descriptor-leak check: an open handle would
		// make removal fail with EBUSY.
		await rm(directory, { recursive: true, force: true })
	})

	it('falls back automatically when the resolved native addon cannot be constructed', async () => {
		if (nodeMajor < 22) return
		const previousDriver = process.env.INFINITEAPI_SQLITE_DRIVER
		delete process.env.INFINITEAPI_SQLITE_DRIVER
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const warnings: any[] = []
		try {
			const logger = { warn: (obj: unknown) => warnings.push(obj) } as unknown as ILogger
			const driver = await loadSqliteDriver(logger, {
				// Module resolution succeeds; only the constructor fails. This is the
				// ABI-mismatch boundary that a require/import probe cannot catch.
				betterSqlite3Loader: async () =>
					class {
						constructor() {
							throw new Error('native addon constructor failed')
						}
					}
			})
			expect(driver.name).toBe('node:sqlite')
			const database = driver.open(':memory:')
			database.close()
			expect(warnings).toHaveLength(1)
			expect(warnings[0].betterSqlite3Error).toMatchObject({ message: 'native addon constructor failed' })
		} finally {
			if (previousDriver === undefined) delete process.env.INFINITEAPI_SQLITE_DRIVER
			else process.env.INFINITEAPI_SQLITE_DRIVER = previousDriver
		}
	})

	it('prefers a constructable better-sqlite3 addon in automatic mode', async () => {
		const previousDriver = process.env.INFINITEAPI_SQLITE_DRIVER
		delete process.env.INFINITEAPI_SQLITE_DRIVER
		try {
			const driver = await loadSqliteDriver(undefined, {
				betterSqlite3Loader: async () =>
					class {
						isProbe = true
						close(): void {}
					}
			})
			expect(driver.name).toBe('better-sqlite3')
			const database = driver.open(':memory:')
			database.close()
		} finally {
			if (previousDriver === undefined) delete process.env.INFINITEAPI_SQLITE_DRIVER
			else process.env.INFINITEAPI_SQLITE_DRIVER = previousDriver
		}
	})

	it('does not let a pinned primary driver fall back automatically', async () => {
		const primaryFailure = new Error('native addon constructor failed')
		await expect(
			loadSqliteDriver(undefined, {
				driver: 'better-sqlite3',
				betterSqlite3Loader: async () =>
					class {
						constructor() {
							throw primaryFailure
						}
					}
			})
		).rejects.toMatchObject({
			message: 'better-sqlite3 is unavailable',
			cause: primaryFailure
		})
	})

	it('rejects an invalid driver in the environment', async () => {
		const previousDriver = process.env.INFINITEAPI_SQLITE_DRIVER
		process.env.INFINITEAPI_SQLITE_DRIVER = 'sqlite-javascript'
		try {
			await expect(loadSqliteDriver()).rejects.toThrow(TypeError)
		} finally {
			if (previousDriver === undefined) delete process.env.INFINITEAPI_SQLITE_DRIVER
			else process.env.INFINITEAPI_SQLITE_DRIVER = previousDriver
		}
	})

	it('preserves exact primary and extended SQLite error names', () => {
		const makeError = (errcode: number) => {
			const error = new Error('sqlite operation failed')
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(error as any).code = 'ERR_SQLITE_ERROR'
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(error as any).errcode = errcode
			return translateSqliteError(error) as NodeJS.ErrnoException
		}

		expect(makeError((2 << 8) | 5).code).toBe('SQLITE_BUSY_SNAPSHOT')
		expect(makeError((12 << 8) | 19).code).toBe('SQLITE_CONSTRAINT_DATATYPE')
		expect(makeError((32 << 8) | 10).code).toBe('SQLITE_IOERR_DATA')
		expect(makeError(26).code).toBe('SQLITE_NOTADB')
	})

	it('falls back automatically when the better-sqlite3 addon cannot be constructed', async () => {
		if (nodeMajor < 22) return
		// A pinned driver must disable fallback. Clear the suite's CI pin locally
		// so this test exercises the real automatic selection order.
		const previousDriver = process.env.INFINITEAPI_SQLITE_DRIVER
		delete process.env.INFINITEAPI_SQLITE_DRIVER

		try {
			const driver = await loadSqliteDriver(undefined, {
				// This injects the exact failure boundary exercised by an
				// ABI-mismatched addon: module/import resolution succeeds,
				// construction does not.
				betterSqlite3Loader: async () => {
					throw new Error('native addon cannot load')
				}
			})
			expect(driver.name).toBe('node:sqlite')
			const database = driver.open(':memory:')
			expect(database.pragma('busy_timeout', { simple: true })).toBe(5000)
			database.close()
		} finally {
			if (previousDriver === undefined) delete process.env.INFINITEAPI_SQLITE_DRIVER
			else process.env.INFINITEAPI_SQLITE_DRIVER = previousDriver
		}
	})

	it.each(supportedDrivers)('%s: translates busy and constraint errors', async driver => {
		const { directory, path } = await temporaryPath('contention.db')
		const first = (await loadSqliteDriver(undefined, { driver })).open(path)
		const second = (await loadSqliteDriver(undefined, { driver })).open(path)

		for (const database of [first, second]) {
			database.pragma('busy_timeout = 0')
			database.pragma('journal_mode = WAL')
		}

		first.exec('CREATE TABLE contention (id INTEGER PRIMARY KEY, value TEXT)')
		first.exec('BEGIN IMMEDIATE')
		first.prepare('INSERT INTO contention VALUES (?, ?)').run(1, 'writer')

		const busyError = (() => {
			try {
				second.prepare('INSERT INTO contention VALUES (?, ?)').run(2, 'blocked')
				return undefined
			} catch (error) {
				return error as NodeJS.ErrnoException
			}
		})()

		expect(busyError?.code).toBe('SQLITE_BUSY')
		first.exec('ROLLBACK')

		first.prepare('INSERT INTO contention VALUES (?, ?)').run(1, 'first')
		const constraintError = (() => {
			try {
				first.prepare('INSERT INTO contention VALUES (?, ?)').run(1, 'duplicate')
				return undefined
			} catch (error) {
				return error as NodeJS.ErrnoException
			}
		})()

		expect(constraintError?.code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY')

		first.close()
		second.close()
		await rm(directory, { recursive: true, force: true })
	})

	it.each(supportedDrivers)('%s: drives useSqliteAuthState and reopens persisted credentials', async driver => {
		const { directory, path } = await temporaryPath('auth.db')
		const first = await useSqliteAuthState({ dbPath: path })
		first.state.creds.advSecretKey = `${driver}-sentinel`
		await first.saveCreds()
		first.close()

		const second = await useSqliteAuthState({ dbPath: path })
		expect(second.state.creds.advSecretKey).toBe(`${driver}-sentinel`)
		second.close()
		await rm(directory, { recursive: true, force: true })
	})

	it.each(supportedDrivers)('%s: opens MultiDbSqliteStore through the session lock', async driver => {
		const directory = await mkdtemp(join(tmpdir(), 'infiniteapi-multi-sqlite-'))
		const store = new MultiDbSqliteStore({ sessionDir: directory })

		const previousDriver = process.env.INFINITEAPI_SQLITE_DRIVER
		process.env.INFINITEAPI_SQLITE_DRIVER = driver
		try {
			await store.open()
			const credentials = store.handle('creds.db')
			expect(credentials.prepare('SELECT sqlite_version() AS version').get()).toHaveProperty('version')
			store.close()
		} finally {
			if (previousDriver === undefined) delete process.env.INFINITEAPI_SQLITE_DRIVER
			else process.env.INFINITEAPI_SQLITE_DRIVER = previousDriver
		}

		await rm(directory, { recursive: true, force: true })
	})

	it.each(supportedDrivers)('%s: validates positional Uint8Array parameters like buffers', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.exec('CREATE TABLE typed_arrays (label TEXT, payload BLOB, extra BLOB)')
		const insert = database.prepare('INSERT INTO typed_arrays VALUES (?, ?, ?)')

		expect(() => insert.run('short', new Uint8Array([1]))).toThrow('Too few parameter values were provided')
		expect(Number(insert.run('full', new Uint8Array([1]), new Uint8Array([2])).changes)).toBe(1)
		const row = database.prepare('SELECT payload FROM typed_arrays').get() as { payload: Buffer }
		expect(Buffer.isBuffer(row.payload)).toBe(true)
		database.close()
	})

	it.each(supportedDrivers)('%s: rejects unbindable values with the better-sqlite3 TypeError', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		const message = 'SQLite3 can only bind numbers, strings, bigints, buffers, and null'

		expectTypeError(() => database.prepare('SELECT ? AS value').get(true), message)
		expectTypeError(() => database.prepare('SELECT ? AS value').get([[1]]), message)
		expectTypeError(() => database.prepare('SELECT @value AS value').get({ value: false }), message)
		expectTypeError(() => database.prepare('SELECT @value AS value').get({ value: [1] }), message)
		expect(database.prepare('SELECT ? AS value').get(5n)).toEqual({ value: 5 })
		database.close()
	})

	it.each(supportedDrivers)('%s: rejects use of a closed connection with a TypeError', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.close()
		const closed = 'The database connection is not open'

		expectTypeError(() => database.prepare('SELECT 1'), closed)
		expectTypeError(() => database.exec('SELECT 1'), closed)
		expectTypeError(() => database.pragma('user_version'), closed)
	})

	it.each(supportedDrivers)('%s: rejects a database path whose directory does not exist', async driver => {
		const { directory, path } = await temporaryPath('missing-parent.db')
		const missing = join(directory, 'missing', 'nested', 'db.sqlite')
		await expect(openSqliteDatabase(missing, undefined, { driver })).rejects.toMatchObject({
			name: 'TypeError',
			message: 'Cannot open database because the directory does not exist'
		})
		// The directory itself exists, so a database directly inside it opens.
		const database = await openSqliteDatabase(path, undefined, { driver })
		database.close()
		await rm(directory, { recursive: true, force: true })
	})

	it.each(supportedDrivers)('%s: translates errors raised while iterating', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		const rows = database
			.prepare('SELECT abs(value) AS value FROM (SELECT 1 AS value UNION ALL SELECT -9223372036854775808)')
			.iterate()

		expect(rows.next()).toEqual({ done: false, value: { value: 1 } })
		let iterationError: NodeJS.ErrnoException | undefined
		try {
			rows.next()
		} catch (error) {
			iterationError = error as NodeJS.ErrnoException
		}

		expect(iterationError?.code).toBe('SQLITE_ERROR')
		expect(iterationError?.message).toBe('integer overflow')
		database.close()
	})

	it.each(supportedDrivers)('%s: reads INT64 values lazily on every read path of one statement', async driver => {
		const database = await openSqliteDatabase(':memory:', undefined, { driver })
		database.exec('CREATE TABLE int64_reads (id INTEGER PRIMARY KEY, value INTEGER)')
		database.exec('INSERT INTO int64_reads VALUES (1, 7)')
		const select = database.prepare('SELECT value FROM int64_reads ORDER BY id')

		// Safe values first: the statement must not need BigInt mode yet.
		expect(select.all()).toEqual([{ value: 7 }])
		database.exec('INSERT INTO int64_reads VALUES (2, 9223372036854775807)')
		expect(select.all()).toEqual([{ value: 7 }, { value: 9223372036854775807 }])
		expect(database.prepare('SELECT value FROM int64_reads WHERE id = 2').get()).toEqual({ value: 9223372036854775807 })
		expect([...database.prepare('SELECT value FROM int64_reads ORDER BY id').iterate()]).toEqual([
			{ value: 7 },
			{ value: 9223372036854775807 }
		])

		const insert = database.prepare('INSERT INTO int64_reads (id, value) VALUES (?, 0)')
		expect(insert.run(9007199254740993n)).toEqual({ changes: 1, lastInsertRowid: 9007199254740992 })
		database.close()
	})

	it('rejects node:sqlite builds without DatabaseSync.isTransaction', () => {
		const closed: string[] = []
		const withoutTransactionState = class {
			close(): void {
				closed.push('without')
			}
		}
		const withTransactionState = class {
			readonly isTransaction = false
			close(): void {
				closed.push('with')
			}
		}

		expect(() =>
			assertNodeSqliteCapabilities(
				withoutTransactionState as unknown as Parameters<typeof assertNodeSqliteCapabilities>[0]
			)
		).toThrow('requires Node >= 22.16')
		expect(() =>
			assertNodeSqliteCapabilities(
				withTransactionState as unknown as Parameters<typeof assertNodeSqliteCapabilities>[0]
			)
		).not.toThrow()
		// The capability probe never leaks its in-memory connection.
		expect(closed).toEqual(['without', 'with'])
	})

	it.each(supportedDrivers)('%s: applies the journal size limit and optimizes before closing', async driver => {
		const directory = await mkdtemp(join(tmpdir(), 'infiniteapi-multi-sqlite-tuning-'))
		const previousDriver = process.env.INFINITEAPI_SQLITE_DRIVER
		process.env.INFINITEAPI_SQLITE_DRIVER = driver
		try {
			const store = new MultiDbSqliteStore({ sessionDir: directory })
			await store.open()
			const credentials = store.handle('creds.db')
			expect(credentials.pragma('journal_size_limit', { simple: true })).toBe(67108864)

			const executed: string[] = []
			const originalExec = credentials.exec.bind(credentials)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			jest.spyOn(credentials, 'exec' as any).mockImplementation(((sql: string) => {
				executed.push(sql)
				return originalExec(sql)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			}) as any)
			store.close()
			expect(executed).toContain('PRAGMA optimize')

			// The single-file auth state applies the same limit (pragmas are
			// per connection, so read them from the handle it configured).
			const authHandle = await openSqliteDatabase(join(directory, 'auth.db'), undefined, { driver })
			const auth = await useSqliteAuthState({ dbPath: join(directory, 'auth.db'), database: authHandle })
			expect(authHandle.pragma('journal_size_limit', { simple: true })).toBe(67108864)
			auth.close()
			authHandle.close()
		} finally {
			if (previousDriver === undefined) delete process.env.INFINITEAPI_SQLITE_DRIVER
			else process.env.INFINITEAPI_SQLITE_DRIVER = previousDriver
		}

		await rm(directory, { recursive: true, force: true })
	})

	it('recovers the constraint suffix from the message when only the primary code is reported', () => {
		const constraintError = (message: string) =>
			translateSqliteError(Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode: 19 })) as {
				code: string
			}

		expect(constraintError('UNIQUE constraint failed: t.k').code).toBe('SQLITE_CONSTRAINT_UNIQUE')
		expect(constraintError('NOT NULL constraint failed: t.n').code).toBe('SQLITE_CONSTRAINT_NOTNULL')
		expect(constraintError('FOREIGN KEY constraint failed').code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY')
		expect(constraintError('CHECK constraint failed: positive').code).toBe('SQLITE_CONSTRAINT_CHECK')
		expect(constraintError('cannot store REAL value in INTEGER column t.v').code).toBe('SQLITE_CONSTRAINT_DATATYPE')
		expect(constraintError('some future constraint wording').code).toBe('SQLITE_CONSTRAINT')
	})
})
