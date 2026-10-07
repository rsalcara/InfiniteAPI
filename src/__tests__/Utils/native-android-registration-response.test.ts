import {
	isRegistrationSuccess,
	NATIVE_ANDROID_CODE_REASONS,
	NATIVE_ANDROID_REGISTER_REASONS,
	parseNativeAndroidRegisterResponse,
	parseNativeAndroidRequestCodeResponse
} from '../../Utils/native-android-registration-response'

describe('native_android /v2/code response parser (FOG)', () => {
	it('maps every field the APK reads with its exact accessor type', () => {
		const parsed = parseNativeAndroidRequestCodeResponse({
			status: 'fail',
			reason: 'too_many',
			login: '5511999999999@s.whatsapp.net',
			type: 'existing',
			retry_after: '120',
			length: 6,
			code: '123456',
			sms_wait: '30',
			voice_wait: '60',
			wa_old_wait: '15',
			flash_wait: '20',
			silent_auth_wait: '25',
			send_sms_wait: '35',
			email_otp_wait: '40',
			cli_filter: 'filter',
			cli_cc: '55',
			cli_prefix: '119',
			cli_match_length: '8',
			flash_timeout: '45',
			notify_after: '50',
			wipe_token: 'wipe-token',
			wipe_wait: 70,
			param: 'param-value',
			first_party_migration_initiated: true,
			fpm_initiated_cross_platform: false,
			reset_method: 'sms',
			wipe_type: 'full',
			auth_challenge: 'Q2hhbGxlbmdl',
			autoconf_type: 2,
			email_otp_eligible: 1,
			send_sms_number: '+15550001111',
			uri: 'whatsapp://uri',
			code_list: '111111,222222',
			passkey_credential: 'pk-cred',
			ts_43_cred: 'ts-cred',
			ts_43_nonce: 'ts-nonce',
			lid_blocklist: true,
			lid: '123456789012345',
			fallback_methods: ['sms', 'voice'],
			recommended_method: ['voice'],
			num_visible_dbs_methods: 5,
			violation_type: 'spam',
			violated_policy: 'policy',
			violation_reason: 'reason-x',
			is_eu_smb: true,
			appeal_token: 'appeal',
			version_upgrade: { min_version: '2.0' },
			custom_block_screen: { title: 'blocked' }
		})

		expect(parsed).toEqual({
			status: 'fail',
			reason: 'too_many',
			login: '5511999999999@s.whatsapp.net',
			type: 'existing',
			retryAfter: '120',
			length: 6,
			code: '123456',
			smsWait: '30',
			voiceWait: '60',
			waOldWait: '15',
			flashWait: '20',
			silentAuthWait: '25',
			sendSmsWait: '35',
			emailOtpWait: '40',
			cliFilter: 'filter',
			cliCc: '55',
			cliPrefix: '119',
			cliMatchLength: '8',
			flashTimeout: '45',
			notifyAfter: '50',
			wipeToken: 'wipe-token',
			wipeWait: 70,
			param: 'param-value',
			firstPartyMigrationInitiated: true,
			fpmInitiatedCrossPlatform: false,
			resetMethod: 'sms',
			wipeType: 'full',
			authChallenge: 'Q2hhbGxlbmdl',
			autoconfType: 2,
			emailOtpEligible: 1,
			sendSmsNumber: '+15550001111',
			uri: 'whatsapp://uri',
			codeList: '111111,222222',
			passkeyCredential: 'pk-cred',
			ts43Cred: 'ts-cred',
			ts43Nonce: 'ts-nonce',
			lidBlocklist: true,
			lid: '123456789012345',
			fallbackMethods: ['sms', 'voice'],
			recommendedMethod: ['voice'],
			numVisibleDbsMethods: 5,
			// The /v2/code parser passes null as the FOF reason.
			violation: {
				type: 'spam',
				policy: 'policy',
				reason: null,
				appealToken: 'appeal',
				isEuSmb: true
			},
			versionUpgrade: { min_version: '2.0' },
			customBlockScreen: { title: 'blocked' }
		})
	})

	it('coerces scalars like optString/optInt/optBoolean and drops wrong types', () => {
		const parsed = parseNativeAndroidRequestCodeResponse({
			status: 7,
			retry_after: 120,
			first_party_migration_initiated: 'true',
			fpm_initiated_cross_platform: '0',
			sms_wait: 30,
			length: { weird: true },
			code_list: 111111,
			type: 'unknown-kind',
			fallback_methods: 'sms',
			num_visible_dbs_methods: '4'
		})

		expect(parsed.status).toBe('unknown')
		expect(parsed.retryAfter).toBe('120')
		expect(parsed.firstPartyMigrationInitiated).toBe(true)
		expect(parsed.fpmInitiatedCrossPlatform).toBe(false)
		expect(parsed.smsWait).toBe('30')
		expect(parsed.length).toBe(0)
		expect(parsed.codeList).toBe('111111')
		expect(parsed.type).toBeNull()
		expect(parsed.fallbackMethods).toBeNull()
		expect(parsed.numVisibleDbsMethods).toBe(4)
	})

	it('applies the APK defaults and tolerates absent bodies', () => {
		const fog = parseNativeAndroidRequestCodeResponse({ status: 'sent' })
		expect(fog.numVisibleDbsMethods).toBe(3)
		expect(fog.length).toBe(0)
		expect(fog.wipeWait).toBe(0)
		expect(fog.autoconfType).toBe(0)
		expect(fog.emailOtpEligible).toBe(0)
		expect(fog.lidBlocklist).toBe(false)
		expect(fog.firstPartyMigrationInitiated).toBe(false)
		expect(fog.smsWait).toBeNull()
		expect(fog.codeList).toBeNull()

		const empty = parseNativeAndroidRequestCodeResponse(null)
		expect(empty.status).toBe('unknown')
		expect(empty.reason).toBeNull()
		expect(empty.lid).toBeNull()
		expect(empty.violation).toBeNull()

		const fdz = parseNativeAndroidRegisterResponse({ status: 'ok' })
		expect(fdz.smsWait).toBe(0)
		expect(fdz.voiceWait).toBe(0)
		expect(fdz.flashWait).toBe(0)
		expect(fdz.wipeWait).toBe(0)
		expect(fdz.wipeExpiryTime).toBe(0)
		expect(fdz.serverTime).toBe(0)
		expect(fdz.autoconfType).toBe(0)
		expect(fdz.consentId).toBe(0)
		expect(fdz.consentVersion).toBe(0)
		expect(fdz.paaRole).toBe(0)
		expect(fdz.securityCodeSet).toBe(false)
		expect(fdz.secureVerifier).toBe(false)
		expect(fdz.lidBlocklist).toBe(false)
		expect(fdz.isDeviceTrusted).toBe(false)
		expect(fdz.needChatRestorePnVerify).toBe(false)
		expect(fdz.guessWait).toBeNull()
		expect(parseNativeAndroidRegisterResponse('not-an-object').status).toBe('unknown')
	})

	it('builds the FOF violation block from the flat root keys only', () => {
		const partial = parseNativeAndroidRegisterResponse({ violation_type: 'spam' })
		expect(partial.violation).toEqual({
			type: 'spam',
			policy: null,
			reason: null,
			appealToken: null,
			isEuSmb: false
		})

		const full = parseNativeAndroidRegisterResponse({
			violation_type: 'ban',
			violated_policy: 'policy',
			violation_reason: 'reason',
			is_eu_smb: true,
			appeal_token: 'appeal'
		})
		expect(full.violation).toEqual({
			type: 'ban',
			policy: 'policy',
			reason: 'reason',
			isEuSmb: true,
			appealToken: 'appeal'
		})

		// The FOF construction guard: a reason alone never builds the block.
		expect(parseNativeAndroidRegisterResponse({}).violation).toBeNull()
		expect(parseNativeAndroidRegisterResponse({ violation_reason: 'reason' }).violation).toBeNull()
		expect(parseNativeAndroidRegisterResponse({ is_eu_smb: true }).violation).toBeNull()
	})
})

describe('native_android /v2/register response parser (FDZ)', () => {
	it('maps every field the APK reads with its exact accessor type', () => {
		const parsed = parseNativeAndroidRegisterResponse({
			status: 'ok',
			reason: 'stale',
			login: '5511999999999@s.whatsapp.net',
			type: 'new',
			retry_after: '90',
			first_party_migration_initiated: false,
			fpm_initiated_cross_platform: true,
			reset_method: 'email',
			wipe_type: 'partial',
			wipe_token: 'wipe-token',
			wipe_wait: 10,
			wipe_expiry_time: 1735689600,
			autoconf_type: 3,
			guess_wait: '60',
			server_time: 1735680000,
			security_code_set: true,
			wa_ac_machine_id: 'machine',
			secure_verifier: true,
			sms_wait: 5,
			voice_wait: 6,
			flash_wait: 7,
			need_chat_restore_pn_verify: true,
			pending: 'pending-value',
			parent_consent_url: 'https://example.invalid/consent',
			consent_id: 7,
			consent_version: 2,
			idv_token: 'idv',
			passkey_credential: 'pk',
			lid_blocklist: false,
			lid: '123456789012345@lid',
			edge_routing_info: 'cm91dGU=',
			paa_role: 1,
			paa_pending: 'waiting',
			coex_products: 'products',
			coex_usecase: 'usecase',
			ent_access_token: 'ent-token',
			ent_canonical_fbid: 'fbid',
			second_factor_methods: ['totp', 'email'],
			is_device_trusted: true,
			violation_type: 'ban',
			violated_policy: 'policy',
			violation_reason: 'reason',
			is_eu_smb: false,
			appeal_token: 'appeal',
			version_upgrade: { min_version: '2.1' },
			custom_block_screen: { title: 'title' }
		})

		expect(parsed).toEqual({
			status: 'ok',
			reason: 'stale',
			login: '5511999999999@s.whatsapp.net',
			type: 'new',
			retryAfter: '90',
			firstPartyMigrationInitiated: false,
			fpmInitiatedCrossPlatform: true,
			resetMethod: 'email',
			wipeType: 'partial',
			wipeToken: 'wipe-token',
			wipeWait: 10,
			wipeExpiryTime: 1735689600,
			autoconfType: 3,
			guessWait: '60',
			serverTime: 1735680000,
			securityCodeSet: true,
			waAcMachineId: 'machine',
			secureVerifier: true,
			smsWait: 5,
			voiceWait: 6,
			flashWait: 7,
			needChatRestorePnVerify: true,
			pending: 'pending-value',
			parentConsentUrl: 'https://example.invalid/consent',
			consentId: 7,
			consentVersion: 2,
			idvToken: 'idv',
			passkeyCredential: 'pk',
			lidBlocklist: false,
			lid: '123456789012345@lid',
			edgeRoutingInfo: 'cm91dGU=',
			paaRole: 1,
			paaPending: 'waiting',
			coexProducts: 'products',
			coexUsecase: 'usecase',
			entAccessToken: 'ent-token',
			entCanonicalFbid: 'fbid',
			secondFactorMethods: ['totp', 'email'],
			isDeviceTrusted: true,
			violation: {
				type: 'ban',
				policy: 'policy',
				reason: 'reason',
				appealToken: 'appeal',
				isEuSmb: false
			},
			versionUpgrade: { min_version: '2.1' },
			customBlockScreen: { title: 'title' }
		})
	})
})

describe('native_android registration fail reasons', () => {
	it('pins the exact reason switches of the APK parsers', () => {
		expect([...NATIVE_ANDROID_CODE_REASONS].sort()).toEqual(
			[
				'bad_param',
				'bad_token',
				'blocked',
				'challenge',
				'device_confirm_or_second_code',
				'flash_disabled',
				'format_wrong',
				'invalid_skey',
				'limited_release',
				'missing_param',
				'next_method',
				'no_routes',
				'not_allowed',
				'old_version',
				'provider_timeout',
				'provider_unroutable',
				'second_code',
				'security_code',
				'send_sms',
				'temporarily_unavailable',
				'too_many',
				'too_many_all_methods',
				'too_many_guesses',
				'too_recent',
				'waiting_for_sms'
			].sort()
		)

		expect([...NATIVE_ANDROID_REGISTER_REASONS].sort()).toEqual(
			[
				'blocked',
				'challenge',
				'consent',
				'consent_parent_linking_already_registered',
				'device_confirm_or_second_code',
				'format_wrong',
				'guessed_too_fast',
				'incorrect',
				'limited_release',
				'mismatch',
				'missing',
				'not_allowed',
				'reset_too_soon',
				'second_code',
				'security_code',
				'sms_required',
				'stale',
				'temporarily_unavailable',
				'too_many_guesses'
			].sort()
		)
	})

	it('treats only ok and sent as success', () => {
		expect(isRegistrationSuccess({ status: 'ok' })).toBe(true)
		expect(isRegistrationSuccess({ status: 'sent' })).toBe(true)
		expect(isRegistrationSuccess({ status: 'fail' })).toBe(false)
		expect(isRegistrationSuccess({ status: 'attached' })).toBe(false)
		expect(isRegistrationSuccess({ status: 'unknown' })).toBe(false)
	})
})
