import { jest } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Audit S-01 tolerance: correcting permissions needs ownership. When the
 * session folder or a file belongs to another user (shared volume, container
 * with another UID), chmod fails with EPERM and the session must keep opening
 * as before. Tests run as root, so EPERM is simulated.
 */
const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
const eacces = () => Object.assign(new Error('permission denied'), { code: 'EACCES' })
let chmodError: () => Error = eperm

const realFs = await import('fs')
const realFsPromises = await import('fs/promises')
jest.unstable_mockModule('fs', () => ({
	...realFs,
	default: realFs,
	chmodSync: () => {
		throw chmodError()
	}
}))
jest.unstable_mockModule('fs/promises', () => ({
	...realFsPromises,
	default: realFsPromises,
	chmod: async () => {
		throw chmodError()
	}
}))
jest.unstable_mockModule('node:fs', () => ({
	...realFs,
	default: realFs,
	chmodSync: () => {
		throw chmodError()
	}
}))

const privateFs = await import('../../Utils/private-fs')
const { MultiDbSqliteStore } = await import('../../Utils/multi-db-sqlite/store')

const posixIt = process.platform === 'win32' ? it.skip : it

describe('private session files not owned by this process', () => {
	let base: string

	beforeEach(() => {
		chmodError = eperm
		base = mkdtempSync(join(tmpdir(), 'private-fs-not-owned-'))
	})

	afterEach(() => {
		rmSync(base, { recursive: true, force: true })
	})

	posixIt('reports instead of throwing when chmod is not permitted', async () => {
		const file = join(base, 'creds.json')
		writeFileSync(file, '{}')

		await expect(privateFs.ensurePrivateDir(base)).resolves.toBe(false)
		expect(privateFs.ensurePrivateDirSync(base)).toBe(false)
		await expect(privateFs.restrictFile(file)).resolves.toBe(false)
		expect(privateFs.restrictFileSync(file)).toBe(false)
		expect(privateFs.ensurePrivateFileSync(join(base, 'auth.db'))).toBe(false)
	})

	posixIt('keeps writing a temporary whose handle cannot be chmod-ed', async () => {
		await expect(privateFs.restrictHandle({ chmod: async () => Promise.reject(eperm()) })).resolves.toBe(false)
		await expect(privateFs.restrictHandle({ chmod: async () => Promise.reject(eacces()) })).rejects.toMatchObject({
			code: 'EACCES'
		})
	})

	posixIt('still fails on other errors', async () => {
		chmodError = eacces
		await expect(privateFs.ensurePrivateDir(base)).rejects.toMatchObject({ code: 'EACCES' })
		expect(() => privateFs.restrictFileSync(join(base, 'x'))).toThrow(/permission denied/)
	})

	posixIt('opens a multi-db session it cannot chmod and warns once', async () => {
		const warn = jest.fn()
		const logger = { warn, info: () => {}, debug: () => {}, error: () => {}, trace: () => {} } as never
		const store = new MultiDbSqliteStore({ sessionDir: base, logger })
		await store.open()
		try {
			expect(warn).toHaveBeenCalledTimes(1)
			expect(warn.mock.calls[0]![1]).toMatch(/owned by another user/)
		} finally {
			store.close()
		}
	})
})
