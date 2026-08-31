import { Boom } from '@hapi/boom'
import type {
	NativeAndroidIntegrityChallengeKind,
	NativeAndroidIntegrityChallengeStatus,
	NativeAndroidIntegrityPolicy,
	PersistedNativeAndroidIntegrityChallenge,
	PersistedNativeAndroidIntegrityState
} from '../Types/Transport'
import type { BinaryNode } from '../WABinary'

export type NativeAndroidIntegrityState = {
	enabled: boolean
	policy: NativeAndroidIntegrityPolicy
	gpia: NativeAndroidIntegrityChallengeStatus
	safetynet: NativeAndroidIntegrityChallengeStatus
	updatedAt: number
}

type IntegrityTransitionOptions = {
	observedAt?: number
	responseSentAt?: number
}

type NativeAndroidIntegrityStateOptions = {
	enabled: boolean
	policy?: NativeAndroidIntegrityPolicy
	persisted?: PersistedNativeAndroidIntegrityState
	getPersisted?: () => PersistedNativeAndroidIntegrityState | undefined
	now?: () => number
	onPersist?: (state: PersistedNativeAndroidIntegrityState) => void
	onBlocked?: (
		blocked: ReadonlyArray<{
			kind: NativeAndroidIntegrityChallengeKind
			status: NativeAndroidIntegrityChallengeStatus
		}>,
		egress: 'message' | 'call'
	) => void
}

const CHALLENGE_KINDS = ['gpia', 'safetynet'] as const
const PERSISTED_STATUSES = new Set<NativeAndroidIntegrityChallengeStatus>([
	'pending',
	'response_sent',
	'unavailable',
	'failed',
	'unsupported'
])
const BLOCKING_STATUSES = new Set<NativeAndroidIntegrityChallengeStatus>([
	'pending',
	'unavailable',
	'failed',
	'unsupported'
])

export const NATIVE_ANDROID_INTEGRITY_REQUIRED_STATUS = 428
export const NATIVE_ANDROID_INTEGRITY_DEFAULT_PROVIDER_TIMEOUT_MS = 30_000
export const NATIVE_ANDROID_INTEGRITY_MAX_TOKEN_BYTES = 1024 * 1024

const isTimestamp = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const normalizePersistedChallenge = (
	value: unknown,
	policy: NativeAndroidIntegrityPolicy
): PersistedNativeAndroidIntegrityChallenge | undefined => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Partial<PersistedNativeAndroidIntegrityChallenge>
	if (!record.status || !PERSISTED_STATUSES.has(record.status)) return undefined
	if (!isTimestamp(record.observedAt) || !isTimestamp(record.updatedAt)) return undefined
	if (record.responseSentAt !== undefined && !isTimestamp(record.responseSentAt)) return undefined
	if (record.status === 'response_sent' && record.responseSentAt === undefined) return undefined

	return {
		status: record.status,
		observedAt: record.observedAt,
		updatedAt: record.updatedAt,
		...(record.responseSentAt !== undefined ? { responseSentAt: record.responseSentAt } : {}),
		policyApplied: record.policyApplied === 'audit' || record.policyApplied === 'enforce' ? record.policyApplied : policy
	}
}

const clonePersistedState = (
	records: Partial<Record<NativeAndroidIntegrityChallengeKind, PersistedNativeAndroidIntegrityChallenge>>
): PersistedNativeAndroidIntegrityState => ({
	schemaVersion: 1,
	...(records.gpia ? { gpia: { ...records.gpia } } : {}),
	...(records.safetynet ? { safetynet: { ...records.safetynet } } : {})
})

/**
 * Tracks only safe integrity metadata. Challenge nonces and response tokens are
 * never accepted by this object, so they cannot accidentally enter auth state.
 */
export const createNativeAndroidIntegrityState = ({
	enabled,
	policy = 'audit',
	persisted,
	getPersisted,
	now = Date.now,
	onPersist,
	onBlocked
}: NativeAndroidIntegrityStateOptions) => {
	const initialNow = now()
	const malformedPersistedState = Boolean(persisted && persisted.schemaVersion !== 1)
	const records: Partial<
		Record<NativeAndroidIntegrityChallengeKind, PersistedNativeAndroidIntegrityChallenge>
	> = {}

	for (const kind of CHALLENGE_KINDS) {
		const raw = malformedPersistedState ? undefined : persisted?.[kind]
		const normalized = normalizePersistedChallenge(raw, policy)
		if (normalized) records[kind] = normalized
		else if (raw !== undefined || malformedPersistedState) {
			// A present-but-invalid marker is never interpreted as a successful
			// response. In enforce mode this remains fail-closed across restarts.
			records[kind] = {
				status: 'failed',
				observedAt: initialNow,
				updatedAt: initialNow,
				policyApplied: policy
			}
		}
	}

	const generations: Record<NativeAndroidIntegrityChallengeKind, number> = {
		gpia: 0,
		safetynet: 0
	}

	const statusFor = (kind: NativeAndroidIntegrityChallengeKind): NativeAndroidIntegrityChallengeStatus =>
		records[kind]?.status ?? 'not_requested'
	const refreshFromPersisted = (kind: NativeAndroidIntegrityChallengeKind) => {
		const current = getPersisted?.()
		if (!current || current.schemaVersion !== 1) return
		const external = normalizePersistedChallenge(current[kind], policy)
		const local = records[kind]
		if (
			external &&
			(!local ||
				external.observedAt > local.observedAt ||
				(external.observedAt === local.observedAt && external.updatedAt > local.updatedAt))
		) {
			records[kind] = external
		}
	}

	const persist = () => onPersist?.(clonePersistedState(records))

	const transition = (
		kind: NativeAndroidIntegrityChallengeKind,
		status: Exclude<NativeAndroidIntegrityChallengeStatus, 'not_requested'>,
		options: IntegrityTransitionOptions = {}
	) => {
		const timestamp = now()
		const previous = records[kind]
		records[kind] = {
			status,
			observedAt: options.observedAt ?? previous?.observedAt ?? timestamp,
			updatedAt: timestamp,
			...(status === 'response_sent'
				? { responseSentAt: options.responseSentAt ?? timestamp }
				: {}),
			policyApplied: policy
		}
		persist()
		return timestamp
	}

	const begin = (
		kind: NativeAndroidIntegrityChallengeKind,
		status: 'pending' | 'unavailable' | 'failed' | 'unsupported'
	) => {
		refreshFromPersisted(kind)
		const generation = ++generations[kind]
		// A challenge observed by a replacement socket must sort after the
		// persisted challenge even when both arrive in the same millisecond.
		const observedAt = Math.max(now(), (records[kind]?.observedAt ?? -1) + 1)
		transition(kind, status, { observedAt })
		return { generation, observedAt }
	}

	const isCurrent = (kind: NativeAndroidIntegrityChallengeKind, generation: number) => {
		const observedAt = records[kind]?.observedAt
		refreshFromPersisted(kind)
		return generations[kind] === generation && records[kind]?.observedAt === observedAt
	}

	const invalidate = (kind: NativeAndroidIntegrityChallengeKind) => {
		generations[kind]++
	}

	const snapshot = (): NativeAndroidIntegrityState => {
		for (const kind of CHALLENGE_KINDS) refreshFromPersisted(kind)
		return {
			enabled,
			policy,
			gpia: statusFor('gpia'),
			safetynet: statusFor('safetynet'),
			updatedAt: Math.max(initialNow, records.gpia?.updatedAt ?? 0, records.safetynet?.updatedAt ?? 0)
		}
	}

	const blockingChallenges = () => {
		for (const kind of CHALLENGE_KINDS) refreshFromPersisted(kind)
		return CHALLENGE_KINDS.flatMap(kind => {
			const status = statusFor(kind)
			return BLOCKING_STATUSES.has(status) ? [{ kind, status }] : []
		})
	}

	const assertUserMessageEgressReady = (egress: 'message' | 'call' = 'message') => {
		if (!enabled || policy !== 'enforce') return
		const blocked = blockingChallenges()
		if (!blocked.length) return

		onBlocked?.(blocked, egress)
		throw new Boom('native_android integrity challenge has not been satisfied', {
			statusCode: NATIVE_ANDROID_INTEGRITY_REQUIRED_STATUS,
			data: {
				category: 'native-android-integrity-required',
				challenges: blocked,
				action: `${egress}-egress-blocked`
			}
		})
	}

	return {
		begin,
		transition,
		isCurrent,
		invalidate,
		snapshot,
		blockingChallenges,
		assertUserMessageEgressReady
	}
}

export const getNativeAndroidIntegrityNonce = (
	kind: NativeAndroidIntegrityChallengeKind,
	node: BinaryNode
): string | undefined => {
	if (!Array.isArray(node.content)) return undefined
	const container = node.content.find(child => child.tag === kind)
	if (!container || !Array.isArray(container.content)) return undefined
	const requestTag = kind === 'gpia' ? 'request' : 'integrity'
	const challenge = container.content.find(child => child.tag === requestTag)
	const nonce = challenge?.attrs?.nonce
	return typeof nonce === 'string' && nonce.length > 0 ? nonce : undefined
}

export const buildNativeAndroidGpiaResponseNode = (jws: string): BinaryNode => {
	if (typeof jws !== 'string' || jws.length === 0) {
		throw new Boom('native_android integrity provider returned an empty token', { statusCode: 502 })
	}

	const token = Buffer.from(jws, 'utf8')
	if (token.byteLength > NATIVE_ANDROID_INTEGRITY_MAX_TOKEN_BYTES) {
		throw new Boom('native_android integrity provider token exceeds the protocol safety limit', { statusCode: 502 })
	}

	return {
		tag: 'ib',
		attrs: {},
		content: [
			{
				tag: 'gpia',
				attrs: {},
				content: [{ tag: 'jws', attrs: {}, content: token }]
			}
		]
	}
}

export const containsNativeAndroidIntegrityMaterial = (node: BinaryNode): boolean =>
	node.tag === 'gpia' ||
	node.tag === 'safetynet' ||
	(Array.isArray(node.content) && node.content.some(containsNativeAndroidIntegrityMaterial))

/**
 * Classifies only fresh user egress. Protocol repair and already-active call
 * signaling must remain available while an integrity challenge is pending.
 */
export const getNativeAndroidIntegrityGatedEgress = (node: BinaryNode): 'message' | 'call' | undefined => {
	if (node.tag === 'message') {
		if (node.attrs?.participant || node.attrs?.category === 'peer') return undefined
		return 'message'
	}

	if (
		node.tag === 'call' &&
		Array.isArray(node.content) &&
		node.content.some(child => child.tag === 'offer')
	) {
		return 'call'
	}

	return undefined
}
