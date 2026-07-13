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
