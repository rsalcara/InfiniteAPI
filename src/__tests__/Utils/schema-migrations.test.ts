import { type Migration, runMigrations } from '../../Utils/multi-db-sqlite/schema-migrations'
import type { SqliteDbLike, SqliteStatementLike } from '../../Utils/multi-db-sqlite/types'

const runResult = { changes: 1, lastInsertRowid: 1 }
const statement = (overrides: Partial<SqliteStatementLike> = {}): SqliteStatementLike => ({
	run: () => runResult,
	get: () => undefined,
	all: () => [],
	*iterate() {},
	...overrides
})

describe('runMigrations concurrency', () => {
	it('re-checks the version after acquiring the IMMEDIATE lock', () => {
		const applied = new Set<number>()
		const executedSql: string[] = []
		let outerReadCompleted = false

		const db = {
			prepare: (sql: string) => {
				if (sql === 'SELECT version FROM schema_migrations ORDER BY version ASC') {
					return statement({
						all: () => {
							outerReadCompleted = true
							return []
						}
					})
				}

				if (sql === 'SELECT version FROM schema_migrations WHERE version = ?') {
					return statement({
						get: (...params: unknown[]) => {
							const version = params[0] as number
							return applied.has(version) ? { version } : undefined
						}
					})
				}

				if (sql.startsWith('INSERT INTO schema_migrations')) {
					return statement({
						run: (...params: unknown[]) => {
							const version = params[0] as number
							if (applied.has(version)) throw new Error('UNIQUE constraint failed: schema_migrations.version')
							applied.add(version)
							return runResult
						}
					})
				}

				throw new Error(`unexpected statement: ${sql}`)
			},
			exec: (sql: string) => {
				executedSql.push(sql)
				return db
			},
			transaction: (fn: () => void) => {
				const immediate = () => {
					expect(outerReadCompleted).toBe(true)
					// Simulate another process committing v1 while this caller waited
					// for the IMMEDIATE writer lock.
					applied.add(1)
					fn()
				}

				return Object.assign(fn, { default: fn, deferred: fn, immediate, exclusive: fn })
			},
			pragma: () => undefined,
			close: () => undefined
		} as unknown as SqliteDbLike

		const migrations: Migration[] = [{ version: 1, name: 'race-safe', sql: 'MIGRATION BODY' }]
		expect(() => runMigrations(db, migrations)).not.toThrow()
		expect(executedSql).not.toContain('MIGRATION BODY')
	})
})

describe('runMigrations run() form (#629)', () => {
	it('invokes the imperative run() body and records the version', () => {
		const applied = new Set<number>()
		let ran = 0

		const db = {
			prepare: (sql: string) => {
				if (sql === 'SELECT version FROM schema_migrations ORDER BY version ASC') {
					return statement({ all: () => [] })
				}

				if (sql === 'SELECT version FROM schema_migrations WHERE version = ?') {
					return statement({ get: (...p: unknown[]) => (applied.has(p[0] as number) ? { version: p[0] } : undefined) })
				}

				if (sql.startsWith('INSERT INTO schema_migrations')) {
					return statement({
						run: (...p: unknown[]) => {
							applied.add(p[0] as number)
							return runResult
						}
					})
				}

				return statement()
			},
			exec: () => db,
			transaction: (fn: () => void) => Object.assign(fn, { immediate: fn }),
			pragma: () => undefined,
			close: () => undefined
		} as unknown as SqliteDbLike

		const migrations: Migration[] = [
			{
				version: 1,
				name: 'imperative',
				run: () => {
					ran++
				}
			}
		]
		runMigrations(db, migrations)
		expect(ran).toBe(1)
		expect(applied.has(1)).toBe(true)

		// Second call is a no-op — version already recorded.
		runMigrations(db, migrations)
		expect(ran).toBe(1)
	})
})
