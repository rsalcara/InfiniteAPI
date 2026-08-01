import { createHash } from 'crypto'
import { obfuscateJid } from './log-redaction.js'

export type TextStatusSideSubNotification = {
	hash: string
}

export type TextStatusUpdateNotification = {
	jid: string
	lastUpdateTime: string
	text: string
	emoji: string | null
	ephemeralDurationSec: number
}

const decodeMexJson = (content: string | Uint8Array): unknown => {
	const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
	return JSON.parse(text)
}

export type MexDiagnosticReason = 'missing_op_name' | 'unknown_op_name' | 'invalid_json' | 'invalid_payload_shape'

export type MexDiagnostic = {
	event: 'mex_unknown_operation'
	reason: MexDiagnosticReason
	opName: string | null
	from: string | null
	stanzaId: string | null
	timestamp: string | null
	contentType: 'none' | 'string' | 'binary' | 'node-array' | 'unknown'
	payloadLength: number
	payloadHash: string | null
	topLevelKeys: string[]
}

export const normalizeMexOperation = (operation: unknown): string | null => {
	if (typeof operation !== 'string') return null
	const normalized = operation.trim().toLowerCase()
	return normalized ? normalized : null
}

export const buildMexDiagnostic = (input: {
	reason: MexDiagnosticReason
	opName?: string | null
	from?: string | null
	stanzaId?: string | null
	timestamp?: string | null
	content?: unknown
}): MexDiagnostic => {
	let contentType: MexDiagnostic['contentType'] = 'none'
	let bytes = Buffer.alloc(0)
	let topLevelKeys: string[] = []

	if (typeof input.content === 'string') {
		contentType = 'string'
		bytes = Buffer.from(input.content, 'utf8')
	} else if (input.content instanceof Uint8Array) {
		contentType = 'binary'
		bytes = Buffer.from(input.content)
	} else if (Array.isArray(input.content)) {
		contentType = 'node-array'
	} else if (input.content !== null && input.content !== undefined) {
		contentType = 'unknown'
	}

	if (bytes.length > 0) {
		try {
			const parsed = JSON.parse(bytes.toString('utf8'))
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				topLevelKeys = Object.keys(parsed as Record<string, unknown>).sort()
			}
		} catch {
			// invalid JSON is represented by reason + hash/length, never raw content
		}
	}

	return {
		event: 'mex_unknown_operation',
		reason: input.reason,
		opName: input.opName ?? null,
		from: input.from ? obfuscateJid(input.from) : null,
		stanzaId: input.stanzaId ?? null,
		timestamp: input.timestamp ?? null,
		contentType,
		payloadLength: bytes.length,
		payloadHash: bytes.length > 0 ? createHash('sha256').update(bytes).digest('hex').slice(0, 16) : null,
		topLevelKeys
	}
}

/**
 * Parses the server-push emitted when a contact's text status/about changes.
 *
 * This is not a newsletter notification. The official Android client uses the
 * opaque hash to resolve affected side-list contacts before refreshing them.
 * InfiniteAPI exposes the hash so applications with an equivalent contact
 * index can perform that resolution without falsely treating the update as a
 * malformed newsletter payload.
 */
export const parseTextStatusSideSubNotification = (
	content: string | Uint8Array
): TextStatusSideSubNotification | null => {
	const parsed = decodeMexJson(content) as {
		data?: {
			xwa2_notify_text_status_on_update_side_sub?: {
				hash?: unknown
			}
		}
	}
	const hash = parsed?.data?.xwa2_notify_text_status_on_update_side_sub?.hash

	return typeof hash === 'string' && hash.length > 0 ? { hash } : null
}

/** Parses the full contact text-status update pushed in an `<update>` MEX node. */
export const parseTextStatusUpdateNotification = (
	content: string | Uint8Array
): TextStatusUpdateNotification | null => {
	const parsed = decodeMexJson(content) as {
		data?: {
			xwa2_notify_text_status_on_update?: {
				jid?: unknown
				last_update_time?: unknown
				text?: unknown
				emoji?: unknown
				ephemeral_duration_sec?: unknown
			}
		}
	}
	const update = parsed?.data?.xwa2_notify_text_status_on_update
	if (
		!update ||
		typeof update.jid !== 'string' ||
		typeof update.last_update_time !== 'string' ||
		typeof update.text !== 'string' ||
		(update.emoji !== null && typeof update.emoji !== 'string') ||
		typeof update.ephemeral_duration_sec !== 'number'
	) {
		return null
	}

	return {
		jid: update.jid,
		lastUpdateTime: update.last_update_time,
		text: update.text,
		emoji: update.emoji,
		ephemeralDurationSec: update.ephemeral_duration_sec
	}
}
