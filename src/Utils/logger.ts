/**
 * Configurable Logger for Baileys
 *
 * Supports environment variables:
 * - BAILEYS_LOG: Enable/disable logging (default: true)
 * - BAILEYS_LOG_LEVEL: Log level - trace/debug/info/warn/error/fatal/silent (default: info)
 * - USE_STRUCTURED_LOGS: Use structured logger with advanced features (default: false)
 * - LOG_FORMAT: Output format - 'json' or 'pretty' (default: json)
 * - LOGGER_INFO: Enable info level (default: true)
 * - LOGGER_WARN: Enable warn level (default: true)
 * - LOGGER_ERROR: Enable error level (default: true)
 *
 * @module Utils/logger
 */

import { createRequire } from 'module'
import P, { type Logger as PinoLogger } from 'pino'
import { sanitizeLogRecord, sanitizeLogString, sanitizeLogValue } from './log-redaction.js'

const require = createRequire(import.meta.url)

export interface ILogger {
	level: string
	child(obj: Record<string, unknown>): ILogger
	trace(obj: unknown, msg?: string): void
	debug(obj: unknown, msg?: string): void
	info(obj: unknown, msg?: string): void
	warn(obj: unknown, msg?: string): void
	error(obj: unknown, msg?: string): void
}

/**
 * Logger configuration from environment variables
 */
interface LoggerConfig {
	enabled: boolean
	level: string
	format: 'json' | 'pretty'
	useStructuredLogs: boolean
	levelFilters: {
		info: boolean
		warn: boolean
		error: boolean
	}
}

/**
 * Load logger configuration from environment
 */
function loadLoggerConfig(): LoggerConfig {
	return {
		enabled: process.env.BAILEYS_LOG !== 'false',
		level: process.env.BAILEYS_LOG_LEVEL || 'info',
		format: (process.env.LOG_FORMAT as 'json' | 'pretty') || 'json',
		useStructuredLogs: process.env.USE_STRUCTURED_LOGS === 'true',
		levelFilters: {
			info: process.env.LOGGER_INFO !== 'false',
			warn: process.env.LOGGER_WARN !== 'false',
			error: process.env.LOGGER_ERROR !== 'false'
		}
	}
}

function canUsePrettyTransport(): boolean {
	try {
		require.resolve('pino-pretty')
		return true
	} catch {
		return false
	}
}

/**
 * Create a filtered logger that respects LOGGER_INFO/WARN/ERROR settings
 */
function createFilteredLogger(baseLogger: PinoLogger, config: LoggerConfig): ILogger {
	const noop = () => {}
	const wrap =
		(method: PinoLogger['info']) =>
		(obj: unknown, msg?: string): void => {
			const safeObj =
				typeof obj === 'object' && obj !== null && !Array.isArray(obj)
					? sanitizeLogRecord(obj as Record<string, unknown>)
					: sanitizeLogValue(obj)
			if (msg === undefined) {
				method.call(baseLogger, safeObj)
			} else {
				method.call(baseLogger, safeObj, sanitizeLogString(msg))
			}
		}

	return {
		get level() {
			return baseLogger.level
		},
		set level(newLevel: string) {
			baseLogger.level = newLevel
		},
		child(obj: Record<string, unknown>): ILogger {
			return createFilteredLogger(baseLogger.child(sanitizeLogRecord(obj)), config)
		},
		trace: wrap(baseLogger.trace),
		debug: wrap(baseLogger.debug),
		info: config.levelFilters.info ? wrap(baseLogger.info) : noop,
		warn: config.levelFilters.warn ? wrap(baseLogger.warn) : noop,
		error: config.levelFilters.error ? wrap(baseLogger.error) : noop
	}
}

/**
 * Create a silent logger when logging is disabled
 */
function createSilentLogger(): ILogger {
	const noop = () => {}

	const silentLogger: ILogger = {
		level: 'silent',
		child: () => silentLogger,
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop
	}
	return silentLogger
}

/**
 * Create the configured logger instance
 */
function createLogger(): ILogger {
	const config = loadLoggerConfig()

	// If logging is disabled, return silent logger
	if (!config.enabled) {
		return createSilentLogger()
	}

	// Create pino options
	const pinoOptions: P.LoggerOptions = {
		level: config.level,
		timestamp: () => `,"time":"${new Date().toJSON()}"`
	}

	// Add pretty printing when explicitly set and available
	if (config.format === 'pretty' && canUsePrettyTransport()) {
		pinoOptions.transport = {
			target: 'pino-pretty',
			options: {
				colorize: true,
				translateTime: 'SYS:standard',
				ignore: 'pid,hostname'
			}
		}
	}

	const baseLogger = P(pinoOptions)

	return createFilteredLogger(baseLogger, config)
}

// Export the configured logger instance
const logger = createLogger()

export default logger

// Export config loader for testing/inspection
export { loadLoggerConfig, type LoggerConfig }
