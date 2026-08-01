import { describe, expect, it, jest } from '@jest/globals'
import { DEFAULT_IN_CHUNK, prepareInClause, SQLITE_MAX_VARIABLES } from '../../Utils/multi-db-sqlite/in-statement-cache'
import type { SqliteDbLike, SqliteStatementLike } from '../../Utils/multi-db-sqlite/types'

const makeDb = () => {
	const preparedSql: string[] = []
	const boundCounts: number[] = []
	const db = {
		prepare: jest.fn((sql: string) => {
			preparedSql.push(sql)
			return {
				all: (...params: unknown[]) => {
					boundCounts.push(params.length)
					return []
				},
				run: (...params: unknown[]) => {
					boundCounts.push(params.length)
					return { changes: 1, lastInsertRowid: 0 }
				}
			} as unknown as SqliteStatementLike
		})
	} as unknown as SqliteDbLike
	return { db, preparedSql, boundCounts }
}

describe('prepareInClause SQLite variable budget', () => {
	it('subtracts leading parameters before chunking a 976-value query', () => {
		const { db, preparedSql, boundCounts } = makeDb()
		const query = prepareInClause(db, 'SELECT * FROM t WHERE tenant = ? AND id IN (', ')', DEFAULT_IN_CHUNK)

		query.all(Array.from({ length: 25 }), Array.from({ length: 976 }))

		expect(boundCounts).toEqual([SQLITE_MAX_VARIABLES, 27])
		expect(preparedSql).toHaveLength(2)
	})

	it('keeps the full 975-value chunk when 24 leading parameters fit exactly', () => {
		const { db, boundCounts } = makeDb()
		const query = prepareInClause(db, 'SELECT * FROM t WHERE id IN (', ')')

		query.all(Array.from({ length: 24 }), Array.from({ length: 975 }))

		expect(boundCounts).toEqual([SQLITE_MAX_VARIABLES])
	})

	it('rejects leading parameters that leave no IN-list capacity', () => {
		const { db } = makeDb()
		const query = prepareInClause(db, 'SELECT * FROM t WHERE id IN (', ')')

		expect(() => query.all(Array.from({ length: SQLITE_MAX_VARIABLES }), [1])).toThrow(RangeError)
	})

	it('rejects a non-finite chunk size before query execution', () => {
		const { db } = makeDb()

		expect(() => prepareInClause(db, 'SELECT * FROM t WHERE id IN (', ')', Number.NaN)).toThrow(RangeError)
	})
})
