import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getStatusFromReceiptType } from '../../Utils/generics'
import { mapWebMessageStatusToAndroid } from '../../Utils/multi-db-sqlite/message-store-backend'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite/store'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite/use-multi-db-sqlite-auth-state'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'

/**
 * Unit-level regressions for the 1:1 audit (docs/auditoria-1a1). Tests marked
 * `it.failing` document a defect that still exists; the PR that fixes it flips
 * the test to `it`. A `failing` test that starts passing makes CI red, so a fix
 * can never land without updating this suite.
 */
describe('audit 1:1 regressions (utils)', () => {
	// S-01 · app data lives in a UID-private sandbox; the equivalent on a
	// server is 0700 directories and 0600 files. Fixed by PR-02 (private-fs).
	// POSIX permission bits do not exist on Windows (libuv reports 0o666).
	const posixIt = process.platform === 'win32' ? it.skip : it
	posixIt('creates session directories 0700 and credential files 0600', async () => {
		const previousUmask = process.umask(0o022)
		const base = mkdtempSync(join(tmpdir(), 'audit-1a1-perms-'))
		const mode = (path: string) => statSync(path).mode & 0o777
		try {
			const multiFileDir = join(base, 'multi-file')
			const multiFile = await useMultiFileAuthState(multiFileDir)
			await multiFile.saveCreds()

			const multiDbDir = join(base, 'multi-db')
			const store = new MultiDbSqliteStore({ sessionDir: multiDbDir })
			await store.open()
			const multiDb = await useMultiDbSqliteAuthState({ sessionDir: multiDbDir, store })
			await multiDb.saveCreds()
			multiDb.close()
			store.close()

			const files = [
				...readdirSync(multiFileDir).map(file => join(multiFileDir, file)),
				...readdirSync(multiDbDir)
					.filter(file => /^(creds|axolotl|msgstore)\.db/.test(file))
					.map(file => join(multiDbDir, file))
			]
			expect({ multiFileDir: mode(multiFileDir), multiDbDir: mode(multiDbDir) }).toEqual({
				multiFileDir: 0o700,
				multiDbDir: 0o700
			})
			for (const file of files) expect({ file, mode: mode(file) }).toEqual({ file, mode: 0o600 })
		} finally {
			process.umask(previousUmask)
			rmSync(base, { recursive: true, force: true })
		}
	})

	// R-09 · app receipt table, ReceiptStanzaHelper.A00 (X/C29301Csr.java:337-378):
	// sender/delivery = 5, read = 13, read-self = 17, played = 8,
	// played-self = 18, inactive = 15. The engine's msgstore.db status is
	// mapWebMessageStatusToAndroid(getStatusFromReceiptType(type)); 1:1 means
	// that composition returns exactly the app's integer. Fixed by PR-06.
	const APP_RECEIPT_STATUS: Record<string, number> = {
		sender: 5,
		delivery: 5,
		read: 13,
		'read-self': 17,
		played: 8,
		'played-self': 18,
		inactive: 15
	}
	const engineAndroidStatus = (type: string | undefined) => mapWebMessageStatusToAndroid(getStatusFromReceiptType(type))

	it.failing('maps every receipt type to the same Android status integer as the app', () => {
		const engine = Object.fromEntries(Object.keys(APP_RECEIPT_STATUS).map(type => [type, engineAndroidStatus(type)]))
		expect(engine).toEqual(APP_RECEIPT_STATUS)
	})

	it('keeps the receipt states that already match the app', () => {
		// A receipt without `type` is a delivery receipt (5).
		expect(engineAndroidStatus(undefined)).toBe(5)
		expect(engineAndroidStatus('read')).toBe(APP_RECEIPT_STATUS.read)
		expect(engineAndroidStatus('played')).toBe(APP_RECEIPT_STATUS.played)
	})
})
