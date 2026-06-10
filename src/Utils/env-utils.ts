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
 * Parse an integer env var with a fallback and lower bound.
 *
 * @param raw - Raw env var value (`process.env.X`).
 * @param fallback - Returned if `raw` is missing, empty, non-numeric, or
 *                   below `min`.
 * @param min - Minimum acceptable value (default `0`). Pass `1` for
 *              durations / pool sizes that must be strictly positive.
 */
export const intFromEnv = (raw: string | undefined, fallback: number, min: number = 0): number => {
	if (raw === undefined || raw === '') return fallback
	const n = Number(raw)
	return Number.isInteger(n) && n >= min ? n : fallback
}

/**
 * Parse a float env var with a fallback. Used for ratios / thresholds
 * where fractional values are valid.
 */
export const floatFromEnv = (raw: string | undefined, fallback: number): number => {
	if (raw === undefined || raw === '') return fallback
	const n = Number(raw)
	return Number.isFinite(n) ? n : fallback
}
