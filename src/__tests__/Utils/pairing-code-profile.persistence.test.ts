import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { ensureSmbAndroidDeviceIdentity } from '../../Utils/pairing-code-profile'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

describe('pairing-code profile credential persistence', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'pair-profile-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('round-trips through the legacy multi-file backend', async () => {
		const first = await useMultiFileAuthState(join(dir, 'legacy'))
		first.state.creds.pairingCodeProfile = 'smb_android'
		ensureSmbAndroidDeviceIdentity(first.state.creds)
		await first.saveCreds()

		const reopened = await useMultiFileAuthState(join(dir, 'legacy'))
		expect(reopened.state.creds.pairingCodeProfile).toBe('smb_android')
		expect(reopened.state.creds.smbAndroidDeviceIdentity).toEqual(first.state.creds.smbAndroidDeviceIdentity)
	})

	it('round-trips through the monolithic SQLite backend', async () => {
		const dbPath = join(dir, 'auth.db')
		const first = await useSqliteAuthState({ dbPath })
		first.state.creds.pairingCodeProfile = 'smb_android'
		ensureSmbAndroidDeviceIdentity(first.state.creds)
		await first.saveCreds()
		first.close()

		const reopened = await useSqliteAuthState({ dbPath })
		expect(reopened.state.creds.pairingCodeProfile).toBe('smb_android')
		expect(reopened.state.creds.smbAndroidDeviceIdentity).toEqual(first.state.creds.smbAndroidDeviceIdentity)
		reopened.close()
	})

	it('round-trips through the multi-bank SQLite backend', async () => {
		const sessionDir = join(dir, 'multi-db')
		const first = await useMultiDbSqliteAuthState({ sessionDir })
		first.state.creds.pairingCodeProfile = 'smb_android'
		ensureSmbAndroidDeviceIdentity(first.state.creds)
		await first.saveCreds()
		first.close()

		const reopened = await useMultiDbSqliteAuthState({ sessionDir })
		expect(reopened.state.creds.pairingCodeProfile).toBe('smb_android')
		expect(reopened.state.creds.smbAndroidDeviceIdentity).toEqual(first.state.creds.smbAndroidDeviceIdentity)
		reopened.close()
	})
})
