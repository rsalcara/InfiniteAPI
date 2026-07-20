export type RetryReceiptRouteSource = 'recent-message-cache' | 'recipient-attribute' | 'stanza-remote-context'

export interface RetryReceiptRouteInput {
	stanzaFrom: string
	recipient?: string
	isNodeFromMe: boolean
	isGroup: boolean
	recentMessageTo?: string
}

/**
 * Preserve the original chat route for retry receipts. WhatsApp can omit the
 * `recipient` attribute on own-device/LID receipts; the stanza's remote
 * context remains a valid fallback and must never be replaced with undefined.
 */
export const resolveRetryReceiptRoute = ({
	stanzaFrom,
	recipient,
	isNodeFromMe,
	isGroup,
	recentMessageTo
}: RetryReceiptRouteInput): { remoteJid: string; source: RetryReceiptRouteSource } => {
	if (recentMessageTo) return { remoteJid: recentMessageTo, source: 'recent-message-cache' }
	if (!isNodeFromMe || isGroup) return { remoteJid: stanzaFrom, source: 'stanza-remote-context' }
	if (recipient) return { remoteJid: recipient, source: 'recipient-attribute' }
	return { remoteJid: stanzaFrom, source: 'stanza-remote-context' }
}

/** Pure state transition used inside the per-message retry lock. */
export const nextRetrySendAttempt = (current: number, maximum: number): { proceed: boolean; count: number } =>
	current >= maximum ? { proceed: false, count: current } : { proceed: true, count: current + 1 }
