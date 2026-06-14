/**
 * Shared helpers for parsing environment variables that influence runtime
 * scheduling (intervals, timeouts, pool sizes, ports).
 *
 * Bare `parseInt(envVar || 'N', 10)` returns `NaN` when the var is set to
 * something non-numeric (e.g. "24h", "true", "disabled") because
 * `'24h' || 'N'` evaluates to the truthy `'24h'`. Downstream consumers
 * (`setInterval`, `setTimeout`, `server.listen`) then receive `NaN`, which
 * Node clamps to 1 ms / port 0 / etc., producing runaway loops or opaque
 * bind failures. These helpers reject non-finite or out-of-bound values so
 * a malformed env var falls back to the documented default.
 *
 * Mirrors the same shape as `intFromEnv` defined locally in
 * `src/Defaults/index.ts:318` — kept as a separate module so other call
 * sites (session-activity-tracker, prometheus-metrics, future Phase-9
 * tunables) don't grow ad-hoc copies and drift apart. (audit ENV-01/02/03)
 */

/**
 * Parse an integer env var with a fallback and lower/upper bounds.
 *
 * @param raw - Raw env var value (`process.env.X`).
 * @param fallback - Returned if `raw` is missing, empty, non-numeric, or
 *                   outside `[min, max]`.
 * @param min - Minimum acceptable value (default `0`). Pass `1` for
 *              durations / pool sizes that must be strictly positive.
 * @param max - Maximum acceptable value (optional). Use for port numbers
 *              (65535), percentages (100), etc. so out-of-range values
 *              fall back to the safe default instead of reaching the
 *              underlying syscall with a meaningless number.
 */
export const intFromEnv = (
	raw: string | undefined,
	fallback: number,
	min: number = 0,
	max: number = Number.MAX_SAFE_INTEGER
): number => {
	if (raw === undefined) return fallback
	// Trim before the emptiness check — env vars containing only whitespace
	// (e.g. a sloppy `KEY= ` in a .env file) used to slip past `=== ''` and
	// fall through to `Number('   ')` which returns 0, masquerading as a
	// legitimate "zero" config value.
	const trimmed = raw.trim()
	if (trimmed === '') return fallback
	const n = Number(trimmed)
	return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/**
 * Parse a float env var with a fallback. Used for ratios / thresholds
 * where fractional values are valid.
 */
export const floatFromEnv = (raw: string | undefined, fallback: number): number => {
	if (raw === undefined) return fallback
	const trimmed = raw.trim()
	if (trimmed === '') return fallback
	const n = Number(trimmed)
	return Number.isFinite(n) ? n : fallback
}
