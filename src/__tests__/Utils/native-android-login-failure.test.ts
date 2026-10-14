import type { AuthenticationCreds, PersistedNativeAndroidIdentity } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import {
	applyNativeAndroidTerminalLoginFailure,
	classifyNativeAndroidLoginFailure
} from '../../Utils/native-android-login-failure'

const identity = (overrides: Partial<PersistedNativeAndroidIdentity> = {}): PersistedNativeAndroidIdentity => ({
	schemaVersion: 1,
	profile: 'native_android',
	device: {
		profileId: 'fixture-profile',
		manufacturer: 'Xiaomi',
		device: 'fixture-device',
		osVersion: '14',
		osBuildNumber: 'AP1A.240505.005',
		phoneId: 'f85c1f5ff4823fcb',
		deviceExpId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
		mcc: '724',
		mnc: '05',
		localeLanguageIso6391: 'pt',
		localeCountryIso31661Alpha2: 'BR'
	},
	registrationSeeded: true,
	...overrides
})

const seededPrimaryCreds = (): AuthenticationCreds => {
	const creds = initAuthCreds()
	creds.registered = true
	creds.me = { id: '551531997072@s.whatsapp.net', name: 'primary' }
	creds.nativeAndroidIdentity = identity()
	return creds
}

describe('classifyNativeAndroidLoginFailure', () => {
	it('maps the official <failure reason> taxonomy 1:1', () => {
		expect(classifyNativeAndroidLoginFailure(403)).toEqual({ failureType: 7, retryable: false })
		expect(classifyNativeAndroidLoginFailure(405)).toEqual({ failureType: 3, retryable: false })
		expect(classifyNativeAndroidLoginFailure(406)).toEqual({ failureType: 5, retryable: false })
		expect(classifyNativeAndroidLoginFailure(416)).toEqual({ failureType: 11, retryable: false })
	})

	it('splits the 402 ban family on code and appeal token', () => {
		expect(classifyNativeAndroidLoginFailure(402, { code: '109' })).toEqual({ failureType: 15, retryable: false })
		expect(classifyNativeAndroidLoginFailure(402, { code: '106', appeal_token: 'token' })).toEqual({
			failureType: 13,
			retryable: false
		})
		expect(classifyNativeAndroidLoginFailure(402, { code: '107', appeal_token: 'token' })).toEqual({
			failureType: 14,
			retryable: false
		})
		// Appeal codes without the token fall back to the generic ban type.
		expect(classifyNativeAndroidLoginFailure(402, { code: '106' })).toEqual({ failureType: 2, retryable: false })
		expect(classifyNativeAndroidLoginFailure(402, { code: '107' })).toEqual({ failureType: 2, retryable: false })
		expect(classifyNativeAndroidLoginFailure(402)).toEqual({ failureType: 2, retryable: false })
	})

	it('treats only the 5xx window as retryable (type 4)', () => {
		expect(classifyNativeAndroidLoginFailure(500)).toEqual({ failureType: 4, retryable: true })
		expect(classifyNativeAndroidLoginFailure(503)).toEqual({ failureType: 4, retryable: true })
		expect(classifyNativeAndroidLoginFailure(599)).toEqual({ failureType: 4, retryable: true })
		expect(classifyNativeAndroidLoginFailure(600)).toEqual({ failureType: 0, retryable: false })
		expect(classifyNativeAndroidLoginFailure(499)).toEqual({ failureType: 0, retryable: false })
	})

	it('defaults 401 and every unknown reason to the terminal type 0', () => {
		expect(classifyNativeAndroidLoginFailure(401)).toEqual({ failureType: 0, retryable: false })
		expect(classifyNativeAndroidLoginFailure(400)).toEqual({ failureType: 0, retryable: false })
		expect(classifyNativeAndroidLoginFailure(404)).toEqual({ failureType: 0, retryable: false })
	})
})

describe('applyNativeAndroidTerminalLoginFailure', () => {
	it('never touches companion credentials without a native identity', () => {
		const creds = initAuthCreds()
		creds.registered = true
		creds.me = { id: '5515991426667:12@s.whatsapp.net', name: 'companion' }
		expect(applyNativeAndroidTerminalLoginFailure(creds, 401)).toBeUndefined()
		expect(creds.nativeAndroidIdentity).toBeUndefined()
	})

	it('persists the official type-0 chain on registration-seeded primaries', () => {
		const creds = seededPrimaryCreds()
		const update = applyNativeAndroidTerminalLoginFailure(creds, 401)
		expect(update).toBeDefined()
		const applied = update!.nativeAndroidIdentity!
		expect(applied.loginFailed).toBe(true)
		expect(applied.loginFailedReason).toBe(401)
		expect(applied.previouslyLoggedOutFromPrimary).toBe(true)
		expect(applied.registrationSeeded).toBe(true)
		expect(applied.schemaVersion).toBe(1)
		expect(applied.device).toEqual(creds.nativeAndroidIdentity!.device)
	})

	it('is idempotent for the same reason and re-applies when the reason changes', () => {
		const creds = seededPrimaryCreds()
		const update = applyNativeAndroidTerminalLoginFailure(creds, 401)!
		creds.nativeAndroidIdentity = update.nativeAndroidIdentity
		expect(applyNativeAndroidTerminalLoginFailure(creds, 401)).toBeUndefined()
		expect(applyNativeAndroidTerminalLoginFailure(creds, 403)!.nativeAndroidIdentity!.loginFailedReason).toBe(403)
	})
})
