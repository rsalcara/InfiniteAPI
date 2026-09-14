import type { StartChatTrustSignals, StartChatTrustSignalsProvider } from '../Types'

export type StartChatTrustSignalsBridgeProviderConfig = {
	/**
	 * Base URL of a bridge backed by a genuine Android/WhatsApp client.
	 * The bridge must expose POST `/start-chat/trust-signals` (or `path`).
	 */
	url: string
	token?: string
	timeoutMs?: number
	path?: string
	fetch?: typeof fetch
}

const MAX_RESPONSE_BYTES = 256 * 1024

/**
 * Connects the preflight to an external Android laboratory/bridge.
 *
 * The bridge is responsible for running the real `CHAT_FMX` operation and
 * obtaining any Android integrity material. InfiniteAPI receives only the
 * non-sensitive parsed fields and never accepts or persists raw attestation,
 * nonce, or privacy-token bytes.
 */
export const createStartChatTrustSignalsBridgeProvider = (
	config: StartChatTrustSignalsBridgeProviderConfig
): StartChatTrustSignalsProvider => {
	if (!config || typeof config.url !== 'string' || !config.url.startsWith('http')) {
		throw new Error('start-chat trust-signals provider requires a valid http(s) url')
	}
	new URL(config.url)
	if (config.token !== undefined && typeof config.token !== 'string') {
		throw new Error('start-chat trust-signals provider token must be a string')
	}
	if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
		throw new Error('start-chat trust-signals provider timeoutMs must be positive')
	}
	const timeoutMs = config.timeoutMs ?? 10_000
	const path = config.path ?? '/start-chat/trust-signals'
	if (!path.startsWith('/')) throw new Error('start-chat trust-signals provider path must start with "/"')
	const fetchImpl = config.fetch ?? fetch

	return async ({ jid, useCase }) => {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response = await fetchImpl(`${config.url.replace(/\/$/, '')}${path}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(config.token ? { Authorization: `Bearer ${config.token}` } : {})
				},
				body: JSON.stringify({ jid, use_case: useCase }),
				signal: controller.signal
			})
			if (!response.ok) throw new Error(`start-chat trust-signals bridge returned HTTP ${response.status}`)
			const body = await readLimitedBody(response)
			const parsed = JSON.parse(body) as Record<string, unknown>
			const result: StartChatTrustSignals = {}
			if (typeof parsed.is_sender_suspicious === 'boolean') {
				result.isSenderSuspicious = parsed.is_sender_suspicious
			}
			if (typeof parsed.is_sender_new_account === 'boolean') {
				result.isSenderNewAccount = parsed.is_sender_new_account
			}
			if (typeof parsed.created_ts === 'number' && Number.isSafeInteger(parsed.created_ts) && parsed.created_ts > 0) {
				result.createdTs = parsed.created_ts
			}
			if (Object.keys(result).length === 0) {
				throw new Error('start-chat trust-signals bridge returned no valid fields')
			}
			return result
		} finally {
			clearTimeout(timeout)
		}
	}
}

const readLimitedBody = async (response: Response): Promise<string> => {
	const declaredLength = Number(response.headers?.get('content-length') ?? 0)
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new Error('start-chat trust-signals bridge response exceeds size limit')
	}
	const reader = response.body?.getReader()
	if (!reader) {
		const text = await response.text()
		if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
			throw new Error('start-chat trust-signals bridge response exceeds size limit')
		}
		return text
	}
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined)
			throw new Error('start-chat trust-signals bridge response exceeds size limit')
		}
		chunks.push(value)
	}
	const decoder = new TextDecoder()
	return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}
