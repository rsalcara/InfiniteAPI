import type { AuthenticationCreds, PersistedNativeAndroidIdentity } from '../Types'
import { isRegistrationSeededPrimary } from './native-android-transport'

/**
 * Official login-sequence `<failure reason>` taxonomy (W4B 2.26.36.72):
 * 5xx → type 4 (retryable), 402 → ban family (15 code=109 / 13 code=106 with an
 * appeal token / 14 code=107 / 2 otherwise), 403 → type 7 (permanent ban),
 * 405 → type 3 (expired), 406 → type 5 (underage), 416 → type 11 (violation);
 * everything else — 401 included — is the default type 0.
 */
export type NativeAndroidLoginFailureClassification = {
	failureType: 0 | 2 | 3 | 4 | 5 | 7 | 11 | 13 | 14 | 15
	retryable: boolean
}

/**
 * Mirrors the official retryable predicate (`serverErrorCode ∈ 5xx || type 6`).
 * Type 6 is the goaway socket exception and never comes from a `<failure>`
 * node, so only 5xx reasons are retryable on this path.
 */
export const classifyNativeAndroidLoginFailure = (
	reason: number,
	attrs: { code?: string; appeal_token?: string } = {}
): NativeAndroidLoginFailureClassification => {
	if (reason >= 500 && reason < 600) return { failureType: 4, retryable: true }

	const code = attrs.code !== undefined ? +attrs.code : undefined
	switch (reason) {
		case 402:
			if (code === 109) return { failureType: 15, retryable: false }
			if (attrs.appeal_token !== undefined) {
				if (code === 106) return { failureType: 13, retryable: false }
				if (code === 107) return { failureType: 14, retryable: false }
			}

			return { failureType: 2, retryable: false }
		case 403:
			return { failureType: 7, retryable: false }
		case 405:
			return { failureType: 3, retryable: false }
		case 406:
			return { failureType: 5, retryable: false }
		case 416:
			return { failureType: 11, retryable: false }
		default:
			return { failureType: 0, retryable: false }
	}
}

/**
 * Terminal-failure bookkeeping for registration-seeded primaries (the official
 * type-0 chain of HandlerC08360a1: `login_failed` + `previously_logged_out_
 * from_primary`; `connect()` refuses while `login_failed` is set). Companion
 * credentials are never matched, so their behavior stays exactly as before.
 * Returns the creds update to persist, or undefined when nothing changes.
 *
 * The classified `failureType` is persisted alongside the raw `reason` so a
 * later restart can reproduce the official category (405 → type 3, 403 → type 7,
 * 5xx → type 4, …) instead of collapsing every terminal failure into the
 * default type 0 (audit C10).
 */
export const applyNativeAndroidTerminalLoginFailure = (
	creds: AuthenticationCreds,
	reason: number,
	failureType?: NativeAndroidLoginFailureClassification['failureType']
): Partial<AuthenticationCreds> | undefined => {
	if (!isRegistrationSeededPrimary(creds)) return undefined
	const identity = creds.nativeAndroidIdentity
	if (!identity) return undefined
	if (
		identity.loginFailed &&
		identity.previouslyLoggedOutFromPrimary &&
		identity.loginFailedReason === reason &&
		(failureType === undefined || identity.loginFailedType === failureType)
	) {
		return undefined
	}

	const nativeAndroidIdentity: PersistedNativeAndroidIdentity = {
		...identity,
		loginFailed: true,
		loginFailedReason: reason,
		loginFailedType: failureType,
		previouslyLoggedOutFromPrimary: true
	}
	return { nativeAndroidIdentity }
}
