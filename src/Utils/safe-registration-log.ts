import { createHash } from 'node:crypto'

/**
 * Audit module M10 (`safe-registration-log.ts`, dossier manifest sha-256
 * f5ebc0d1…): allowlist of registration metadata. A request, response, Error,
 * creds or provider result must never be spread into logging — validate the
 * internal categories first and log only these fields.
 *
 * Correlation fields (audit gap F) carry per-step identity WITHOUT content:
 * `blockScreenHash` digests the server's `custom_block_screen` (the screen
 * document is rendered by the caller and never logged), `materialHash` names
 * the exact APK token material (`computeRegistrationMaterialHash`), and
 * `proofHash`/`attestedPackage`/`challengeAgeMs` come from the attestation
 * proof diagnostics. The new fields are total over hostile input: a value that
 * does not match its pattern is DROPPED from the line (never logged, never
 * thrown) because server/device data must not be able to break a registration
 * by throwing inside a log call. The pre-existing fields keep their strict
 * throw semantics — they are caller invariants, all computed in-process.
 */
export type RegistrationLogMetadata = {
	endpoint: string
	operationId: string
	phase: string
	attempts: number
	durationMs: number
	httpStatus?: number
	category?: string
	/** Response status token (`ok`/`sent`/`attached`/`fail`/…) — never the body. */
	status?: string
	/** Server outcome reason (`too_recent`, `incorrect`, …) — never free text. */
	reason?: string
	/** sha-256 (hex) of the JSON-serialized `custom_block_screen`, never its content. */
	blockScreenHash?: string
	/** sha-256 (hex) naming the token material (`computeRegistrationMaterialHash`). */
	materialHash?: string
	/** sha-256 (hex) of the raw `H=` proof signature (attestation diagnostics). */
	proofHash?: string
	/** Package named by the attestation application id, when it names one. */
	attestedPackage?: string
	/** Age of the attestation challenge timestamp at validation time (ms). */
	challengeAgeMs?: number
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const STATUS_TOKEN = /^[a-z0-9_-]{1,40}$/
const REASON_TOKEN = /^[a-z0-9_-]{1,80}$/
const PACKAGE_TOKEN = /^[a-zA-Z0-9._]{1,150}$/

/** Keeps `value` only when it matches `pattern`; drops anything else. */
const externalToken = (value: string | undefined, pattern: RegExp): string | undefined => {
	if (value === undefined) return undefined
	const token = typeof value === 'string' ? value.trim() : ''
	return pattern.test(token) ? token : undefined
}

/** Keeps `value` only when it is a sha-256 hex digest; drops anything else. */
const digestToken = (value: string | undefined): string | undefined =>
	value !== undefined && SHA256_HEX.test(value) ? value : undefined

export function safeRegistrationLog(input: RegistrationLogMetadata): RegistrationLogMetadata {
	if (!/^\/v2\/[a-z_]+$/.test(input.endpoint)) throw new Error('invalid log endpoint')
	if (!/^[a-z0-9-]{1,80}$/i.test(input.operationId)) throw new Error('invalid operation id')
	if (!/^[a-z0-9_-]{1,40}$/i.test(input.phase)) throw new Error('invalid log phase')
	if (!Number.isInteger(input.attempts) || input.attempts < 0) throw new Error('invalid attempts')
	if (!Number.isFinite(input.durationMs) || input.durationMs < 0) throw new Error('invalid duration')
	if (
		input.httpStatus !== undefined &&
		(!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)
	) {
		throw new Error('invalid HTTP status')
	}

	if (input.category !== undefined && !/^[a-z0-9_-]{1,80}$/i.test(input.category)) throw new Error('invalid category')
	// Negative ages are kept (they are the factual clock skew between the
	// device-embedded challenge timestamp and this host); non-integers drop.
	const challengeAgeMs =
		input.challengeAgeMs !== undefined && Number.isInteger(input.challengeAgeMs) ? input.challengeAgeMs : undefined
	const status = externalToken(input.status, STATUS_TOKEN)
	const reason = externalToken(input.reason, REASON_TOKEN)
	const blockScreenHash = digestToken(input.blockScreenHash)
	const materialHash = digestToken(input.materialHash)
	const proofHash = digestToken(input.proofHash)
	const attestedPackage = externalToken(input.attestedPackage, PACKAGE_TOKEN)
	return {
		endpoint: input.endpoint,
		operationId: input.operationId,
		phase: input.phase,
		attempts: input.attempts,
		durationMs: input.durationMs,
		...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
		...(input.category !== undefined ? { category: input.category } : {}),
		...(status !== undefined ? { status } : {}),
		...(reason !== undefined ? { reason } : {}),
		...(blockScreenHash !== undefined ? { blockScreenHash } : {}),
		...(materialHash !== undefined ? { materialHash } : {}),
		...(proofHash !== undefined ? { proofHash } : {}),
		...(attestedPackage !== undefined ? { attestedPackage } : {}),
		...(challengeAgeMs !== undefined ? { challengeAgeMs } : {})
	}
}

/**
 * sha-256 (hex) correlation digest of a `custom_block_screen`. The screen
 * document itself NEVER reaches the log — only this digest, which lets an
 * auditor match the same block across motor, platform and Connector lines.
 * Key order follows the parsed document (`JSON.parse` preserves wire order).
 */
export const registrationBlockScreenHash = (
	screen: Record<string, unknown> | null | undefined
): string | undefined => {
	if (!screen || typeof screen !== 'object') return undefined
	const serialized = JSON.stringify(screen)
	if (!serialized || serialized === '{}') return undefined
	return createHash('sha256').update(serialized, 'utf8').digest('hex')
}
