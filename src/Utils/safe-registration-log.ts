/**
 * Audit module M10 (`safe-registration-log.ts`, dossier manifest sha-256
 * f5ebc0d1…): allowlist of registration metadata. A request, response, Error,
 * creds or provider result must never be spread into logging — validate the
 * internal categories first and log only these fields.
 */
export type RegistrationLogMetadata = {
	endpoint: string
	operationId: string
	phase: string
	attempts: number
	durationMs: number
	httpStatus?: number
	category?: string
}

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
	return {
		endpoint: input.endpoint,
		operationId: input.operationId,
		phase: input.phase,
		attempts: input.attempts,
		durationMs: input.durationMs,
		...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
		...(input.category !== undefined ? { category: input.category } : {})
	}
}
