import type { ILogger } from '../logger'

/** Initializes a non-authoritative SQLite mirror without disabling its legacy source of truth. */
export const initOptionalMirror = <T>(
	enabled: unknown,
	logger: ILogger,
	mirror: string,
	fallback: string,
	factory: () => T
): T | undefined => {
	if (!enabled) return undefined
	try {
		return factory()
	} catch (err) {
		logger.warn(
			{ err, mirror, primary: 'multi_db_sqlite', fallback, reason: err instanceof Error ? err.message : String(err) },
			'multi-db-sqlite: optional mirror initialization failed; legacy path remains active'
		)
		return undefined
	}
}
