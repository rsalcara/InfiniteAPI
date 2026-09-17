import type { StartChatTrustSignals, StartChatTrustSignalsProvider } from '../Types'
import type { StartChatTrustSignalsRecord, StartChatTrustSignalsState } from '../Types'
import { QueryIds, XWAPaths } from '../Types'
import type { BinaryNode } from '../WABinary'
import { executeWMexQuery } from './mex'

export type StartChatTrustSignalsPrivacyToken = {
	/** Present only for a previously received, still-valid contact token. */
	token?: Buffer | Uint8Array
	timestamp?: string | number
}

type StartChatContextIntegrityVariables = {
	jid: string
	privacyToken?: StartChatTrustSignalsPrivacyToken
}

type StartChatContextIntegrityResponseUser = {
	jid?: unknown
	integrity_signals_info?: {
		is_new_account?: unknown
		is_suspicious_start_chat?: unknown
	}
}

export type StartChatTrustSignalsNativeProviderConfig = {
	query: (node: BinaryNode) => Promise<BinaryNode>
	generateMessageTag: () => string
	/**
	 * Reads a genuinely received contact token from canonical and freshly
	 * resolved aliases; never creates or substitutes one.
	 */
	resolvePrivacyToken?: (request: {
		jid: string
		pnJid?: string
	}) => Promise<StartChatTrustSignalsPrivacyToken | undefined>
	queryId?: string
}

type ResolvedPrivacyToken = {
	buffer?: Uint8Array
	timestamp?: string | number
}

/**
 * Converts the generic TC-token resolver result to the GraphQL wire shape.
 * This boundary is deliberately explicit: an absent buffer never becomes an
 * empty or synthetic token.
 */
export const toStartChatTrustSignalsPrivacyToken = (
	resolved: ResolvedPrivacyToken
): StartChatTrustSignalsPrivacyToken | undefined => {
	if (!resolved.buffer?.length) return undefined
	return {
		token: resolved.buffer,
		...(resolved.timestamp === undefined ? {} : { timestamp: resolved.timestamp })
	}
}

/** Reuses a durable official observation without re-dispatching the native query. */
export const startChatTrustSignalsStateFromRecord = (
	record: StartChatTrustSignalsRecord,
	base: Pick<StartChatTrustSignalsState, 'jid' | 'observedAt'>
): StartChatTrustSignalsState => ({
	jid: base.jid,
	useCase: 'CHAT_FMX',
	status: 'known',
	observedAt: base.observedAt,
	signals: {
		...(record.isSenderNewAccount === undefined ? {} : { isSenderNewAccount: record.isSenderNewAccount }),
		...(record.isSenderSuspicious === undefined ? {} : { isSenderSuspicious: record.isSenderSuspicious }),
		createdTs: record.observedAt
	}
})

/**
 * A timestamp alone is durable observation metadata. Native lookup is still
 * required until at least one genuine Android signal boolean was observed.
 */
export const isStartChatTrustSignalsRecordReusable = (
	record: Pick<StartChatTrustSignalsRecord, 'isSenderNewAccount' | 'isSenderSuspicious'>
): boolean => typeof record.isSenderSuspicious === 'boolean' || typeof record.isSenderNewAccount === 'boolean'

/**
 * Builds the exact `StartChatContextIntegrityQuery` variables used by Android
 * for the first-chat `CHAT_FMX` lookup. `privacy_token` is included only when
 * a previously received token exists, as the official client does.
 */
export const buildStartChatContextIntegrityVariables = ({
	jid,
	privacyToken
}: StartChatContextIntegrityVariables): Record<string, unknown> => ({
	input: {
		query_input: [
			{
				jid,
				integrity_signals: {
					dhash: null,
					use_case: 'CHAT_FMX'
				},
				...(privacyToken?.token?.length
					? {
							privacy_token: {
								tctoken: Buffer.from(privacyToken.token).toString('base64'),
								...(privacyToken.timestamp === undefined ? {} : { timestamp: String(privacyToken.timestamp) })
							}
						}
					: {})
			}
		],
		telemetry: {
			context: 'INTERACTIVE'
		}
	}
})

const asBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/**
 * Executes the official Android operation directly through `w:mex`. The parser
 * deliberately exposes only the two booleans persisted by the Android
 * `start_chat_trust_signals` flow; richer profile fields are not part of this
 * lifecycle and must not be interpreted as attestation.
 */
export const createStartChatTrustSignalsNativeProvider = (
	config: StartChatTrustSignalsNativeProviderConfig
): StartChatTrustSignalsProvider => {
	if (typeof config.query !== 'function') throw new Error('start-chat native provider requires a socket query')
	if (typeof config.generateMessageTag !== 'function') {
		throw new Error('start-chat native provider requires a message tag generator')
	}

	if (config.resolvePrivacyToken !== undefined && typeof config.resolvePrivacyToken !== 'function') {
		throw new Error('start-chat native provider privacy token resolver must be a function')
	}

	const queryId = config.queryId ?? QueryIds.START_CHAT_CONTEXT_INTEGRITY

	return async ({ jid, pnJid, signal }) => {
		if (signal?.aborted) throw new Error('start-chat native request aborted before dispatch')

		const privacyToken = config.resolvePrivacyToken
			? await config.resolvePrivacyToken({ jid, pnJid: pnJid })
			: undefined
		if (signal?.aborted) throw new Error('start-chat native request aborted after privacy-token resolution')

		const users = await executeWMexQuery<StartChatContextIntegrityResponseUser[]>(
			buildStartChatContextIntegrityVariables({ jid, privacyToken }),
			queryId,
			XWAPaths.xwa2_fetch_wa_users,
			config.query,
			config.generateMessageTag
		)

		if (signal?.aborted) throw new Error('start-chat native request aborted before response validation')

		const user = Array.isArray(users) ? users.find(candidate => candidate?.jid === jid) : undefined
		const info = user?.integrity_signals_info
		const result: StartChatTrustSignals = {
			createdTs: Date.now()
		}

		const isSenderNewAccount = asBoolean(info?.is_new_account)
		const isSenderSuspicious = asBoolean(info?.is_suspicious_start_chat)
		if (isSenderNewAccount !== undefined) result.isSenderNewAccount = isSenderNewAccount
		if (isSenderSuspicious !== undefined) result.isSenderSuspicious = isSenderSuspicious

		if (!user || (isSenderNewAccount === undefined && isSenderSuspicious === undefined)) {
			throw new Error('start-chat native provider returned no valid fields')
		}

		return result
	}
}
