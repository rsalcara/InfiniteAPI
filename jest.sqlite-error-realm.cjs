/**
 * Jest runs every test file in its own VM context, but better-sqlite3's native
 * addon is loaded once per worker process. better-sqlite3 registers its
 * `SqliteError` constructor on the addon only the first time
 * (`addon.isInitialized`), so every later test file in the same worker
 * receives SQLite errors built from the FIRST file's context: they are thrown,
 * but `instanceof Error` is false there and `.rejects.toThrow()` reports
 * "did not throw". Whether a suite breaks then depends on which files ran
 * before it in the worker.
 *
 * Re-register the constructor from the current test file's context before its
 * tests run. Test-only: in a real process the addon is loaded exactly once.
 * No-op when better-sqlite3 is not installed (node:sqlite fallback leg).
 */
let addon
let SqliteError
try {
	addon = require('bindings')({
		bindings: 'better_sqlite3.node',
		module_root: require('path').dirname(require.resolve('better-sqlite3/package.json'))
	})
	SqliteError = require('better-sqlite3/lib/sqlite-error')
} catch {
	addon = undefined
}

if (addon && typeof addon.setErrorConstructor === 'function') {
	addon.setErrorConstructor(SqliteError)
	addon.isInitialized = true
}
