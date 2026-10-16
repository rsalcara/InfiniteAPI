import { loadSqliteDriver } from '../../Utils/sqlite-driver'

describe('sqlite driver automatic fallback', () => {
	it('resolves node:sqlite through Node module resolution when better-sqlite3 is absent', async () => {
		// Other CI legs retain better-sqlite3 and therefore correctly select it in
		// automatic mode. The auto-fallback CI leg runs only this suite after
		// removing that package, exercising the real import failure path.
		if (process.env.INFINITEAPI_SQLITE_EXPECT_DRIVER !== 'node:sqlite') return

		const previousDriver = process.env.INFINITEAPI_SQLITE_DRIVER
		delete process.env.INFINITEAPI_SQLITE_DRIVER

		const warnings: Array<Record<string, unknown>> = []
		const logger = {
			warn: (payload: Record<string, unknown>): void => {
				warnings.push(payload)
			}
		} as unknown as Parameters<typeof loadSqliteDriver>[0]

		try {
			const driver = await loadSqliteDriver(logger)
			expect(driver.name).toBe('node:sqlite')
			expect(warnings[0]?.betterSqlite3Error).toBeTruthy()

			const database = driver.open(':memory:')
			expect(database.prepare('SELECT 42 AS answer').get()).toEqual({ answer: 42 })
			database.close()
		} finally {
			if (previousDriver === undefined) delete process.env.INFINITEAPI_SQLITE_DRIVER
			else process.env.INFINITEAPI_SQLITE_DRIVER = previousDriver
		}
	})
})
