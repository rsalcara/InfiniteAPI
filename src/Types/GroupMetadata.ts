import type { Contact } from './Contact'
import type { WAMessageAddressingMode } from './Message'

export type GroupParticipant = Contact & {
	isAdmin?: boolean
	isSuperAdmin?: boolean
	admin?: 'admin' | 'superadmin' | null
}

export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'modify'

export type RequestJoinAction = 'created' | 'revoked' | 'rejected'

export type RequestJoinMethod = 'invite_link' | 'linked_group_join' | 'non_admin_add' | undefined

export type GroupSettingType =
	| 'announcement'
	| 'not_announcement'
	| 'locked'
	| 'unlocked'
	| 'no_frequently_forwarded'
	| 'frequently_forwarded'
	| 'allow_admin_reports'
	| 'not_allow_admin_reports'
	| 'group_history'
	| 'no_group_history'
	| 'limit_sharing_enabled'
	| 'limit_sharing_disabled'

export type MemberShareHistoryMode = 'retained' | 'unavailable'

export interface GroupOverview {
	id: string
	subject?: string
	subjectTime?: number
	creation?: number
	size?: number
	linkedParent?: string
	isCommunity?: boolean
	isCommunityAnnounce?: boolean
	addressingMode?: WAMessageAddressingMode
	ephemeralDuration?: number
}

export interface GroupRoutingInfo {
	groupJid: string
	participants: string[]
	addressingMode: WAMessageAddressingMode
	lidToPnMap: Record<string, string | undefined>
	fetchedAt: number
}

export interface ReportedGroupMessage {
	messageId: string
	reporters: {
		jid: string
		timestamp: number
		phoneNumber?: string
		username?: string
	}[]
}

export interface GroupMetadata {
	id: string
	notify?: string
	/** group uses 'lid' or 'pn' to send messages */
	addressingMode?: WAMessageAddressingMode
	owner: string | undefined
	ownerPn?: string | undefined
	ownerUsername?: string | undefined
	owner_country_code?: string | undefined
	subject: string
	/** group subject owner */
	subjectOwner?: string
	subjectOwnerPn?: string
	subjectOwnerUsername?: string
	/** group subject modification date */
	subjectTime?: number
	creation?: number
	desc?: string
	descOwner?: string
	descOwnerPn?: string
	descOwnerUsername?: string
	descId?: string
	descTime?: number
	/** if this group is part of a community, it returns the jid of the community to which it belongs */
	linkedParent?: string
	/** is set when the group only allows admins to change group settings */
	restrict?: boolean
	/** is set when the group only allows admins to write messages */
	announce?: boolean
	/** is set when the group also allows members to add participants */
	memberAddMode?: boolean
	/** Request approval to join the group */
	joinApprovalMode?: boolean
	/** is this a community */
	isCommunity?: boolean
	/** is this the announce of a community */
	isCommunityAnnounce?: boolean
	/** number of group participants */
	size?: number
	// Baileys modified array
	participants: GroupParticipant[]
	ephemeralDuration?: number
	/** when set, messages are not labelled "forwarded many times" in this group */
	noFrequentlyForwarded?: boolean
	/** admin reports toggle state (APK: `allow_admin_reports` / `not_allow_admin_reports`) */
	allowAdminReports?: boolean
	/** group history visibility (APK: `group_history`) */
	groupHistoryVisible?: boolean
	/** limit sharing outside the group (APK: `limit_sharing_enabled`) */
	limitSharingEnabled?: boolean
	/** member share history mode (APK: `member_share_group_history_mode`) */
	memberShareHistoryMode?: MemberShareHistoryMode
	/** growth locked state (APK: `growth_locked` / `growth_unlocked`) */
	growthLocked?: boolean
	inviteCode?: string
	/** the person who added you to group or changed some setting in group */
	author?: string
	authorPn?: string
	authorUsername?: string
}

export interface WAGroupCreateResponse {
	status: number
	gid?: string
	participants?: [{ [key: string]: {} }]
}

export interface GroupModificationResponse {
	status: number
	participants?: { [key: string]: {} }
}
