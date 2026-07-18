/**
 * Per-attempt query timeout for the pre-key upload path.
 *
 * The upload loop is wrapped in a single-flight promise, so a query() that never
 * resolves would block every future upload. We therefore give each attempt an
 * explicit timeout instead of relying on the ambient `defaultQueryTimeoutMs`,
 * which is `number | undefined` and can be disabled by the consumer (in which
 * case `promiseTimeout` builds a promise with no timeout at all).
 */

/** Fallback used only when the consumer's global query timeout is disabled/0. */
export const PREKEY_UPLOAD_QUERY_TIMEOUT_FALLBACK_MS = 30_000

/**
 * Resolve the per-attempt query timeout for pre-key upload.
 *
 * - A positive consumer-configured `defaultQueryTimeoutMs` is preserved verbatim,
 *   so a deliberate `60_000` is honoured rather than clamped to the fallback
 *   (clamping could cut off a response the consumer's own deadline still allowed).
 * - `undefined` / `0` / any non-positive value (i.e. the timeout is disabled)
 *   falls back to {@link PREKEY_UPLOAD_QUERY_TIMEOUT_FALLBACK_MS} so an attempt is
 *   never unbounded and the single-flight guard can never be held forever.
 */
export function resolvePrekeyUploadQueryTimeout(defaultQueryTimeoutMs: number | undefined): number {
	return defaultQueryTimeoutMs && defaultQueryTimeoutMs > 0
		? defaultQueryTimeoutMs
		: PREKEY_UPLOAD_QUERY_TIMEOUT_FALLBACK_MS
}
