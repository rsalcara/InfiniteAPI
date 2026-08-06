import type { USyncQueryProtocol } from '../Types/USync'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary'
import { USyncBotProfileProtocol } from './Protocols/UsyncBotProfileProtocol'
import { USyncLIDProtocol } from './Protocols/UsyncLIDProtocol'
import {
	USyncContactProtocol,
	USyncDeviceProtocol,
	USyncDisappearingModeProtocol,
	USyncStatusProtocol,
	USyncUsernameProtocol
} from './Protocols'
import { USyncUser } from './USyncUser'

export type USyncContactType = 'in' | 'out' | 'invalid'

/**
 * A USync row contains more than one identity. WhatsApp uses the PN (`jid`),
 * the LID (`new_jid`/`lid`) and, for some rollout cohorts, an explicit
 * `pn_jid` alias. Keep all of them: collapsing the row to `id` makes a cold
 * recipient impossible to route reliably after the first lookup.
 */
export type USyncQueryResultList = {
	[protocol: string]: unknown
	id: string
	jid?: string
	pnJid?: string
	newJid?: string
	lid?: string
	contactType?: USyncContactType
	username?: string
}

export type USyncQueryResult = {
	list: USyncQueryResultList[]
	sideList: USyncQueryResultList[]
}

export class USyncQuery {
	protocols: USyncQueryProtocol[]
	users: USyncUser[]
	context: string
	mode: string

	constructor() {
		this.protocols = []
		this.users = []
		this.context = 'interactive'
		this.mode = 'query'
	}

	withMode(mode: string) {
		this.mode = mode
		return this
	}

	withContext(context: string) {
		this.context = context
		return this
	}

	withUser(user: USyncUser) {
		this.users.push(user)
		return this
	}

	buildUserNode(user: USyncUser): BinaryNode {
		const content = this.protocols.map(protocol => protocol.getUserElement(user)).filter(node => node !== null)
		if (user.privacyToken?.token.length) {
			content.push({ tag: 'tctoken', attrs: {}, content: Buffer.from(user.privacyToken.token) })
		}

		return {
			tag: 'user',
			attrs: !user.phone && user.id ? { jid: user.id } : {},
			content
		}
	}

	parseUSyncQueryResult(result: BinaryNode | undefined): USyncQueryResult | undefined {
		if (result?.attrs.type !== 'result') {
			return
		}

		const protocolMap = Object.fromEntries(
			this.protocols.map(protocol => {
				return [protocol.name, protocol.parser]
			})
		)

		const queryResult: USyncQueryResult = {
			// TODO: implement errors etc.
			list: [],
			sideList: []
		}

		const usyncNode = getBinaryNodeChild(result, 'usync')

		//TODO: implement error backoff, refresh etc.
		//TODO: see if there are any errors in the result node
		//const resultNode = getBinaryNodeChild(usyncNode, 'result')

		const listNode = usyncNode ? getBinaryNodeChild(usyncNode, 'list') : undefined

		if (listNode?.content && Array.isArray(listNode.content)) {
			queryResult.list = listNode.content.reduce((acc: USyncQueryResultList[], node) => {
				const jid = node?.attrs?.jid
				const pnJid = node?.attrs?.pn_jid
				const newJid = node?.attrs?.new_jid
				const lid = node?.attrs?.lid
				const id = jid || newJid || pnJid
				if (id) {
					const data = Array.isArray(node?.content)
						? Object.fromEntries(
								node.content
									.map(content => {
										const protocol = content.tag
										const parser = protocolMap[protocol]
										if (parser) {
											return [protocol, parser(content)]
										} else {
											return [protocol, null]
										}
									})
									.filter(([, b]) => b !== null) as [string, unknown][]
							)
						: {}
					const contactNode = Array.isArray(node?.content)
						? node.content.find(content => content.tag === 'contact')
						: undefined
					const contactType = contactNode?.attrs?.type
					const username = typeof data.username === 'string' ? data.username : undefined
					acc.push({
						...data,
						id,
						...(jid ? { jid } : {}),
						...(pnJid ? { pnJid } : {}),
						...(newJid ? { newJid } : {}),
						...(lid ? { lid } : {}),
						...(contactType === 'in' || contactType === 'out' || contactType === 'invalid' ? { contactType } : {}),
						...(username ? { username } : {})
					})
				}

				return acc
			}, [])
		}

		//TODO: implement side list
		//const sideListNode = getBinaryNodeChild(usyncNode, 'side_list')
		return queryResult
	}

	withDeviceProtocol() {
		this.protocols.push(new USyncDeviceProtocol())
		return this
	}

	withContactProtocol() {
		this.protocols.push(new USyncContactProtocol())
		return this
	}

	withStatusProtocol() {
		this.protocols.push(new USyncStatusProtocol())
		return this
	}

	withDisappearingModeProtocol() {
		this.protocols.push(new USyncDisappearingModeProtocol())
		return this
	}

	withBotProfileProtocol() {
		this.protocols.push(new USyncBotProfileProtocol())
		return this
	}

	withLIDProtocol() {
		this.protocols.push(new USyncLIDProtocol())
		return this
	}

	withUsernameProtocol() {
		this.protocols.push(new USyncUsernameProtocol())
		return this
	}
}
