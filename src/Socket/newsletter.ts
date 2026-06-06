import { proto } from '../../WAProto/index.js'
import type { NewsletterCreateResponse, SocketConfig, WAMediaUpload } from '../Types'
import type { NewsletterMetadata, NewsletterUpdate } from '../Types'
import { QueryIds, XWAPaths } from '../Types'
import { generateProfilePicture } from '../Utils/messages-media'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../WABinary'
import { makeGroupsSocket } from './groups'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'

const parseNewsletterCreateResponse = (response: NewsletterCreateResponse): NewsletterMetadata => {
	// Validate response structure before destructuring
	if (!response?.id || !response?.thread_metadata) {
		throw new Error('Invalid newsletter response: missing id or thread_metadata')
	}

	const { id, thread_metadata: thread, viewer_metadata: viewer } = response

	// Validate required thread metadata fields
	if (!thread.name?.text) {
		throw new Error('Invalid newsletter response: missing thread name')
	}

	return {
		id: id,
		owner: undefined,
		name: thread.name.text,
		creation_time: parseInt(thread.creation_time, 10) || 0,
		description: thread.description?.text || '',
		invite: thread.invite || '',
		subscribers: parseInt(thread.subscribers_count, 10) || 0,
		verification: thread.verification,
		picture: thread.picture
			? {
					id: thread.picture.id || '',
					directPath: thread.picture.direct_path || ''
				}
			: { id: '', directPath: '' },
		mute_state: viewer?.mute
	}
}

const parseNewsletterMetadata = (result: unknown): NewsletterMetadata | null => {
	// Port of upstream PR #2620 (vinikjkkj). Earlier behavior cast the raw
	// server response to `NewsletterMetadata` whole, which broke two
	// callers in practice:
	//   1. The actual response shape uses snake_case (`thread_metadata.
	//      subscribers_count`, `picture.direct_path`) while
	//      `NewsletterMetadata` is the flat camelCase shape we expose —
	//      casting lost the channel name, subscribers count, etc.
	//   2. For preview-only responses (e.g. fetching a non-followed
	//      channel via invite), `thread_metadata.picture` is absent and
	//      the server returns `image` / `preview` siblings instead, so
	//      reading `.picture` alone returned undefined.
	//
	// Fix: unwrap the `result` envelope if present, require a string `id`,
	// and translate fields into the flat shape with the documented
	// fallback chain for the picture.
	if (typeof result !== 'object' || result === null) {
		return null
	}

	const raw = result as Record<string, unknown>
	const node = (raw.result && typeof raw.result === 'object' ? raw.result : raw) as Record<string, any>

	if (typeof node.id !== 'string') {
		return null
	}

	const thread = node.thread_metadata ?? {}
	const viewer = node.viewer_metadata ?? {}
	const pic = thread.picture ?? thread.image ?? thread.preview

	return {
		id: node.id,
		name: thread.name?.text ?? '',
		description: thread.description?.text,
		invite: thread.invite,
		creation_time: thread.creation_time ? parseInt(thread.creation_time, 10) : undefined,
		subscribers: thread.subscribers_count ? parseInt(thread.subscribers_count, 10) : undefined,
		picture: pic ? { id: pic.id, directPath: pic.direct_path } : undefined,
		verification: thread.verification,
		mute_state: viewer.mute
	}
}

/**
 * Parse a single `<message>` node from a newsletter `<messages>` response.
 *
 * Port of upstream PR #2620 (vinikjkkj). The server wraps the proto-encoded
 * `Message` in a `<plaintext>` child and adorns the node with counters
 * (views/forwards/responses), edit metadata, reaction tallies, poll vote
 * tallies and an optional `<rcat>` blob for media-category routing. Returning
 * the full structured shape lets callers see all of that without re-parsing.
 */
const parseFetchedNewsletterMessage = (node: BinaryNode) => {
	const plaintext = getBinaryNodeChild(node, 'plaintext')
	const plaintextContent = plaintext?.content
	const meta = getBinaryNodeChild(node, 'meta')
	const viewsCount = getBinaryNodeChild(node, 'views_count')
	const forwardsCount = getBinaryNodeChild(node, 'forwards_count')
	const responsesCount = getBinaryNodeChild(node, 'responses_count')
	const rcat = getBinaryNodeChild(node, 'rcat')

	const reactionsNode = getBinaryNodeChild(node, 'reactions')
	const reactions = reactionsNode
		? getBinaryNodeChildren(reactionsNode, 'reaction').map(r => ({
				code: r.attrs.code,
				count: r.attrs.count ? parseInt(r.attrs.count, 10) : 0
			}))
		: []

	const votesNode = getBinaryNodeChild(node, 'votes')
	const pollVotes = votesNode
		? getBinaryNodeChildren(votesNode, 'vote').map(v => ({
				count: v.attrs.count ? parseInt(v.attrs.count, 10) : 0,
				hash: v.content instanceof Uint8Array ? v.content : undefined
			}))
		: []

	let message: proto.IMessage | undefined
	if (plaintextContent instanceof Uint8Array) {
		try {
			message = proto.Message.decode(plaintextContent)
		} catch {
			message = undefined
		}
	}

	return {
		id: node.attrs.id,
		serverId: node.attrs.server_id,
		type: node.attrs.type,
		timestamp: node.attrs.t ? parseInt(node.attrs.t, 10) : undefined,
		isSender: node.attrs.is_sender === 'true',
		views: viewsCount?.attrs?.count ? parseInt(viewsCount.attrs.count, 10) : undefined,
		forwards: forwardsCount?.attrs?.count ? parseInt(forwardsCount.attrs.count, 10) : undefined,
		responses: responsesCount?.attrs?.count ? parseInt(responsesCount.attrs.count, 10) : undefined,
		editTimestamp: meta?.attrs?.msg_edit_t ? parseInt(meta.attrs.msg_edit_t, 10) : undefined,
		originalTimestamp: meta?.attrs?.original_msg_t ? parseInt(meta.attrs.original_msg_t, 10) : undefined,
		mediaRcat: rcat?.content instanceof Uint8Array ? rcat.content : undefined,
		reactions,
		pollVotes,
		message
	}
}

export const makeNewsletterSocket = (config: SocketConfig) => {
	const sock = makeGroupsSocket(config)
	const { query, generateMessageTag } = sock

	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		return genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)
	}

	const newsletterUpdate = async (jid: string, updates: NewsletterUpdate) => {
		const variables = {
			newsletter_id: jid,
			updates: {
				...updates,
				settings: null
			}
		}
		return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
	}

	return {
		...sock,
		newsletterCreate: async (name: string, description?: string): Promise<NewsletterMetadata> => {
			const variables = {
				input: {
					name,
					description: description ?? null
				}
			}
			const rawResponse = await executeWMexQuery<NewsletterCreateResponse>(
				variables,
				QueryIds.CREATE,
				XWAPaths.xwa2_newsletter_create
			)
			return parseNewsletterCreateResponse(rawResponse)
		},

		newsletterUpdate,

		newsletterSubscribers: async (jid: string) => {
			return executeWMexQuery<{ subscribers: number }>(
				{ newsletter_id: jid },
				QueryIds.SUBSCRIBERS,
				XWAPaths.xwa2_newsletter_subscribers
			)
		},

		newsletterMetadata: async (type: 'invite' | 'jid', key: string) => {
			const variables = {
				fetch_creation_time: true,
				fetch_full_image: true,
				fetch_viewer_metadata: true,
				input: {
					key,
					type: type.toUpperCase()
				}
			}
			const result = await executeWMexQuery<unknown>(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
			return parseNewsletterMetadata(result)
		},

		newsletterFollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2)
		},

		newsletterUnfollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2)
		},

		newsletterMute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2)
		},

		newsletterUnmute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2)
		},

		newsletterUpdateName: async (jid: string, name: string) => {
			return await newsletterUpdate(jid, { name })
		},

		newsletterUpdateDescription: async (jid: string, description: string) => {
			return await newsletterUpdate(jid, { description })
		},

		newsletterUpdatePicture: async (jid: string, content: WAMediaUpload) => {
			const { img } = await generateProfilePicture(content)
			return await newsletterUpdate(jid, { picture: img.toString('base64') })
		},

		newsletterRemovePicture: async (jid: string) => {
			return await newsletterUpdate(jid, { picture: '' })
		},

		newsletterReactMessage: async (jid: string, serverId: string, reaction?: string) => {
			await query({
				tag: 'message',
				attrs: {
					to: jid,
					...(reaction ? {} : { edit: '7' }),
					type: 'reaction',
					server_id: serverId,
					id: generateMessageTag()
				},
				content: [
					{
						tag: 'reaction',
						attrs: reaction ? { code: reaction } : {}
					}
				]
			})
		},

		newsletterFetchMessages: async (jid: string, count: number, since: number, after: number) => {
			// Port of upstream PR #2620 (vinikjkkj). The previous shape was
			// `<iq to='<channel-jid>' xmlns='newsletter'><message_updates count
			// since after/></iq>` which the server simply doesn't answer — it
			// hangs until the request times out (#2555 in upstream).
			//
			// The correct shape, captured from WA Web, is:
			//   <iq to='s.whatsapp.net' xmlns='newsletter'>
			//     <messages type='jid' jid='<channel-jid>' count='N' [before/after]/>
			//   </iq>
			//
			// Note also: the param name flipped from `since` to `before` in the
			// XML attribute. The function signature stays the same so existing
			// callers keep working.
			const messagesAttrs: { type: string; jid: string; count: string; before?: string; after?: string } = {
				type: 'jid',
				jid,
				count: count.toString()
			}
			if (typeof since === 'number' && since) {
				messagesAttrs.before = since.toString()
			}

			if (after) {
				messagesAttrs.after = after.toString()
			}

			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'get',
					to: S_WHATSAPP_NET,
					xmlns: 'newsletter'
				},
				content: [
					{
						tag: 'messages',
						attrs: messagesAttrs
					}
				]
			})

			const messagesNode = getBinaryNodeChild(result, 'messages')
			return getBinaryNodeChildren(messagesNode, 'message').map(parseFetchedNewsletterMessage)
		},

		subscribeNewsletterUpdates: async (jid: string): Promise<{ duration: string } | null> => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [{ tag: 'live_updates', attrs: {}, content: [] }]
			})
			const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
			const duration = liveUpdatesNode?.attrs?.duration
			return duration ? { duration: duration } : null
		},

		newsletterAdminCount: async (jid: string): Promise<number> => {
			const response = await executeWMexQuery<{ admin_count: number }>(
				{ newsletter_id: jid },
				QueryIds.ADMIN_COUNT,
				XWAPaths.xwa2_newsletter_admin_count
			)
			return response.admin_count
		},

		newsletterChangeOwner: async (jid: string, newOwnerJid: string) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: newOwnerJid },
				QueryIds.CHANGE_OWNER,
				XWAPaths.xwa2_newsletter_change_owner
			)
		},

		newsletterDemote: async (jid: string, userJid: string) => {
			await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote)
		},

		newsletterDelete: async (jid: string) => {
			await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2)
		}
	}
}

export type NewsletterSocket = ReturnType<typeof makeNewsletterSocket>
