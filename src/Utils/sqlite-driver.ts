import { closeSync, existsSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ILogger } from './logger'

export type SqliteDriverName = 'better-sqlite3' | 'node:sqlite'

export interface SqliteRunResult {
	changes: number | bigint
	lastInsertRowid: number | bigint
}

export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult
	get(...params: unknown[]): unknown
	all(...params: unknown[]): unknown[]
	iterate(...params: unknown[]): IterableIterator<unknown>
}

export interface SqliteTransaction<T extends (...args: any[]) => unknown> {
	(...args: Parameters<T>): ReturnType<T>
	default: (...args: Parameters<T>) => ReturnType<T>
	deferred: (...args: Parameters<T>) => ReturnType<T>
	immediate: (...args: Parameters<T>) => ReturnType<T>
	exclusive: (...args: Parameters<T>) => ReturnType<T>
}

export interface SqliteDatabase {
	exec(sql: string): unknown
	pragma(source: string, options?: { simple?: boolean }): unknown
	prepare(sql: string): SqliteStatement
	transaction<T extends (...args: any[]) => unknown>(fn: T): SqliteTransaction<T>
	readonly inTransaction: boolean
	close(): void
}

export type SqliteDriver = {
	name: SqliteDriverName
	open(path: string): SqliteDatabase
}

export type SqliteDriverLoaderOptions = {
	/** Prefer a driver explicitly instead of the automatic fallback order. */
	driver?: SqliteDriverName
	/**
	 * Injectable module loader for tests that simulate native-addon failures
	 * (missing package, ABI mismatch). It must resolve the same CJS/ESM surface
	 * as `better-sqlite3`.
	 */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	betterSqlite3Loader?: () => Promise<any>
}

type NodeSqliteStatement = {
	run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
	get(...params: unknown[]): unknown
	all(...params: unknown[]): unknown[]
	iterate(...params: unknown[]): IterableIterator<unknown>
	setReadBigInts?(enabled: boolean): unknown
	setAllowUnknownNamedParameters?(enabled: boolean): unknown
}

type NodeSqliteDatabase = {
	exec(sql: string): void
	prepare(sql: string): NodeSqliteStatement
	readonly isTransaction?: boolean
	close(): void
}

type NodeSqliteModule = {
	DatabaseSync: new (path: string) => NodeSqliteDatabase
}

/**
 * SQLite result codes are composed as `(primary << 8) | extension`. Node
 * exposes the extended code as `errcode`; better-sqlite3 callers in this
 * package match the symbolic primary/extension form.
 */
const SQLITE_PRIMARY_NAMES: Record<number, string> = {
	1: 'ERROR',
	2: 'INTERNAL',
	3: 'PERM',
	4: 'ABORT',
	5: 'BUSY',
	6: 'LOCKED',
	7: 'NOMEM',
	8: 'READONLY',
	9: 'INTERRUPT',
	10: 'IOERR',
	11: 'CORRUPT',
	12: 'NOTFOUND',
	13: 'FULL',
	14: 'CANTOPEN',
	15: 'PROTOCOL',
	16: 'EMPTY',
	17: 'SCHEMA',
	18: 'TOOBIG',
	19: 'CONSTRAINT',
	20: 'MISMATCH',
	21: 'MISUSE',
	22: 'NOLFS',
	23: 'AUTH',
	24: 'FORMAT',
	25: 'RANGE',
	26: 'NOTADB',
	27: 'NOTICE',
	28: 'WARNING'
}

// Extended result-code suffixes from sqlite3.h. The exact suffix is part of
// the better-sqlite3 public error contract and can select different retry
// paths (BUSY_SNAPSHOT versus BUSY_TIMEOUT, for example).
const SQLITE_EXTENSION_NAMES: Partial<Record<number, Record<number, string>>> = {
	1: { 1: 'MISSING_COLLSEQ', 2: 'RETRY', 3: 'SNAPSHOT' },
	4: { 2: 'ROLLBACK' },
	5: { 1: 'RECOVERY', 2: 'SNAPSHOT', 3: 'TIMEOUT' },
	6: { 1: 'SHAREDCACHE', 2: 'VTAB' },
	8: { 1: 'RECOVERY', 2: 'CANTLOCK', 3: 'ROLLBACK', 4: 'DBMOVED', 5: 'CANTINIT', 6: 'DIRECTORY' },
	10: {
		1: 'READ',
		2: 'SHORT_READ',
		3: 'WRITE',
		4: 'FSYNC',
		5: 'DIR_FSYNC',
		6: 'TRUNCATE',
		7: 'FSTAT',
		8: 'UNLOCK',
		9: 'RDLOCK',
		10: 'DELETE',
		11: 'BLOCKED',
		12: 'NOMEM',
		13: 'ACCESS',
		14: 'CHECKRESERVEDLOCK',
		15: 'LOCK',
		16: 'CLOSE',
		17: 'DIR_CLOSE',
		18: 'SHMOPEN',
		19: 'SHMSIZE',
		20: 'SHMLOCK',
		21: 'SHMMAP',
		22: 'SEEK',
		23: 'DELETE_NOENT',
		24: 'MMAP',
		25: 'GETTEMPPATH',
		26: 'CONVPATH',
		27: 'VNODE',
		28: 'AUTH',
		29: 'BEGIN_ATOMIC',
		30: 'COMMIT_ATOMIC',
		31: 'ROLLBACK_ATOMIC',
		32: 'DATA',
		33: 'CORRUPTFS',
		34: 'IN_PAGE'
	},
	11: { 1: 'VTAB', 2: 'SEQUENCE', 3: 'INDEX' },
	14: { 1: 'NOTEMPDIR', 2: 'ISDIR', 3: 'FULLPATH', 4: 'CONVPATH', 5: 'DIRTYWAL', 6: 'SYMLINK' },
	19: {
		1: 'CHECK',
		2: 'COMMITHOOK',
		3: 'FOREIGNKEY',
		4: 'FUNCTION',
		5: 'NOTNULL',
		6: 'PRIMARYKEY',
		7: 'TRIGGER',
		8: 'UNIQUE',
		9: 'VTAB',
		10: 'ROWID',
		11: 'PINNED',
		12: 'DATATYPE'
	},
	23: { 1: 'USER' },
	27: { 1: 'RECOVER_WAL', 2: 'RECOVER_ROLLBACK', 3: 'RBU' },
	28: { 1: 'AUTOINDEX' }
}

function primarySqliteCode(extendedCode: number): number {
	// SQLite stores the primary result code in the low 8 bits.
	return extendedCode & 0xff
}

function sqliteErrorCode(extendedCode: number): string {
	const primary = primarySqliteCode(extendedCode)
	const primaryName = SQLITE_PRIMARY_NAMES[primary]
	if (!primaryName) return `SQLITE_UNKNOWN_${extendedCode}`

	const extension = extendedCode >> 8
	if (extension === 0) return `SQLITE_${primaryName}`
	const extensionName = SQLITE_EXTENSION_NAMES[primary]?.[extension]
	return `SQLITE_${primaryName}_${extensionName ?? `EXT_${extension}`}`
}

function normalizeSqliteValue(value: unknown): unknown {
	if (Buffer.isBuffer(value)) return value
	if (value instanceof Uint8Array) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
	}

	// node:sqlite can return BigInt when setReadBigInts is enabled.
	// better-sqlite3 returns JavaScript numbers, including imprecise values
	// outside Number.MAX_SAFE_INTEGER, rather than throwing.
	if (typeof value === 'bigint') return Number(value)
	if (Array.isArray(value)) return value.map(normalizeSqliteValue)
	if (!value || typeof value !== 'object') return value

	const row: Record<string, unknown> = {}
	const source = value as Record<string, unknown>
	for (const key in source) row[key] = normalizeSqliteValue(source[key])
	return row
}

export function translateSqliteError(error: unknown): unknown {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sqliteError = error as any
	if (sqliteError?.code !== 'ERR_SQLITE_ERROR' || typeof sqliteError.errcode !== 'number') return error

	sqliteError.originalCode = sqliteError.code
	sqliteError.code = sqliteErrorCode(sqliteError.errcode)
	// Defensive: node:sqlite normally reports the extended code (for example
	// 2067 = CONSTRAINT_UNIQUE), which the table above already names. If a
	// build reports only the primary CONSTRAINT code (19), recover the suffix
	// from SQLite's own error message (best effort) so callers still get the
	// better-sqlite3 error name they already match on.
	if (sqliteError.errcode === 19 && typeof sqliteError.message === 'string') {
		const constraint = constraintCodeFromMessage(sqliteError.message)
		if (constraint) sqliteError.code = `SQLITE_CONSTRAINT_${constraint}`
	}

	return sqliteError
}

function constraintCodeFromMessage(message: string): string | undefined {
	if (/^UNIQUE constraint failed/i.test(message)) return 'UNIQUE'
	if (/PRIMARY KEY must be unique/i.test(message)) return 'PRIMARYKEY'
	if (/^NOT NULL constraint failed/i.test(message)) return 'NOTNULL'
	if (/^FOREIGN KEY constraint failed/i.test(message)) return 'FOREIGNKEY'
	if (/^CHECK constraint failed/i.test(message)) return 'CHECK'
	if (/^cannot store .+ value in .+ column/i.test(message)) return 'DATATYPE'
	return undefined
}

function skipQuotedSqlSection(sql: string, startIndex: number): number {
	const quote = sql[startIndex]
	let index = startIndex + 1

	while (index < sql.length) {
		if (sql[index] === quote) {
			if (sql[index + 1] === quote) {
				index += 2
				continue
			}

			return index + 1
		}

		index++
	}

	return index
}

const BIND_TYPE_ERROR_MESSAGE = 'SQLite3 can only bind numbers, strings, bigints, buffers, and null'

function bindTypeError(): TypeError {
	return new TypeError(BIND_TYPE_ERROR_MESSAGE)
}

/** A plain object passed as a statement argument binds named parameters. */
function isNamedBindings(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

/**
 * better-sqlite3 accepts only numbers, strings, bigints, buffers and null as
 * bound values (undefined binds NULL). node:sqlite rejects some other types
 * with a different error class and silently binds NULL for others (nested
 * arrays), so every value is checked here with the primary driver's error.
 */
function normalizeScalarBinding(value: unknown): unknown {
	if (value === undefined) return null
	if (value === null || value instanceof Uint8Array) return value
	const type = typeof value
	if (type === 'number' || type === 'string' || type === 'bigint') return value
	throw bindTypeError()
}

function stripSqlLiterals(sql: string): string {
	let output = ''
	let index = 0

	while (index < sql.length) {
		const char = sql[index]
		if (char === '-' && sql[index + 1] === '-') {
			while (index < sql.length && sql[index] !== '\n') index++
			continue
		}

		if (char === '/' && sql[index + 1] === '*') {
			index += 2
			while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++
			index = Math.min(sql.length, index + 2)
			continue
		}

		if (char === "'" || char === '"' || char === '`') {
			output += ' '
			index = skipQuotedSqlSection(sql, index)
			continue
		}

		if (char === '[') {
			let endIndex = index + 1
			while (endIndex < sql.length && sql[endIndex] !== ']') endIndex++
			output += ' '
			index = Math.min(sql.length, endIndex + 1)
			continue
		}

		output += char
		index++
	}

	return output
}

function missingNamedParameter(bindings: object, names: ReadonlySet<string>): string | undefined {
	for (const name of names) {
		if (!(name in bindings)) return name
	}

	return undefined
}

function sqlParameterShape(sql: string): { positionalParameterCount: number; namedParameterNames: Set<string> } {
	const withoutLiterals = stripSqlLiterals(sql)
	let positionalParameterCount = 0
	const namedParameterNames = new Set<string>()

	const tokenPattern = /(?:[:@$]([A-Za-z_][A-Za-z0-9_]*)|\?([0-9]*))/g
	for (const match of withoutLiterals.matchAll(tokenPattern)) {
		if (match[1]) {
			namedParameterNames.add(match[1])
			continue
		}

		// better-sqlite3 binds explicit ?NNN placeholders through its named
		// parameter path, not the anonymous variadic array.
		if (!match[2]) positionalParameterCount++
	}

	return {
		positionalParameterCount,
		namedParameterNames
	}
}

function validatePositionalParameters(positionalParameterCount: number, positionalCount: number): void {
	if (positionalCount < positionalParameterCount) throw new RangeError('Too few parameter values were provided')
	if (positionalCount > positionalParameterCount) throw new RangeError('Too many parameter values were provided')
}

class NodeSqliteDatabaseAdapter implements SqliteDatabase {
	private closed = false
	private adapterTransactionDepth = 0
	private savepointSequence = 0

	constructor(private readonly database: NodeSqliteDatabase) {
		// Match the connection defaults of better-sqlite3 (5 s busy timeout,
		// 16 MB page cache). node:sqlite opens with busy_timeout = 0, which
		// would make any PRAGMA/statement fail immediately with SQLITE_BUSY
		// while another connection briefly holds the database.
		this.pragma('busy_timeout = 5000')
		this.pragma('cache_size = -16000')
	}

	get inTransaction(): boolean {
		return this.adapterTransactionDepth > 0 || this.database.isTransaction === true
	}

	private ensureOpen(): void {
		if (this.closed) throw new TypeError('The database connection is not open')
	}

	exec(sql: string): this {
		this.ensureOpen()
		try {
			this.database.exec(sql)
			return this
		} catch (error) {
			throw translateSqliteError(error)
		}
	}

	pragma(source: string, options?: { simple?: boolean }): unknown {
		// better-sqlite3 treats PRAGMA assignments as queries too: they return
		// the resulting value when SQLite provides one (for example, WAL mode).
		this.ensureOpen()
		try {
			const statement = this.database.prepare(`PRAGMA ${source}`)
			const rows = statement.all().map(normalizeSqliteValue)
			if (!options?.simple) return rows
			const firstRow = rows[0]
			if (firstRow === undefined) return undefined
			return Object.values(firstRow as Record<string, unknown>)[0]
		} catch (error) {
			throw translateSqliteError(error)
		}
	}

	prepare(sql: string): SqliteStatement {
		this.ensureOpen()
		let statement: NodeSqliteStatement
		try {
			statement = this.database.prepare(sql)
		} catch (error) {
			throw translateSqliteError(error)
		}

		// better-sqlite3 tolerates extra named bind parameters supplied by callers.
		statement.setAllowUnknownNamedParameters?.(true)
		const parameterShape = sqlParameterShape(sql)

		// INT64 values beyond Number.MAX_SAFE_INTEGER make node:sqlite reads
		// throw ERR_OUT_OF_RANGE, while better-sqlite3 returns an imprecise
		// number. Reading every integer as BigInt costs an allocation per
		// column, so BigInt mode is enabled per statement only after the first
		// out-of-range read, and that read is repeated. Only reads are ever
		// repeated: run() never reads a column, and node:sqlite returns an
		// imprecise lastInsertRowid instead of throwing.
		let readsBigInts = false
		const enableBigIntReads = (): void => {
			if (readsBigInts || !statement.setReadBigInts) return
			statement.setReadBigInts(true)
			readsBigInts = true
		}

		const readWithBigIntFallback = <R>(read: () => R): R => {
			try {
				return read()
			} catch (error) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				if (readsBigInts || !statement.setReadBigInts || (error as any)?.code !== 'ERR_OUT_OF_RANGE') throw error
				enableBigIntReads()
				return read()
			}
		}

		const prepareBindings = (params: unknown[]): unknown[] => {
			let hasArray = false
			for (const param of params) {
				if (Array.isArray(param)) {
					hasArray = true
					break
				}
			}

			// better-sqlite3 treats a top-level array as the variadic parameter
			// list, not as one value. Avoid allocating in the primitive-only path.
			const bindings = hasArray ? params.flatMap(param => (Array.isArray(param) ? param : [param])) : params
			let needsCopy = false
			let hasNamed = false
			for (const binding of bindings) {
				if (isNamedBindings(binding)) {
					hasNamed = true
					needsCopy = true
				} else if (binding === undefined) {
					needsCopy = true
				} else if (Array.isArray(binding)) {
					// A nested array is not a bindable value (better-sqlite3 throws;
					// node:sqlite would silently bind NULL).
					throw bindTypeError()
				} else {
					normalizeScalarBinding(binding)
				}
			}

			// Named objects are validated against the named namespace, so a
			// `statement.run({...})` call is not counted as one positional value.
			if (!hasNamed) validatePositionalParameters(parameterShape.positionalParameterCount, bindings.length)
			if (!needsCopy) return bindings

			return bindings.map(binding => {
				if (!isNamedBindings(binding)) return normalizeScalarBinding(binding)

				const named: Record<string, unknown> = {}
				for (const key in binding) named[key] = normalizeScalarBinding(binding[key])
				const missing = missingNamedParameter(named, parameterShape.namedParameterNames)
				if (missing) throw new RangeError(`Missing named parameter "${missing}"`)
				return named
			})
		}

		const run = (...params: unknown[]): SqliteRunResult => {
			const bindings = prepareBindings(params)
			try {
				const result = statement.run(...bindings)
				return {
					changes: Number(result.changes),
					lastInsertRowid: Number(result.lastInsertRowid)
				}
			} catch (error) {
				throw translateSqliteError(error)
			}
		}

		const get = (...params: unknown[]): unknown => {
			const bindings = prepareBindings(params)
			try {
				return normalizeSqliteValue(readWithBigIntFallback(() => statement.get(...bindings)))
			} catch (error) {
				throw translateSqliteError(error)
			}
		}

		const all = (...params: unknown[]): unknown[] => {
			const bindings = prepareBindings(params)
			try {
				return readWithBigIntFallback(() => statement.all(...bindings)).map(normalizeSqliteValue)
			} catch (error) {
				throw translateSqliteError(error)
			}
		}

		const iterate = (...params: unknown[]): IterableIterator<unknown> => {
			const bindings = prepareBindings(params)
			// Rows already yielded cannot be re-read, so an iterated statement
			// reads BigInts from the start (sticky for this statement).
			enableBigIntReads()
			let rows: IterableIterator<unknown>
			try {
				rows = statement.iterate(...bindings)
			} catch (error) {
				throw translateSqliteError(error)
			}

			return (function* () {
				// Errors raised while stepping (e.g. SQLITE_BUSY, integer
				// overflow) surface inside the generator, after iterate() returned.
				try {
					for (const row of rows) yield normalizeSqliteValue(row)
				} catch (error) {
					throw translateSqliteError(error)
				}
			})()
		}

		return { run, get, all, iterate }
	}

	// eslint-disable-next-line space-before-function-paren
	transaction<T extends (...args: any[]) => unknown>(fn: T): SqliteTransaction<T> {
		const runTransaction = (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE', args: Parameters<T>): ReturnType<T> => {
			this.ensureOpen()
			// The database's own in_transaction state is authoritative. This
			// also makes savepoints work when a caller opened BEGIN manually.
			const isNested = this.inTransaction
			const savepoint = `baileys_sp_${++this.savepointSequence}`
			const beginStatement = isNested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`
			const commitStatement = isNested ? `RELEASE ${savepoint}` : 'COMMIT'
			const rollbackStatement = isNested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK'
			const releaseStatement = `RELEASE ${savepoint}`

			this.adapterTransactionDepth++
			try {
				this.exec(beginStatement)
				try {
					const result = fn(...args) as ReturnType<T>
					if (result && typeof (result as { then?: unknown }).then === 'function') {
						throw new TypeError('Transaction function cannot return a promise')
					}

					// Always finish the transaction this call opened. If the callback
					// already ended it (e.g. executed COMMIT itself), SQLite rejects
					// the COMMIT/RELEASE and that error surfaces, exactly as with
					// better-sqlite3.
					this.exec(commitStatement)
					return result
				} catch (error) {
					// If the transaction is already gone, the failed undo is
					// attached to the original error instead of replacing it.
					this.undoTransaction(error, rollbackStatement, isNested ? releaseStatement : undefined)

					throw error
				}
			} finally {
				this.adapterTransactionDepth--
			}
		}

		const makeTransaction = (): SqliteTransaction<T> => {
			const makeVariant = (variantMode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') =>
				((...args: Parameters<T>) => runTransaction(variantMode, args)) as SqliteTransaction<T>

			// better-sqlite3 chooses the mode independently for every variant.
			// Sharing one outer mode was the original fallback bug.
			const transaction = makeVariant('DEFERRED')
			transaction.default = makeVariant('DEFERRED')
			transaction.deferred = makeVariant('DEFERRED')
			transaction.immediate = makeVariant('IMMEDIATE')
			transaction.exclusive = makeVariant('EXCLUSIVE')
			return transaction
		}

		return makeTransaction()
	}

	private undoTransaction(error: unknown, rollbackStatement: string, releaseStatement?: string): void {
		try {
			this.exec(rollbackStatement)
			if (releaseStatement) this.exec(releaseStatement)
		} catch (rollbackError) {
			// A failing undo must never hide the application error.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(error as any).sqliteRollbackError = rollbackError
		}
	}

	close(): void {
		if (this.closed) return
		try {
			this.database.close()
			this.closed = true
		} catch (error) {
			throw translateSqliteError(error)
		}
	}
}

function normalizeDriverName(value: string): SqliteDriverName | undefined {
	const normalized = value.trim().toLowerCase()
	if (normalized === 'better-sqlite3') return 'better-sqlite3'
	if (normalized === 'node' || normalized === 'node:sqlite') return 'node:sqlite'
	return undefined
}

function requestedDriver(options?: SqliteDriverLoaderOptions): SqliteDriverName | undefined {
	const option = options?.driver ? normalizeDriverName(options.driver) : undefined
	const environment = process.env.INFINITEAPI_SQLITE_DRIVER
	const fromEnvironment = environment ? normalizeDriverName(environment) : undefined

	if (options?.driver && !option) {
		throw new TypeError(`Unsupported SQLite driver: ${options.driver}`)
	}

	if (environment && !fromEnvironment) {
		throw new TypeError(`Unsupported INFINITEAPI_SQLITE_DRIVER value: ${environment}`)
	}

	return option ?? fromEnvironment
}

async function loadBetterSqlite3(
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	loadModule: () => Promise<any> = () => import('better-sqlite3')
): Promise<SqliteDriver> {
	const module = await loadModule()
	const Database = module.default ?? module
	// Importing an ABI-mismatched native addon can succeed while constructing
	// it fails. A tiny in-memory construction probe is the only reliable check
	// before declaring this driver usable.
	const probe = new Database(':memory:')
	probe.close()
	return {
		name: 'better-sqlite3',
		open(path: string): SqliteDatabase {
			return new Database(path) as unknown as SqliteDatabase
		}
	}
}

async function loadNodeSqlite(): Promise<SqliteDriver> {
	const processWithBuiltins = process as typeof process & {
		getBuiltinModule?: (id: string) => unknown
	}
	if (typeof processWithBuiltins.getBuiltinModule !== 'function') {
		throw new Error('process.getBuiltinModule is unavailable')
	}

	const module = processWithBuiltins.getBuiltinModule('node:sqlite') as NodeSqliteModule
	if (!module?.DatabaseSync) throw new Error('node:sqlite DatabaseSync is unavailable')
	const { DatabaseSync } = module
	assertNodeSqliteCapabilities(DatabaseSync)
	const openDatabase = (path: string): NodeSqliteDatabase => {
		// Same rule and error as better-sqlite3 (lib/database.js): a named file
		// whose directory does not exist is rejected before touching SQLite.
		const filename = path.trim()
		const anonymous = filename === '' || filename === ':memory:'
		if (!anonymous && !existsSync(dirname(filename))) {
			throw new TypeError('Cannot open database because the directory does not exist')
		}

		// Node's DatabaseSync can leak the newly opened file handle until GC when
		// it throws after opening a non-SQLite file. Preflight the fixed-size
		// header so the common SQLITE_NOTADB case stays deterministic and
		// cleanup-safe, especially for the session-lock failure path.
		try {
			const descriptor = openSync(path, 'r')
			try {
				const header = Buffer.alloc(16)
				const bytes = readSync(descriptor, header, 0, header.length, 0)
				const signature = header.subarray(0, bytes).toString('latin1')
				if (bytes > 0 && signature !== 'SQLite format 3\0') {
					const error: Error & { code?: string; errcode?: number } = new Error('file is not a database')
					error.code = 'ERR_SQLITE_ERROR'
					error.errcode = 26
					throw translateSqliteError(error)
				}
			} finally {
				closeSync(descriptor)
			}
		} catch (error) {
			// Missing/unreadable files are handled by DatabaseSync itself, but the
			// explicit SQLite-header rejection must propagate.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			if ((error as any)?.code === 'SQLITE_NOTADB') throw error
		}

		try {
			return new DatabaseSync(path)
		} catch (error) {
			throw translateSqliteError(error)
		}
	}

	return {
		name: 'node:sqlite',
		open(path: string): SqliteDatabase {
			const database = openDatabase(path)
			try {
				return new NodeSqliteDatabaseAdapter(database)
			} catch (error) {
				// The adapter applies connection defaults in its constructor; a
				// failure there must not leak the already opened native handle.
				try {
					database.close()
				} catch {
					// Surface the constructor error, not the cleanup failure.
				}

				throw error
			}
		}
	}
}

/**
 * The adapter relies on `DatabaseSync.isTransaction` to detect transactions a
 * caller opened with a manual BEGIN (better-sqlite3 asks SQLite the same
 * question). It exists from Node 22.16 / 24.0; older node:sqlite builds (22.13
 * to 22.15) would silently mis-nest transactions, so they are rejected here and
 * the loader reports that no fallback is available.
 */
export function assertNodeSqliteCapabilities(DatabaseSync: NodeSqliteModule['DatabaseSync']): void {
	const probe = new DatabaseSync(':memory:')
	try {
		if (typeof probe.isTransaction !== 'boolean') {
			throw new Error('node:sqlite lacks DatabaseSync.isTransaction; the SQLite fallback requires Node >= 22.16')
		}
	} finally {
		probe.close()
	}
}

/**
 * Load the first supported SQLite driver:
 *
 *   better-sqlite3 (preferred) -> node:sqlite -> error
 *
 * `INFINITEAPI_SQLITE_DRIVER` (or `options.driver`) pins either driver.
 * Pinning disables fallback, which is useful for tests and incident triage.
 */
export async function loadSqliteDriver(logger?: ILogger, options?: SqliteDriverLoaderOptions): Promise<SqliteDriver> {
	const forced = requestedDriver(options)
	// The automatic order is the contract. Keep the primary failure available
	// even when the fallback succeeds: ABI/native-addon incidents otherwise look
	// like generic Node-version problems.
	let betterSqlite3Error: unknown

	if (forced !== 'node:sqlite') {
		try {
			const driver = await loadBetterSqlite3(options?.betterSqlite3Loader)
			logger?.debug?.({ driver: driver.name }, 'sqlite driver selected')
			return driver
		} catch (error) {
			betterSqlite3Error = error
			if (forced === 'better-sqlite3') {
				const pinnedError = new Error('better-sqlite3 is unavailable')
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				;(pinnedError as any).cause = error
				throw pinnedError
			}
		}
	}

	if (forced === 'node:sqlite') {
		try {
			const driver = await loadNodeSqlite()
			logger?.debug?.({ driver: driver.name }, 'sqlite driver selected')
			return driver
		} catch (error) {
			const pinnedError = new Error('node:sqlite is unavailable')
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(pinnedError as any).cause = error
			throw pinnedError
		}
	}

	try {
		const driver = await loadNodeSqlite()
		logger?.warn?.(
			{
				driver: driver.name,
				node: process.versions.node,
				betterSqlite3Error
			},
			'better-sqlite3 indisponível; usando o SQLite nativo do Node'
		)
		return driver
	} catch (nodeError) {
		const unavailableError = new Error(
			'Nenhum driver SQLite disponível. Instale better-sqlite3 ou use Node >= 22.16 com node:sqlite.'
		)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(unavailableError as any).cause = nodeError
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(unavailableError as any).betterSqlite3Error = betterSqlite3Error
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		;(unavailableError as any).nodeSqliteError = nodeError
		throw unavailableError
	}
}

/**
 * Open a database with the selected driver. Internal helper (not re-exported
 * from the package index) used by tests and internal callers that need a raw
 * handle without depending on better-sqlite3 typings.
 */
export async function openSqliteDatabase(
	path: string,
	logger?: ILogger,
	options?: SqliteDriverLoaderOptions
): Promise<SqliteDatabase> {
	const driver = await loadSqliteDriver(logger, options)
	return driver.open(path)
}
