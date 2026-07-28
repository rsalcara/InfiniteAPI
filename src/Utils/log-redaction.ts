const REDACTED = '[REDACTED]'
const MAX_STACK_LENGTH = 24_000
const MAX_STRING_LENGTH = 8_192

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
	'text',
	'content',
	'data'
]

const EXACT_SENSITIVE_FIELDS = new Set(['payload', 'body', 'caption', 'text', 'content', 'data'])

const JID_PATTERN = /([0-9A-Za-z._-]+(?::\d+)?)@([0-9A-Za-z.-]+)/g
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
	const jidsRedacted = value.replace(JID_PATTERN, match => obfuscateJid(match))
	const phonesRedacted = jidsRedacted.replace(PHONE_PATTERN, match => {
		const digits = match.replace(/\D/g, '')
		return `***${digits.slice(-4)}`
	})
	return truncate(phonesRedacted, limit)
}

const isSensitiveField = (key: string, extraFields: ReadonlyArray<string>): boolean => {
	const normalized = key.toLowerCase().replace(/[-\s]/g, '')
	return [...DEFAULT_SENSITIVE_FIELDS, ...extraFields].some(field => {
		const normalizedField = field.toLowerCase().replace(/[-\s]/g, '')
		return EXACT_SENSITIVE_FIELDS.has(normalizedField)
			? normalized === normalizedField
			: normalized.includes(normalizedField)
	})
}

export type SanitizeLogOptions = {
	fieldName?: string
	extraFields?: ReadonlyArray<string>
	seen?: WeakSet<object>
}

export const sanitizeLogValue = (value: unknown, options: SanitizeLogOptions = {}): unknown => {
	const extraFields = options.extraFields ?? []
	if (options.fieldName && isSensitiveField(options.fieldName, extraFields)) return REDACTED
	if (value === null || value === undefined) return value
	if (typeof value === 'string') return sanitizeLogString(value)
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value
	if (typeof value === 'symbol' || typeof value === 'function') return String(value)
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary:${value.byteLength} bytes]`
	if (typeof value !== 'object') return sanitizeLogString(String(value))

	const seen = options.seen ?? new WeakSet<object>()
	if (seen.has(value)) return '[Circular]'
	seen.add(value)

	// Message keys are operational correlation metadata used to trace a
	// transaction end-to-end across InfiniteAPI consumers. Keep the standard
	// WAMessageKey fields exactly as received, including full PN/LID JIDs and
	// message id. Unexpected properties still go through the normal sanitizer
	// so this exception cannot expose message bodies, tokens or payloads.
	if (options.fieldName === 'messageKey' && !Array.isArray(value) && !(value instanceof Error)) {
		const messageKey: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			messageKey[key] = MESSAGE_KEY_CORRELATION_FIELDS.has(key)
				? child
				: sanitizeLogValue(child, { fieldName: key, extraFields, seen })
		}
		return messageKey
	}

	if (value instanceof Error) {
		const own: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) {
			own[key] = sanitizeLogValue(child, { fieldName: key, extraFields, seen })
		}
		return {
			name: sanitizeLogString(value.name),
			message: sanitizeLogString(value.message),
			stack: value.stack ? sanitizeLogString(value.stack, MAX_STACK_LENGTH) : undefined,
			...own
		}
	}

	if (value instanceof Date) return value.toISOString()
	if (Array.isArray(value)) return value.map(item => sanitizeLogValue(item, { extraFields, seen }))

	const sanitized: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		sanitized[key] = sanitizeLogValue(child, { fieldName: key, extraFields, seen })
	}
	return sanitized
}

export const sanitizeLogRecord = (
	value: Record<string, unknown>,
	extraFields: ReadonlyArray<string> = []
): Record<string, unknown> => sanitizeLogValue(value, { extraFields }) as Record<string, unknown>

export { MAX_STACK_LENGTH, REDACTED }
