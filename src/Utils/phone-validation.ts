import { Boom } from '@hapi/boom'
import type { PhoneNumberClassification, PhoneValidationCandidate, PhoneValidationResult } from '../Types'
import { getPhoneMetadataProvider, isLegacyMobile, type PhoneMetadataProvider } from './phone-metadata-provider'

export type PreparedPhoneValidationCandidate = {
	phone: string
	classification: PhoneNumberClassification
}

export type PreparedPhoneValidationRequest = {
	normalizedPhone: string
	candidates: PreparedPhoneValidationCandidate[]
	classificationSource: string
}

export type PhoneValidationRateLimitResult = {
	allowed: boolean
	retryAfterSeconds: number
	scope?: 'number' | 'tenant'
}

export const PHONE_VALIDATION_WINDOW_MS = 60_000
export const PHONE_VALIDATION_MAX_REQUESTS = 5
export const PHONE_VALIDATION_MAX_CACHE_KEYS = 10_000
/** Per-tenant global cap on USync queries per window (B5). */
export const PHONE_VALIDATION_GLOBAL_MAX_REQUESTS = 30

const MIN_E164_DIGITS = 8
const MAX_E164_DIGITS = 15

/**
 * Classifies a phone number using the loaded PhoneMetadataProvider.
 * Falls back to 'unknown' when no provider is available (TSV not configured
 * or loading failed). The motor still works — only the ninth-digit variation
 * is skipped for 'unknown' numbers.
 *
 * @param provider Optional per-socket provider. When omitted, uses the process-level singleton.
 */
export const classifyPhoneNumber = (
	phone: string,
	provider?: PhoneMetadataProvider | null
): PhoneNumberClassification => {
	const resolved = provider ?? getPhoneMetadataProvider()
	if (!resolved) return 'unknown'
	return resolved.classify(phone)
}

export const normalizePhoneForValidation = (phone: unknown): string => {
	if (typeof phone !== 'string' || phone.trim().length === 0) {
		throw new Boom('phone is required', {
			statusCode: 400,
			data: { code: 'phone_invalid' }
		})
	}

	const normalizedPhone = phone.replace(/\D/g, '')
	if (normalizedPhone.length < MIN_E164_DIGITS || normalizedPhone.length > MAX_E164_DIGITS) {
		throw new Boom('phone must contain 8 to 15 digits without the + prefix', {
			statusCode: 400,
			data: { code: 'phone_invalid' }
		})
	}

	return normalizedPhone
}

/**
 * B2: When candidates is provided, it MUST include the exact normalizedPhone.
 *
 * @param provider Optional per-socket provider. When omitted, uses the process-level singleton.
 */
export const preparePhoneValidation = (
	phone: unknown,
	candidatePhones?: unknown,
	provider?: PhoneMetadataProvider | null
): PreparedPhoneValidationRequest => {
	const normalizedPhone = normalizePhoneForValidation(phone)
	const resolvedProvider = provider ?? getPhoneMetadataProvider()
	const classificationSource = resolvedProvider?.source ?? 'unavailable'
	const requestedCandidates = candidatePhones === undefined ? [phone] : candidatePhones

	if (!Array.isArray(requestedCandidates) || requestedCandidates.length === 0) {
		throw new Boom('candidates must be a non-empty array', {
			statusCode: 400,
			data: { code: 'phone_candidates_invalid' }
		})
	}

	const normalizedCandidates = requestedCandidates.map(candidate => {
		return normalizePhoneForValidation(candidate)
	})

	const uniquePhones = [...new Set(normalizedCandidates)]
	const allowedCandidates = buildAllowedPhoneCandidates(normalizedPhone, resolvedProvider)
	const allowedByPhone = new Map(allowedCandidates.map(candidate => [candidate.phone, candidate]))

	const uniqueCandidates = uniquePhones.map(phone => {
		const allowed = allowedByPhone.get(phone)
		return {
			phone,
			classification: allowed?.classification ?? classifyPhoneNumber(phone, resolvedProvider)
		}
	})

	if (uniqueCandidates.some(candidate => !allowedByPhone.has(candidate.phone))) {
		throw new Boom('candidates may only contain exact plausibility variations of phone', {
			statusCode: 400,
			data: {
				code: 'phone_candidates_invalid',
				normalizedPhone
			}
		})
	}

	// B2: when candidates is explicitly provided, it must contain the exact input.
	if (candidatePhones !== undefined && !uniqueCandidates.some(c => c.phone === normalizedPhone)) {
		throw new Boom('candidates must include the exact phone number', {
			statusCode: 400,
			data: { code: 'phone_candidates_invalid', normalizedPhone }
		})
	}

	return {
		normalizedPhone,
		candidates: uniqueCandidates,
		classificationSource
	}
}

/**
 * Returns the exact form plus the single ninth-digit counterpart for a BR
 * legacy mobile number. Legacy-mobile is derived from APK metadata (B6):
 *   BR + 10 national digits + subscriber starts with [6-9] +
 *   classify(inserting 9) === 'mobile'.
 *
 * The APK classifies ALL valid 10-digit BR numbers as landline/fixed-line.
 * The 'legacy-mobile' classification is applied here (not in classifyPhoneNumber)
 * because it's a candidate-generation concept, not an APK metadata value.
 *
 * The subscriber-prefix check [6-9] and the ninth-digit insertion are the
 * only fixed rules. Source: BR numbering plan (Anatel resolução 263/2001).
 */
export const buildAllowedPhoneCandidates = (
	phone: string,
	provider?: PhoneMetadataProvider | null
): PreparedPhoneValidationCandidate[] => {
	const normalizedPhone = normalizePhoneForValidation(phone)
	const resolvedProvider = provider ?? getPhoneMetadataProvider()
	const exactClassification = classifyPhoneNumber(normalizedPhone, resolvedProvider)
	const exact: PreparedPhoneValidationCandidate = {
		phone: normalizedPhone,
		classification: exactClassification
	}

	if (!isLegacyMobile(normalizedPhone, resolvedProvider)) return [exact]

	// Override classification to 'legacy-mobile' for the exact candidate.
	// The APK says 'landline' but this is a legacy mobile number.
	exact.classification = 'legacy-mobile'
	const candidate = `${normalizedPhone.slice(0, 4)}9${normalizedPhone.slice(4)}`
	return [exact, { phone: candidate, classification: 'mobile' }]
}

// ---------------------------------------------------------------------------
// B3+B4+B5: Rate limiter — singleton per process, async interface, proper
// eviction, and global per-tenant cap.
// ---------------------------------------------------------------------------

/** Counts active hits across all buckets for a given tenant prefix. */
const countTenantHits = (buckets: Map<string, number[]>, tenantKey: string, expiresBefore: number): number => {
	let count = 0
	const prefix = tenantKey + ':'
	for (const [bucketKey, timestamps] of buckets) {
		if (bucketKey.startsWith(prefix) || bucketKey === tenantKey) {
			for (const ts of timestamps) {
				if (ts > expiresBefore) count++
			}
		}
	}

	return count
}

export type PhoneValidationRateLimiter = {
	consume(key: string): Promise<PhoneValidationRateLimitResult>
	/** Checks all keys atomically: returns blocked result if any key is over limit, without consuming budget for any. */
	consumeMany(keys: string[]): Promise<PhoneValidationRateLimitResult>
}

export const createPhoneValidationRateLimiter = (
	now: () => number = Date.now,
	windowMs: number = PHONE_VALIDATION_WINDOW_MS,
	maxRequests: number = PHONE_VALIDATION_MAX_REQUESTS,
	maxKeys: number = PHONE_VALIDATION_MAX_CACHE_KEYS,
	globalMaxRequests: number = PHONE_VALIDATION_GLOBAL_MAX_REQUESTS
): PhoneValidationRateLimiter => {
	const buckets = new Map<string, number[]>()

	const evictExpired = (currentTime: number): void => {
		const expiresBefore = currentTime - windowMs
		for (const [bucketKey, timestamps] of buckets) {
			if (timestamps.every(timestamp => timestamp <= expiresBefore)) {
				buckets.delete(bucketKey)
			}
		}
	}

	return {
		async consume(key: string): Promise<PhoneValidationRateLimitResult> {
			const currentTime = now()
			const expiresBefore = currentTime - windowMs
			const hits = (buckets.get(key) ?? []).filter(timestamp => timestamp > expiresBefore)

			// B4: when the map is full and the key is NEW, refuse with 429
			// instead of deleting an active bucket.
			if (hits.length === 0 && buckets.size >= maxKeys) {
				evictExpired(currentTime)
				if (buckets.size >= maxKeys) {
					return {
						allowed: false,
						retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1_000)),
						scope: 'number'
					}
				}
			}

			if (hits.length >= maxRequests) {
				buckets.set(key, hits)
				const oldestHit = Math.min(...hits)
				return {
					allowed: false,
					retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1_000)),
					scope: 'number'
				}
			}

			// B5: global per-tenant cap. Key format is "tenant:number",
			// extract the tenant prefix.
			if (globalMaxRequests > 0) {
				const tenantKey = key.includes(':') ? key.slice(0, key.lastIndexOf(':')) : key
				if (tenantKey !== key) {
					const tenantHitCount = countTenantHits(buckets, tenantKey, expiresBefore)
					if (tenantHitCount >= globalMaxRequests) {
						return {
							allowed: false,
							retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1_000)),
							scope: 'tenant'
						}
					}
				}
			}

			hits.push(currentTime)
			buckets.set(key, hits)

			// Periodic cleanup of expired buckets (runs on every consume,
			// but only iterates when the map is large).
			if (buckets.size > maxKeys * 0.8) {
				evictExpired(currentTime)
			}

			return { allowed: true, retryAfterSeconds: 0 }
		},

		// Atomic check: test all keys first, only consume if ALL pass.
		async consumeMany(keys: string[]): Promise<PhoneValidationRateLimitResult> {
			const currentTime = now()
			const expiresBefore = currentTime - windowMs

			// Phase 1: check all keys without consuming.
			for (const key of keys) {
				const hits = (buckets.get(key) ?? []).filter(timestamp => timestamp > expiresBefore)

				if (hits.length === 0 && buckets.size >= maxKeys) {
					evictExpired(currentTime)
					if (buckets.size >= maxKeys) {
						return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1_000)), scope: 'number' }
					}
				}

				if (hits.length >= maxRequests) {
					const oldestHit = Math.min(...hits)
					return {
						allowed: false,
						retryAfterSeconds: Math.max(1, Math.ceil((oldestHit + windowMs - currentTime) / 1_000)),
						scope: 'number'
					}
				}

				if (globalMaxRequests > 0) {
					const tenantKey = key.includes(':') ? key.slice(0, key.lastIndexOf(':')) : key
					if (tenantKey !== key) {
						const tenantHitCount = countTenantHits(buckets, tenantKey, expiresBefore)
						if (tenantHitCount >= globalMaxRequests) {
							return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1_000)), scope: 'tenant' }
						}
					}
				}
			}

			// Phase 2: all keys passed — consume them all.
			for (const key of keys) {
				const hits = (buckets.get(key) ?? []).filter(timestamp => timestamp > expiresBefore)
				hits.push(currentTime)
				buckets.set(key, hits)
			}

			if (buckets.size > maxKeys * 0.8) {
				evictExpired(currentTime)
			}

			return { allowed: true, retryAfterSeconds: 0 }
		}
	}
}

// ---------------------------------------------------------------------------
// B3: Process-level singleton. Shared across sockets and reconnections.
// ---------------------------------------------------------------------------

let processLimiter: PhoneValidationRateLimiter | undefined

export const getProcessPhoneValidationRateLimiter = (): PhoneValidationRateLimiter => {
	if (!processLimiter) {
		processLimiter = createPhoneValidationRateLimiter()
	}

	return processLimiter
}

export const resetProcessPhoneValidationRateLimiter = (): void => {
	processLimiter = undefined
}

// ---------------------------------------------------------------------------
// B1: resolvePhoneValidationResult — one USync query per candidate.
//
// The caller makes N separate onWhatsApp calls (one per candidate) and
// passes the results as an array aligned with request.candidates. Each
// result belongs to that specific candidate, so the JID can have different
// digits than the queried phone (canonical JID).
// ---------------------------------------------------------------------------

export type PerCandidateResult = {
	jid: string
	exists: boolean
}

/**
 * B1: Resolves the final result from per-candidate USync responses.
 *
 * Each element in `results` corresponds to the same-index candidate in
 * `request.candidates`. The JID in each result is the canonical WhatsApp
 * JID and may differ from the queried digits (e.g. old account without
 * the9th digit).
 */
export const resolvePhoneValidationResult = (
	request: PreparedPhoneValidationRequest,
	results: ReadonlyArray<PerCandidateResult | undefined>
): PhoneValidationResult => {
	if (results?.length !== request.candidates.length) {
		throw new Boom('WhatsApp returned no phone validation response', {
			statusCode: 502,
			data: {
				code: 'phone_validation_incomplete',
				normalizedPhone: request.normalizedPhone
			}
		})
	}

	const candidates: PhoneValidationCandidate[] = []
	const existingJids = new Set<string>()

	for (let i = 0; i < request.candidates.length; i++) {
		const candidate = request.candidates[i]!
		const result = results[i]

		if (!result || typeof result.exists !== 'boolean') {
			throw new Boom('WhatsApp did not answer every requested phone candidate', {
				statusCode: 502,
				data: {
					code: 'phone_validation_incomplete',
					normalizedPhone: request.normalizedPhone,
					candidate: candidate.phone
				}
			})
		}

		const candidateResult: PhoneValidationCandidate = {
			phone: candidate.phone,
			exists: result.exists,
			classification: candidate.classification
		}

		if (result.exists && typeof result.jid === 'string') {
			candidateResult.jid = result.jid
			existingJids.add(result.jid)
		}

		candidates.push(candidateResult)
	}

	// B1: ambiguity is defined by DISTINCT JIDs, not by distinct phones.
	// Two candidates that resolve to the same canonical JID are NOT ambiguous.
	if (existingJids.size > 1) {
		throw new Boom('multiple phone candidates exist; an explicit choice is required', {
			statusCode: 409,
			data: {
				code: 'phone_validation_ambiguous',
				normalizedPhone: request.normalizedPhone,
				existingJids: [...existingJids]
			}
		})
	}

	const existing = candidates.filter(candidate => candidate.exists)

	return {
		normalizedPhone: request.normalizedPhone,
		acceptedJid:
			existing.length === 1 ? (existing[0]?.jid ?? null) : existing.length > 1 ? ([...existingJids][0] ?? null) : null,
		candidates,
		classificationSource: request.classificationSource
	}
}
