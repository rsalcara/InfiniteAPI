import { jest } from '@jest/globals'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Audit S-01: the single-file SQLite auth database must already be 0600 when
 * SQLite opens it, whatever form the path takes. Restricting it afterwards
 * leaves a window in which another user can open a descriptor that survives
 * the chmod. The real driver is wrapped to record the mode at open time.
 */
const modesAtOpen: Array<{ file: string; mode: number | undefined }> = []

const realDriver = await import('../../Utils/sqlite-driver')
jest.unstable_mockModule('../../Utils/sqlite-driver', () => ({
	...realDriver,
	loadSqliteDriver: async (...args: Parameters<typeof realDriver.loadSqliteDriver>) => {
		const driver = await realDriver.loadSqliteDriver(...args)
		return {
			name: driver.name,
			open(path: string) {
				const file = sqliteDatabaseFile(driver.name, path)?.file
				modesAtOpen.push({ file: file ?? '', mode: file && existsSync(file) ? statSync(file).mode & 0o777 : undefined })
				return driver.open(path)
			}
		}
	}
}))

const { sqliteDatabaseFile, useSqliteAuthState } = await import('../../Utils/use-sqlite-auth-state')

const posixIt = process.platform === 'win32' ? it.skip : it
const mode = (path: string) => statSync(path).mode & 0o777

describe('single-file SQLite auth database permissions at open', () => {
	let base: string
	let previousUmask: number

	beforeEach(() => {
		modesAtOpen.length = 0
		previousUmask = process.umask(0o022)
		base = mkdtempSync(join(tmpdir(), 'sqlite-private-open-'))
	})

	afterEach(() => {
		process.umask(previousUmask)
		rmSync(base, { recursive: true, force: true })
	})

	const openAndClose = async (dbPath: string) => {
		const { saveCreds, close } = await useSqliteAuthState({ dbPath })
		await saveCreds()
		close()
	}

	posixIt('is 0600 before SQLite opens a plain path', async () => {
		await openAndClose(join(base, 'auth.db'))
		expect(modesAtOpen).toEqual([{ file: join(base, 'auth.db'), mode: 0o600 }])
	})

	posixIt('is 0600 before SQLite opens a file: URI, as each driver reads it', async () => {
		const previousCwd = process.cwd()
		process.chdir(base)
		try {
			await openAndClose('file:uri-auth.db')
		} finally {
			process.chdir(previousCwd)
		}

		expect(modesAtOpen).toHaveLength(1)
		expect(modesAtOpen[0]!.mode).toBe(0o600)
		expect(['uri-auth.db', 'file:uri-auth.db']).toContain(modesAtOpen[0]!.file)
	})

	posixIt('restricts sidecars left by a previous version before opening', async () => {
		const dbPath = join(base, 'legacy.db')
		const first = await useSqliteAuthState({ dbPath })
		await first.saveCreds()
		first.close()
		// A crash leaves a -wal/-shm/-journal behind with the old umask default.
		const sidecars = ['-wal', '-shm', '-journal'].map(suffix => `${dbPath}${suffix}`)
		for (const sidecar of sidecars) {
			if (!existsSync(sidecar)) writeFileSync(sidecar, '')
		}

		for (const path of [dbPath, ...sidecars]) chmodSync(path, 0o644)

		const { close } = await useSqliteAuthState({ dbPath })
		try {
			expect([dbPath, ...sidecars].map(mode)).toEqual([0o600, 0o600, 0o600, 0o600])
		} finally {
			close()
		}
	})
})

describe('sqliteDatabaseFile', () => {
	it('takes a file: path literally on better-sqlite3', () => {
		expect(sqliteDatabaseFile('better-sqlite3', 'file:auth.db')).toEqual({ file: 'file:auth.db', create: true })
	})

	it('reads a file: URI on node:sqlite like SQLite does', () => {
		expect(sqliteDatabaseFile('node:sqlite', 'file:auth.db')).toEqual({ file: 'auth.db', create: true })
		expect(sqliteDatabaseFile('node:sqlite', 'file:auth.db?cache=shared#x')).toEqual({ file: 'auth.db', create: true })
		expect(sqliteDatabaseFile('node:sqlite', 'file:///srv/s%20a/auth.db')).toEqual({
			file: '/srv/s a/auth.db',
			create: true
		})
		expect(sqliteDatabaseFile('node:sqlite', 'file://localhost/srv/auth.db')).toEqual({
			file: '/srv/auth.db',
			create: true
		})
	})

	it('does not create what SQLite would refuse to create', () => {
		expect(sqliteDatabaseFile('node:sqlite', 'file:auth.db?mode=ro')).toEqual({ file: 'auth.db', create: false })
		expect(sqliteDatabaseFile('node:sqlite', 'file:auth.db?mode=rw')).toEqual({ file: 'auth.db', create: false })
	})

	it('has no file for in-memory databases', () => {
		expect(sqliteDatabaseFile('better-sqlite3', ':memory:')).toBeUndefined()
		expect(sqliteDatabaseFile('node:sqlite', ':memory:')).toBeUndefined()
		expect(sqliteDatabaseFile('node:sqlite', 'file::memory:')).toBeUndefined()
		expect(sqliteDatabaseFile('node:sqlite', 'file:shared?mode=memory')).toBeUndefined()
		expect(sqliteDatabaseFile('node:sqlite', '')).toBeUndefined()
	})
})
