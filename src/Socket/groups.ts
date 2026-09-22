import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type {
	GroupMetadata,
	GroupOverview,
	GroupParticipant,
	GroupRoutingInfo,
	GroupSettingType,
	MemberShareHistoryMode,
	ParticipantAction,
	ReportedGroupMessage,
	SocketConfig,
	WAMessageKey
} from '../Types'
import { WAMessageAddressingMode, WAMessageStubType } from '../Types'
import { captureProtocolWire, generateMessageIDV2, resolveLidToPn, unixTimestampSeconds } from '../Utils'
import { safeCacheSet } from '../Utils/cache-utils'
import { buildGroupParticipantNode, mapParticipantFanout, MAX_PARTICIPANT_FANOUT } from '../Utils/relay-stanza'
import { resolveTcTokenBucketPolicy, resolveUsableTcTokenForJid } from '../Utils/tc-token-utils'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isLidUser,
	isPnUser,
	jidEncode,
	jidNormalizedUser
} from '../WABinary'
import { makeChatsSocket } from './chats'

export const makeGroupsSocket = (config: SocketConfig) => {
	const sock = makeChatsSocket(config)
	const { authState, ev, generateMessageTag, query, upsertMessage } = sock
	const { signalRepository } = sock
	const { logger } = config
	const tcTokenBucketPolicy = resolveTcTokenBucketPolicy(config.transportProfile, config.tcTokenAbProps)
	const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping)
	const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping)
	const buildPrivacyParticipantNodes = async (participants: string[]): Promise<BinaryNode[]> => {
		const enabled = config.tcTokenFanout?.enabled ?? false
		const maxUsers = config.tcTokenFanout?.maxUsers ?? 2000
		if (!Number.isInteger(maxUsers) || maxUsers < 0) {
			throw new Boom('TcToken fanout user limit must be non-negative')
		}

		const tokenUsers = new Set<string>()
		if (enabled) {
			for (const participant of participants) {
				if (tokenUsers.size >= maxUsers) break
				tokenUsers.add(jidNormalizedUser(participant))
			}
		}

		return mapParticipantFanout(
			participants,
			async participantJid => {
				if (!tokenUsers.has(jidNormalizedUser(participantJid))) return buildGroupParticipantNode(participantJid)
				try {
					const token = await resolveUsableTcTokenForJid({
						authState,
						jid: participantJid,
						getLIDForPN,
						getPNForLID,
						bucketPolicy: tcTokenBucketPolicy
					})
					return buildGroupParticipantNode(participantJid, token.buffer)
				} catch (error) {
					logger.debug({ error, participantJid }, 'group participant TcToken lookup skipped')
					return buildGroupParticipantNode(participantJid)
				}
			},
			{ max: MAX_PARTICIPANT_FANOUT, concurrency: 32 }
		)
	}

	/** Normalize group metadata participant IDs from LID to PN */
	const normalizeGroupMetadata = async (metadata: GroupMetadata): Promise<GroupMetadata> => {
		const lidMapping = signalRepository.lidMapping

		// Resolve all participant LIDs in parallel for better performance on large groups
		await Promise.all(
			metadata.participants.map(async p => {
				if (isLidUser(p.id)) {
					if (p.phoneNumber) {
						p.lid = p.id
						p.id = p.phoneNumber
					} else {
						const resolved = await resolveLidToPn(p.id, lidMapping, logger)
						if (resolved && resolved !== p.id) {
							p.lid = p.id
							p.id = resolved
						}
					}
				}
			})
		)

		// Normalize owner/subjectOwner if LID (parallel)
		const [resolvedOwner, resolvedSubjectOwner] = await Promise.all([
			metadata.owner && isLidUser(metadata.owner)
				? metadata.ownerPn || resolveLidToPn(metadata.owner, lidMapping, logger)
				: null,
			metadata.subjectOwner && isLidUser(metadata.subjectOwner)
				? metadata.subjectOwnerPn || resolveLidToPn(metadata.subjectOwner, lidMapping, logger)
				: null
		])
		if (resolvedOwner) metadata.owner = resolvedOwner
		if (resolvedSubjectOwner) metadata.subjectOwner = resolvedSubjectOwner

		return metadata
	}

	const groupQuery = async (
		jid: string,
		type: 'get' | 'set',
		content: BinaryNode[],
		captureKind?: 'legacy_group_create'
	) => {
		const node: BinaryNode = {
			tag: 'iq',
			attrs: {
				id: generateMessageTag(),
				type,
				xmlns: 'w:g2',
				to: jid
			},
			content
		}
		if (captureKind) await captureProtocolWire(config.protocolWireCapture, captureKind, node, logger)
		return query(node)
	}

	const groupMetadata = async (jid: string) => {
		const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
		return normalizeGroupMetadata(extractGroupMetadata(result))
	}

	const groupFetchAllParticipating = async () => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: '@g.us',
				xmlns: 'w:g2',
				type: 'get'
			},
			content: [
				{
					tag: 'participating',
					attrs: {},
					content: [
						{ tag: 'participants', attrs: {} },
						{ tag: 'description', attrs: {} }
					]
				}
			]
		})
		const data: { [_: string]: GroupMetadata } = {}
		const groupsChild = getBinaryNodeChild(result, 'groups')
		if (groupsChild) {
			const groups = getBinaryNodeChildren(groupsChild, 'group')
			for (const groupNode of groups) {
				const meta = await normalizeGroupMetadata(
					extractGroupMetadata({
						tag: 'result',
						attrs: {},
						content: [groupNode]
					})
				)
				data[meta.id] = meta
			}
		}

		sock.ev.emit('groups.update', Object.values(data))

		return data
	}

	// Routing cache — hoisted to socket scope for invalidation on participant updates
	const routingCache = new NodeCache<GroupRoutingInfo>({ stdTTL: 300, maxKeys: 500, useClones: false })

	sock.ev.on('group-participants.update', async ({ id }: { id: string }) => {
		routingCache.del(id)
	})

	sock.ev.on('groups.update', async (updates: Partial<GroupMetadata>[]) => {
		for (const update of updates) {
			if (update.id) routingCache.del(update.id)
		}
	})

	sock.ws.on('CB:ib,,dirty', async (node: BinaryNode) => {
		const { attrs } = getBinaryNodeChild(node, 'dirty')!
		if (attrs.type !== 'groups') {
			return
		}

		await groupFetchAllParticipating()
		await sock.cleanDirtyBits('groups')
	})

	return {
		...sock,
		groupMetadata,
		groupCreate: async (subject: string, participants: string[]) => {
			const key = generateMessageIDV2()
			const participantNodes = await buildPrivacyParticipantNodes(participants)
			const result = await groupQuery(
				'@g.us',
				'set',
				[
					{
						tag: 'create',
						attrs: {
							subject,
							key
						},
						content: participantNodes
					}
				],
				'legacy_group_create'
			)
			return normalizeGroupMetadata(extractGroupMetadata(result))
		},
		groupLeave: async (id: string) => {
			await groupQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'group', attrs: { id } }]
				}
			])
		},
		groupUpdateSubject: async (jid: string, subject: string) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8')
				}
			])
		},
		groupRequestParticipantsList: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [
				{
					tag: 'membership_approval_requests',
					attrs: {}
				}
			])
			const node = getBinaryNodeChild(result, 'membership_approval_requests')
			const participants = getBinaryNodeChildren(node, 'membership_approval_request')
			return participants.map(v => v.attrs)
		},
		groupRequestParticipantsUpdate: async (jid: string, participants: string[], action: 'approve' | 'reject') => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: 'membership_requests_action',
					attrs: {},
					content: [
						{
							tag: action,
							attrs: {},
							content: participants.map(jid => ({
								tag: 'participant',
								attrs: { jid }
							}))
						}
					]
				}
			])
			const node = getBinaryNodeChild(result, 'membership_requests_action')
			const nodeAction = getBinaryNodeChild(node, action)
			const participantsAffected = getBinaryNodeChildren(nodeAction, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid }
			})
		},
		groupParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			// Android's privacy child is used for participant add, and the same
			// participant shape is used by legacy group creation. Other actions
			// retain their wire contract exactly.
			const participantNodes =
				action === 'add'
					? await buildPrivacyParticipantNodes(participants)
					: participants.map(participantJid => buildGroupParticipantNode(participantJid))
			const result = await groupQuery(jid, 'set', [
				{
					tag: action,
					attrs: {},
					content: participantNodes
				}
			])
			const node = getBinaryNodeChild(result, action)
			const participantsAffected = getBinaryNodeChildren(node, 'participant')
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid, content: p }
			})
		},
		groupUpdateDescription: async (jid: string, description?: string) => {
			const metadata = await groupMetadata(jid)
			const prev = metadata.descId ?? null

			await groupQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: {
						...(description ? { id: generateMessageIDV2() } : { delete: 'true' }),
						...(prev ? { prev } : {})
					},
					content: description ? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }] : undefined
				}
			])
		},
		groupInviteCode: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupRevokeInvite: async (jid: string) => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }])
			const inviteNode = getBinaryNodeChild(result, 'invite')
			return inviteNode?.attrs.code
		},
		groupAcceptInvite: async (code: string) => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }])
			const result = getBinaryNodeChild(results, 'group')
			return result?.attrs.jid
		},

		/**
		 * revoke a v4 invite for someone
		 * @param groupJid group jid
		 * @param invitedJid jid of person you invited
		 * @returns true if successful
		 */
		groupRevokeInviteV4: async (groupJid: string, invitedJid: string) => {
			const result = await groupQuery(groupJid, 'set', [
				{ tag: 'revoke', attrs: {}, content: [{ tag: 'participant', attrs: { jid: invitedJid } }] }
			])
			return !!result
		},

		/**
		 * accept a GroupInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		groupAcceptInviteV4: ev.createBufferedFunction(
			async (key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => {
				key = typeof key === 'string' ? { remoteJid: key } : key
				const results = await groupQuery(inviteMessage.groupJid!, 'set', [
					{
						tag: 'accept',
						attrs: {
							code: inviteMessage.inviteCode!,
							expiration: inviteMessage.inviteExpiration!.toString(),
							admin: key.remoteJid!
						}
					}
				])

				// if we have the full message key
				// update the invite message to be expired
				if (key.id) {
					// create new invite message that is expired
					inviteMessage = proto.Message.GroupInviteMessage.fromObject(inviteMessage)
					inviteMessage.inviteExpiration = 0
					inviteMessage.inviteCode = ''
					ev.emit('messages.update', [
						{
							key,
							update: {
								message: {
									groupInviteMessage: inviteMessage
								}
							}
						}
					])
				}

				// generate the group add message
				await upsertMessage(
					{
						key: {
							remoteJid: inviteMessage.groupJid,
							id: generateMessageIDV2(sock.user?.id),
							fromMe: false,
							participant: key.remoteJid
						},
						messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
						messageStubParameters: [JSON.stringify(authState.creds.me)],
						participant: key.remoteJid,
						messageTimestamp: unixTimestampSeconds()
					},
					'notify'
				)

				return results.attrs.from
			}
		),
		groupGetInviteInfo: async (code: string) => {
			const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }])
			return normalizeGroupMetadata(extractGroupMetadata(results))
		},
		groupToggleEphemeral: async (jid: string, ephemeralExpiration: number) => {
			const content: BinaryNode = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} }
			await groupQuery(jid, 'set', [content])
		},
		groupSettingUpdate: async (jid: string, setting: GroupSettingType) => {
			await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }])
		},
		groupMemberAddMode: async (jid: string, mode: 'admin_add' | 'all_member_add') => {
			await groupQuery(jid, 'set', [{ tag: 'member_add_mode', attrs: {}, content: mode }])
		},
		groupJoinApprovalMode: async (jid: string, mode: 'on' | 'off') => {
			await groupQuery(jid, 'set', [
				{ tag: 'membership_approval_mode', attrs: {}, content: [{ tag: 'group_join', attrs: { state: mode } }] }
			])
		},
		groupMemberShareHistoryMode: async (jid: string, mode: MemberShareHistoryMode) => {
			await groupQuery(jid, 'set', [{ tag: 'member_share_group_history_mode', attrs: {}, content: mode }])
		},
		groupFetchMetadataBatch: async (jids: string[], concurrency = 10): Promise<GroupMetadata[]> => {
			if (!jids.length) return []
			const results: (GroupMetadata | null)[] = []
			for (let i = 0; i < jids.length; i += concurrency) {
				const chunk = jids.slice(i, i + concurrency)
				const chunkResults = await Promise.all(
					chunk.map(async jid => {
						try {
							return await groupMetadata(jid)
						} catch (error) {
							logger.warn({ error, jid }, 'groupFetchMetadataBatch: failed for jid')
							return null
						}
					})
				)
				results.push(...chunkResults)
			}

			return results.filter((r): r is GroupMetadata => r !== null)
		},
		groupFetchOverviews: async (jids?: string[]): Promise<GroupOverview[]> => {
			const targetJids = jids?.length ? jids : null
			if (targetJids) {
				const results = await Promise.all(
					targetJids.map(async jid => {
						const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }])
						const group = getBinaryNodeChild(result, 'group')
						return group ? overviewFromNode(group) : null
					})
				)
				return results.filter((r): r is GroupOverview => r !== null)
			}

			// No specific JIDs: list all participating without participant details
			const result = await query({
				tag: 'iq',
				attrs: { to: '@g.us', xmlns: 'w:g2', type: 'get' },
				content: [
					{
						tag: 'participating',
						attrs: {},
						content: [{ tag: 'description', attrs: {} }]
					}
				]
			})
			const groupsChild = getBinaryNodeChild(result, 'groups')
			if (!groupsChild) return []
			return getBinaryNodeChildren(groupsChild, 'group')
				.map(g => overviewFromNode(g))
				.filter((r): r is GroupOverview => r !== null)
		},
		groupRoutingInfo: async (jid: string): Promise<GroupRoutingInfo> => {
			const cached = routingCache.get(jid)
			if (cached) return cached
			const meta = await groupMetadata(jid)
			const lidToPnMap: Record<string, string | undefined> = {}
			for (const p of meta.participants) {
				if (p.lid && p.phoneNumber) lidToPnMap[p.lid] = p.phoneNumber
				else if (p.lid && isPnUser(p.id)) lidToPnMap[p.lid] = p.id
			}

			const info: GroupRoutingInfo = {
				groupJid: jid,
				participants: meta.participants.map(p => p.id),
				addressingMode: meta.addressingMode ?? WAMessageAddressingMode.PN,
				lidToPnMap,
				fetchedAt: Date.now()
			}
			await safeCacheSet(routingCache, jid, info, logger, 'groupRoutingInfo')
			return info
		},
		groupResolveParticipantAddresses: async (metadata: GroupMetadata): Promise<GroupMetadata> => {
			const clone = structuredClone(metadata)
			return normalizeGroupMetadata(clone)
		},
		groupRemoveParticipantsIncludingLinkedGroups: async (jid: string, participants: string[]) => {
			const results: { jid: string; status: string; group: string }[] = []
			// Remove from the parent group via direct IQ
			const removeResults = await groupQuery(jid, 'set', [
				{
					tag: 'remove',
					attrs: {},
					content: participants.map(p => ({ tag: 'participant', attrs: { jid: p } }))
				}
			])
			const removeNode = getBinaryNodeChild(removeResults, 'remove')
			const parentAffected = getBinaryNodeChildren(removeNode, 'participant')
			for (const p of parentAffected) {
				results.push({ jid: p.attrs.jid || '', status: p.attrs.error || '200', group: jid })
			}

			// Query linked subgroups
			const meta = await groupMetadata(jid)
			// Process linked groups regardless of whether jid is a root community or a subgroup
			const communityJid = meta.isCommunity ? jid : meta.linkedParent
			if (communityJid) {
				const linkedResult = await groupQuery(communityJid, 'get', [{ tag: 'linked_groups', attrs: {} }])
				const linkedNode = getBinaryNodeChild(linkedResult, 'linked_groups')
				const linkedGroups = getBinaryNodeChildren(linkedNode, 'group')
				for (const linkedGroup of linkedGroups) {
					const linkedJid = linkedGroup.attrs.jid
					if (!linkedJid) continue
					try {
						const linkedResults = await groupQuery(linkedJid, 'set', [
							{
								tag: 'remove',
								attrs: {},
								content: participants.map(p => ({ tag: 'participant', attrs: { jid: p } }))
							}
						])
						const linkedRemoveNode = getBinaryNodeChild(linkedResults, 'remove')
						const linkedAffected = getBinaryNodeChildren(linkedRemoveNode, 'participant')
						for (const p of linkedAffected) {
							results.push({ jid: p.attrs.jid || '', status: p.attrs.error || '200', group: linkedJid })
						}
					} catch (error) {
						logger.warn(
							{ error, group: linkedJid },
							'groupRemoveParticipantsIncludingLinkedGroups: subgroup remove failed'
						)
					}
				}
			}

			return results
		},
		groupCancelMembershipRequest: async (jid: string): Promise<void> => {
			await groupQuery(jid, 'set', [
				{
					tag: 'membership_requests_action',
					attrs: {},
					content: [
						{
							tag: 'cancel',
							attrs: {}
						}
					]
				}
			])
		},
		groupGetReportedMessages: async (jid: string): Promise<ReportedGroupMessage[]> => {
			const result = await groupQuery(jid, 'get', [{ tag: 'reported_messages', attrs: {} }])
			const reportedNode = getBinaryNodeChild(result, 'reported_messages')
			if (!reportedNode) return []
			const messages = getBinaryNodeChildren(reportedNode, 'reported_message')
			return messages.map(msg => {
				const reporters = getBinaryNodeChildren(msg, 'reporter').map(r => ({
					jid: r.attrs.jid || '',
					timestamp: +(r.attrs.t ?? '0'),
					phoneNumber: r.attrs.phone_number,
					username: r.attrs.username
				}))
				return {
					messageId: msg.attrs.id || '',
					reporters
				}
			})
		},
		groupReportMessagesToAdmins: async (jid: string, messageIds: string[], reason?: string) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'report',
					attrs: reason ? { reason } : {},
					content: messageIds.map(id => ({
						tag: 'message',
						attrs: { id }
					}))
				}
			])
		},
		groupUpdateMemberLabel: async (jid: string, participantJid: string, label: string) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'member_label',
					attrs: { jid: participantJid },
					content: Buffer.from(label, 'utf-8')
				}
			])
		},
		groupLookupProfilePicture: async (jid: string): Promise<{ url?: string; tag?: string }> => {
			const result = await groupQuery(jid, 'get', [{ tag: 'picture', attrs: {} }])
			const picNode = getBinaryNodeChild(result, 'picture')
			return { url: picNode?.attrs.url, tag: picNode?.attrs.tag }
		},
		groupLookupCommunityProfilePicture: async (jid: string): Promise<{ url?: string; tag?: string }> => {
			const result = await groupQuery(jid, 'get', [{ tag: 'picture', attrs: { type: 'community' } }])
			const picNode = getBinaryNodeChild(result, 'picture')
			return { url: picNode?.attrs.url, tag: picNode?.attrs.tag }
		},
		groupFetchAllParticipating
	}
}

const triState = (group: BinaryNode, positive: string, negative: string): boolean | undefined => {
	if (getBinaryNodeChild(group, positive)) return true
	if (getBinaryNodeChild(group, negative)) return false
	return undefined
}

const overviewFromNode = (g: BinaryNode): GroupOverview | null => {
	if (!g.attrs.id) return null
	return {
		id: g.attrs.id.includes('@') ? g.attrs.id : jidEncode(g.attrs.id, 'g.us'),
		subject: g.attrs.subject,
		subjectTime: g.attrs.s_t ? +g.attrs.s_t : undefined,
		creation: g.attrs.creation ? +g.attrs.creation : undefined,
		size: g.attrs.size ? +g.attrs.size : undefined,
		linkedParent: getBinaryNodeChild(g, 'linked_parent')?.attrs.jid,
		isCommunity: !!getBinaryNodeChild(g, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(g, 'default_sub_group'),
		addressingMode: g.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
		ephemeralDuration: getBinaryNodeChild(g, 'ephemeral')?.attrs.expiration
			? +getBinaryNodeChild(g, 'ephemeral')!.attrs.expiration!
			: undefined
	}
}

export const extractGroupMetadata = (result: BinaryNode) => {
	const group = getBinaryNodeChild(result, 'group')
	if (!group) {
		// Mirror WA Web: surface server/client errors with their code+text instead of crashing.
		const errorNode = getBinaryNodeChild(result, 'error')
		if (errorNode) {
			const parsedCode = Number(errorNode.attrs.code)
			const code = Number.isInteger(parsedCode) && parsedCode >= 400 && parsedCode <= 599 ? parsedCode : 500
			const text = errorNode.attrs.text || 'group metadata query failed'
			throw new Boom(text, { statusCode: code, data: errorNode })
		}

		throw new Boom('Invalid group metadata response: missing <group> node', { data: result })
	}

	if (!group.attrs.id) {
		throw new Boom('Invalid group metadata response: missing group id', { data: group })
	}

	const descChild = getBinaryNodeChild(group, 'description')
	let desc: string | undefined
	let descId: string | undefined
	let descOwner: string | undefined
	let descOwnerPn: string | undefined
	let descOwnerUsername: string | undefined
	let descTime: number | undefined
	if (descChild) {
		desc = getBinaryNodeChildString(descChild, 'body')
		descOwner = descChild.attrs.participant ? jidNormalizedUser(descChild.attrs.participant) : undefined
		descOwnerPn = descChild.attrs.participant_pn ? jidNormalizedUser(descChild.attrs.participant_pn) : undefined
		descOwnerUsername = descChild.attrs.participant_username || descChild.attrs.username || undefined
		descTime = +descChild.attrs.t!
		descId = descChild.attrs.id
	}

	const groupId = group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us')
	const eph = getBinaryNodeChild(group, 'ephemeral')?.attrs.expiration
	const memberAddMode = getBinaryNodeChildString(group, 'member_add_mode') === 'all_member_add'
	const metadata: GroupMetadata = {
		id: groupId,
		notify: group.attrs.notify,
		addressingMode: group.attrs.addressing_mode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
		subject: group.attrs.subject!,
		subjectOwner: group.attrs.s_o,
		subjectOwnerPn: group.attrs.s_o_pn,
		subjectOwnerUsername: group.attrs.s_o_username,
		subjectTime: +(group.attrs.s_t ?? '0'),
		size: group.attrs.size ? +group.attrs.size : getBinaryNodeChildren(group, 'participant').length,
		creation: +(group.attrs.creation ?? '0'),
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		ownerPn: group.attrs.creator_pn ? jidNormalizedUser(group.attrs.creator_pn) : undefined,
		ownerUsername: group.attrs.creator_username || undefined,
		owner_country_code: group.attrs.creator_country_code,
		desc,
		descId,
		descOwner,
		descOwnerPn,
		descOwnerUsername,
		descTime,
		linkedParent: getBinaryNodeChild(group, 'linked_parent')?.attrs.jid || undefined,
		restrict: !!getBinaryNodeChild(group, 'locked'),
		announce: !!getBinaryNodeChild(group, 'announcement'),
		isCommunity: !!getBinaryNodeChild(group, 'parent'),
		isCommunityAnnounce: !!getBinaryNodeChild(group, 'default_sub_group'),
		joinApprovalMode: !!getBinaryNodeChild(group, 'membership_approval_mode'),
		memberAddMode,
		noFrequentlyForwarded: triState(group, 'no_frequently_forwarded', 'frequently_forwarded'),
		allowAdminReports: triState(group, 'allow_admin_reports', 'not_allow_admin_reports'),
		groupHistoryVisible: triState(group, 'group_history', 'no_group_history'),
		limitSharingEnabled: triState(group, 'limit_sharing_enabled', 'limit_sharing_disabled'),
		growthLocked: triState(group, 'growth_locked', 'growth_unlocked'),
		memberShareHistoryMode: getBinaryNodeChildString(group, 'member_share_group_history_mode') as
			| 'retained'
			| 'unavailable'
			| undefined,
		participants: getBinaryNodeChildren(group, 'participant').map(({ attrs }) => {
			// TODO: Store LID MAPPINGS
			return {
				id: attrs.jid!,
				phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
				lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
				username: attrs.participant_username || attrs.username || undefined,
				admin: (attrs.type || null) as GroupParticipant['admin']
			}
		}),
		ephemeralDuration: eph ? +eph : undefined
	}
	return metadata
}

export type GroupsSocket = ReturnType<typeof makeGroupsSocket>
