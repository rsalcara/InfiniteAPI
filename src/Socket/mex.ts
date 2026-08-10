import { Boom } from '@hapi/boom'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

export type MexPrivacyToken = { token: Buffer; timestamp?: string | number }
export type MexContactProfileQueryUser = { jid: string; privacyToken?: MexPrivacyToken }
export type WMexQueryOptions = { includeQueryId?: boolean; includeTrace?: boolean }

export const MEX_CONTACT_PROFILE_QUERY_ID = '32735378489440100'
export const MEX_CONTACT_PROFILE_BATCH_SIZE = 40

/** Official MEX USync shape. Callers opt in only for a known regular-user target. */
export const withMexPrivacyToken = (
	variables: Record<string, unknown>,
	privacyToken?: MexPrivacyToken
): Record<string, unknown> => {
	if (!privacyToken?.token.length) return variables

	return {
		...variables,
		privacy_token: {
			tctoken: privacyToken.token.toString('base64'),
			...(privacyToken.timestamp !== undefined ? { timestamp: String(privacyToken.timestamp) } : {})
		}
	}
}

/** Exact variable envelope captured from Android's background profile enrichment query. */
export const buildMexContactProfileVariables = (
	users: readonly MexContactProfileQueryUser[]
): Record<string, unknown> => ({
	include_picture: true,
	input: {
		query_input: users.map(({ jid, privacyToken }) => withMexPrivacyToken({ jid }, privacyToken)),
		telemetry: { context: 'BACKGROUND' }
	},
	picture_field_input: { type: 'IMAGE' }
})

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string,
	options: WMexQueryOptions = {}
) => {
	const content: BinaryNode[] = []
	if (options.includeTrace) {
		content.push({
			tag: 'trace',
			attrs: {},
			content: [{ tag: 'flow_id', attrs: {}, content: Buffer.from(queryId, 'utf-8') }]
		})
	}

	content.push({
		tag: 'query',
		attrs: { query_id: queryId },
		content: Buffer.from(JSON.stringify(options.includeQueryId ? { queryId, variables } : { variables }), 'utf-8')
	})

	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content
	})
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string,
	options: WMexQueryOptions = {}
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag, options)
	const child = getBinaryNodeChild(result, 'result')
	if (child?.content) {
		const data = JSON.parse(child.content.toString())

		if (data.errors && data.errors.length > 0) {
			const errorMessages = data.errors.map((err: Error) => err.message || 'Unknown error').join(', ')
			const firstError = data.errors[0]
			const errorCode = firstError.extensions?.error_code || 400
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}

		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') {
			return response as T
		}
	}

	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ')
	throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
}
