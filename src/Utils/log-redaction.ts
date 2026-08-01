const REDACTED = '[REDACTED]'
const MAX_DEPTH_REACHED = '[max depth]'
const MAX_STACK_LENGTH = 24_000
const MAX_STRING_LENGTH = 8_192
const MAX_LOG_DEPTH = 32
const MAX_LOG_ENTRIES = 4_096
const LOG_ENTRIES_TRUNCATED = '[max entries]'

const DEFAULT_SENSITIVE_FIELDS = [
	'password',
	'passwd',
	'secret',
	'token',
	'accesstoken',
	'refreshtoken',
	'apikey',
	'api_key',
	'authorization',
	'credentials',
	'privatekey',
	'private_key',
	'key',
	'qr',
	'pairingcode',
	'pairing_code',
	'messagecontent',
	'message_content',
	'plaintext',
	'ciphertext',
	'payload',
	'body',
	'caption',
	'conversation',
	'pushname',
	'vcard',
	'matchedtext',
	'selecteddisplaytext',
	'title',
	'description',
	'filename',
	'displayname',
	'text',
	'content',
	'data'
]

const EXACT_SENSITIVE_FIELDS = new Set([
	'payload',
	'body',
	'caption',
	'text',
	'content',
	'data',
	'title',
	'description',
	'filename',
	'displayname'
])

const normalizeFieldName = (field: string): string => field.toLowerCase().replace(/[-\s]/g, '')
const NORMALIZED_DEFAULT_SENSITIVE_FIELDS = DEFAULT_SENSITIVE_FIELDS.map(normalizeFieldName)
const NORMALIZED_EXACT_SENSITIVE_FIELDS = new Set([...EXACT_SENSITIVE_FIELDS].map(normalizeFieldName))

const JID_PATTERN = /(?<![0-9A-Za-z._-])([0-9A-Za-z._-]+(?::\d+)?)@([0-9A-Za-z.-]+)(?![0-9A-Za-z.-])/g
const PHONE_PATTERN = /(?<![0-9A-Za-z])\+?\d{8,16}(?![0-9A-Za-z])/g
const MESSAGE_KEY_CORRELATION_FIELDS = new Set([
	'remoteJid',
	'remoteJidAlt',
	'fromMe',
	'id',
	'participant',
	'addressingMode'
])

const truncate = (value: string, limit: number): string =>
	value.length > limit ? `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]` : value

/** Matches Android's Jid.toString(): last four user chars + optional device + domain. */
export const obfuscateJid = (jid: string): string => {
	const at = jid.indexOf('@')
	if (at <= 0) return jid

	const local = jid.slice(0, at)
	const server = jid.slice(at + 1)
	const deviceSeparator = local.lastIndexOf(':')
	const hasDevice = deviceSeparator > 0 && /^\d+$/.test(local.slice(deviceSeparator + 1))
	const user = hasDevice ? local.slice(0, deviceSeparator) : local
	const device = hasDevice ? local.slice(deviceSeparator) : ''

	return `${user.slice(-4)}${device}@${server}`
}

export const obfuscateIdentifier = (value: string): string => {
	if (value.length <= 8) return value
	return `…${value.slice(-8)}`
}

export const sanitizeLogString = (value: string, limit: number = MAX_STRING_LENGTH): string => {
	const bounded = truncate(value, limit)
	const jidsRedacted = bounded.replace(JID_PATTERN, match => obfuscateJid(match))
	const phonesRedacted = jidsRedacted.replace(PHONE_PATTERN, match => {
		const digits = match.replace(/\D/g, '')
		return `***${digits.slice(-4)}`
	})
	return phonesRedacted
}

const isSensitiveField = (key: string, extraFields: ReadonlyArray<string>): boolean => {
	const normalized = normalizeFieldName(key)
	return (
		NORMALIZED_DEFAULT_SENSITIVE_FIELDS.some(normalizedField =>
			NORMALIZED_EXACT_SENSITIVE_FIELDS.has(normalizedField)
				? normalized === normalizedField
				: normalized.includes(normalizedField)
		) ||
		extraFields.some(field => {
			const normalizedField = normalizeFieldName(field)
			return NORMALIZED_EXACT_SENSITIVE_FIELDS.has(normalizedField)
				? normalized === normalizedField
				: normalized.includes(normalizedField)
		})
	)
}

export type SanitizeLogOptions = {
	fieldName?: string
	extraFields?: ReadonlyArray<string>
	seen?: WeakSet<object>
	includeErrorStack?: boolean
	depth?: number
	maxDepth?: number
	/** Shared recursion budget; internal callers use this to cap collection size. */
	entryBudget?: { remaining: number }
}

function* safeObjectEntries(value: object): IterableIterator<[string, unknown]> {
	let keys: string[]
	try {
		keys = Object.keys(value)
	} catch {
		return
	}

	for (const key of keys) {
		try {
			yield [key, (value as Record<string, unknown>)[key]]
		} catch {
			yield [key, '[unavailable]']
		}
	}
}

const sanitizeErrorStack = (name: string, stack: string): string => {
	const frames = stack
		.split(/\r?\n/)
		.filter(line => /^\s*at\s/.test(line))
		.join('\n')
	const safeHeader = `${sanitizeLogString(name)}: ${REDACTED}`
	return sanitizeLogString(frames ? `${safeHeader}\n${frames}` : safeHeader, MAX_STACK_LENGTH)
}

export const sanitizeLogValue = (value: unknown, options: SanitizeLogOptions = {}): unknown => {
	const extraFields = options.extraFields ?? []
	const includeErrorStack = options.includeErrorStack ?? true
	const depth = options.depth ?? 0
	const maxDepth = options.maxDepth ?? MAX_LOG_DEPTH
	const entryBudget = options.entryBudget ?? { remaining: MAX_LOG_ENTRIES }
	const consumeEntry = (): boolean => {
		if (entryBudget.remaining <= 0) return false
		entryBudget.remaining--
		return true
	}

	// messageKey is an explicitly approved operational-correlation exception.
	// It must be handled before generic "*key*" redaction, but only the six
	// standard fields below bypass sanitization.
	if (
		options.fieldName === 'messageKey' &&
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		!(value instanceof Error)
	) {
		if (depth >= maxDepth) return MAX_DEPTH_REACHED

		const seen = options.seen ?? new WeakSet<object>()
		if (seen.has(value)) return '[Circular]'
		seen.add(value)

		const messageKey: Record<string, unknown> = {}
		for (const [key, child] of safeObjectEntries(value)) {
			if (!consumeEntry()) {
				messageKey[LOG_ENTRIES_TRUNCATED] = LOG_ENTRIES_TRUNCATED
				break
			}

			const isRawCorrelationField =
				MESSAGE_KEY_CORRELATION_FIELDS.has(key) &&
				(child === null ||
					child === undefined ||
					typeof child === 'string' ||
					typeof child === 'number' ||
					typeof child === 'boolean')
			messageKey[key] = isRawCorrelationField
				? child
				: sanitizeLogValue(child, {
						fieldName: key,
						extraFields,
						seen,
						includeErrorStack,
						depth: depth + 1,
						maxDepth,
						entryBudget
					})
		}

		return messageKey
	}

	if (value === null || value === undefined) return value
	if (options.fieldName && isSensitiveField(options.fieldName, extraFields)) return REDACTED
	if (typeof value === 'string') return sanitizeLogString(value)
	if (typeof value === 'number' || typeof value === 'boolean') return value
	if (typeof value === 'bigint') return value.toString()
	if (typeof value === 'symbol' || typeof value === 'function') {
		if (typeof value === 'function') return '[Function]'
		return '[Symbol]'
	}

	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary:${value.byteLength} bytes]`
	if (typeof value !== 'object') {
		try {
			return sanitizeLogString(String(value))
		} catch {
			return '[unserializable log value]'
		}
	}

	if (depth >= maxDepth) return MAX_DEPTH_REACHED

	const seen = options.seen ?? new WeakSet<object>()
	if (seen.has(value)) return '[Circular]'
	seen.add(value)

	if (value instanceof Error) {
		const own: Record<string, unknown> = {}
		for (const [key, child] of safeObjectEntries(value)) {
			if (key === 'message' || key === 'stack') continue
			if (!consumeEntry()) {
				own[LOG_ENTRIES_TRUNCATED] = LOG_ENTRIES_TRUNCATED
				break
			}
			own[key] = sanitizeLogValue(child, {
				fieldName: key,
				extraFields,
				seen,
				includeErrorStack,
				depth: depth + 1,
				maxDepth,
				entryBudget
			})
		}

		let rawName: unknown = 'Error'
		let rawStack: unknown
		try {
			rawName = value.name || 'Error'
		} catch {
			// hostile Error subclasses can replace standard fields with getters
		}

		try {
			rawStack = value.stack
		} catch {
			// omit an unreadable stack
		}

		const errorName = typeof rawName === 'string' ? sanitizeLogString(rawName) : 'Error'
		return {
			name: errorName,
			message: REDACTED,
			stack: includeErrorStack && typeof rawStack === 'string' ? sanitizeErrorStack(errorName, rawStack) : undefined,
			...own
		}
	}

	if (value instanceof Date) {
		try {
			return value.toISOString()
		} catch {
			return '[invalid date]'
		}
	}

	if (Array.isArray(value)) {
		const sanitizedArray: unknown[] = []
		for (const item of value) {
			if (!consumeEntry()) {
				sanitizedArray.push(LOG_ENTRIES_TRUNCATED)
				break
			}
			sanitizedArray.push(
				sanitizeLogValue(item, { extraFields, seen, includeErrorStack, depth: depth + 1, maxDepth, entryBudget })
			)
		}
		return sanitizedArray
	}

	const sanitized: Record<string, unknown> = {}
	for (const [key, child] of safeObjectEntries(value)) {
		if (!consumeEntry()) {
			sanitized[LOG_ENTRIES_TRUNCATED] = LOG_ENTRIES_TRUNCATED
			break
		}

		sanitized[key] = sanitizeLogValue(child, {
			fieldName: key,
			extraFields,
			seen,
			includeErrorStack,
			depth: depth + 1,
			maxDepth,
			entryBudget
		})
	}

	return sanitized
}

export const sanitizeLogRecord = (
	value: Record<string, unknown>,
	extraFields: ReadonlyArray<string> = [],
	options: Pick<SanitizeLogOptions, 'includeErrorStack' | 'maxDepth'> = {}
): Record<string, unknown> => sanitizeLogValue(value, { extraFields, ...options }) as Record<string, unknown>

export { LOG_ENTRIES_TRUNCATED, MAX_DEPTH_REACHED, MAX_LOG_DEPTH, MAX_LOG_ENTRIES, MAX_STACK_LENGTH, REDACTED }
