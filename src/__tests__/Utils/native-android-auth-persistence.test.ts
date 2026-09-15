import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PersistedNativeAndroidIdentity, PersistedWebTransportIdentity } from '../../Types'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const identity: PersistedNativeAndroidIdentity = {
	schemaVersion: 1,
	profile: 'native_android',
	preset: 'native_android_business',
	device: {
		profileId: 'persistence-fixture',
		manufacturer: 'fixture-manufacturer',
		device: 'fixture-device',
		osVersion: '15',
		osBuildNumber: 'fixture-build',
		phoneId: 'fixture-phone-id',
		deviceExpId: 'fixture-device-exp-id',
		mcc: '724',
		mnc: '05',
		localeLanguageIso6391: 'pt',
		localeCountryIso31661Alpha2: 'BR'
	},
	connectionLc: 17,
	serverStaticPublicKey: Buffer.alloc(32, 0x5a),
	connectionEndpoint: {
		host: 'g.whatsapp.net',
		address: '31.13.65.50',
		port: 443,
		source: 'hardcoded',
		sequenceStep: 6
	},
	integrity: {
		schemaVersion: 1,
		gpia: {
			status: 'response_sent',
			observedAt: 1_788_113_419_100,
			updatedAt: 1_788_113_420_000,
			responseSentAt: 1_788_113_420_000,
			policyApplied: 'audit'
		},
		safetynet: {
			status: 'unsupported',
			observedAt: 1_788_113_419_113,
			updatedAt: 1_788_113_419_113,
			policyApplied: 'audit'
		}
	}
}

const webIdentity: PersistedWebTransportIdentity = {
	schemaVersion: 1,
	profile: 'web',
	preset: 'web_windows_hybrid',
	browser: ['Windows', 'Desktop', '10'],
	syncFullHistory: true
}

describe('native_android identity persistence', () => {
	it('round-trips through the legacy multi-file auth state', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'native-android-multifile-'))
		try {
			const first = await useMultiFileAuthState(dir)
			first.state.creds.nativeAndroidIdentity = identity
			await first.saveCreds()

			const reopened = await useMultiFileAuthState(dir)
			expect(reopened.state.creds.nativeAndroidIdentity).toEqual(identity)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('round-trips through the monolithic SQLite auth state', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'native-android-sqlite-'))
		const dbPath = join(dir, 'auth.db')
		try {
			const first = await useSqliteAuthState({ dbPath })
			first.state.creds.nativeAndroidIdentity = identity
			await first.saveCreds()
			first.close()

			const reopened = await useSqliteAuthState({ dbPath })
			expect(reopened.state.creds.nativeAndroidIdentity).toEqual(identity)
			reopened.close()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('round-trips through the multi-database SQLite auth state', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'native-android-multidb-'))
		try {
			const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
			first.state.creds.nativeAndroidIdentity = identity
			await first.saveCreds()
			first.close()

			const reopened = await useMultiDbSqliteAuthState({ sessionDir: dir })
			expect(reopened.state.creds.nativeAndroidIdentity).toEqual(identity)
			reopened.close()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

describe('web transport identity persistence', () => {
	it('round-trips through the legacy multi-file auth state', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'web-identity-multifile-'))
		try {
			const first = await useMultiFileAuthState(dir)
			first.state.creds.webTransportIdentity = webIdentity
			await first.saveCreds()

			const reopened = await useMultiFileAuthState(dir)
			expect(reopened.state.creds.webTransportIdentity).toEqual(webIdentity)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('round-trips through the monolithic SQLite auth state', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'web-identity-sqlite-'))
		const dbPath = join(dir, 'auth.db')
		try {
			const first = await useSqliteAuthState({ dbPath })
			first.state.creds.webTransportIdentity = webIdentity
			await first.saveCreds()
			first.close()

			const reopened = await useSqliteAuthState({ dbPath })
			expect(reopened.state.creds.webTransportIdentity).toEqual(webIdentity)
			reopened.close()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it('round-trips through the multi-database SQLite auth state', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'web-identity-multidb-'))
		try {
			const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
			first.state.creds.webTransportIdentity = webIdentity
			await first.saveCreds()
			first.close()

			const reopened = await useMultiDbSqliteAuthState({ sessionDir: dir })
			expect(reopened.state.creds.webTransportIdentity).toEqual(webIdentity)
			reopened.close()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
