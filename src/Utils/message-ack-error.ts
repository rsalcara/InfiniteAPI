import type { NewChatMessageCapInfo, ReachoutTimelockState } from '../Types'

export type MessageAckErrorPolicy = {
	kind: 'message-account-restriction' | 'smax-invalid' | 'other'
	retry: false
	privacyTokenAction: 'none'
}

export type NativeOtpAckDiagnostic = {
	category: 'native-otp-requires-cloud-api'
	otpType: 'COPY_CODE' | 'ONE_TAP' | 'ZERO_TAP' | 'unknown'
	officialPlatform: 'whatsapp-business-cloud-api'
	retry: false
	privacyTokenAction: 'none'
}

export const NATIVE_OTP_REQUIRES_CLOUD_API = 'native-otp-requires-cloud-api'

type AckMessageContent = {
	interactiveMessage?: unknown
	viewOnceMessage?: unknown
	viewOnceMessageV2?: unknown
	viewOnceMessageV2Extension?: unknown
}

type NativeOtpButton = {
	name?: unknown
	buttonParamsJson?: unknown
}

const isNativeOtpButton = (button: unknown): button is NativeOtpButton =>
	typeof button === 'object' && button !== null && (button as { name?: unknown }).name === 'otp'

const unwrapViewOnceAckMessage = (message?: AckMessageContent): AckMessageContent | undefined => {
	let current = message
	for (let depth = 0; current && depth < 5; depth++) {
		if (current.interactiveMessage) return current

		const inner =
			(current.viewOnceMessage as { message?: AckMessageContent } | null | undefined)?.message ||
			(current.viewOnceMessageV2 as { message?: AckMessageContent } | null | undefined)?.message ||
			(current.viewOnceMessageV2Extension as { message?: AckMessageContent } | null | undefined)?.message
		if (!inner) return current
		current = inner
	}

	return current
}

/**
 * Correlates a 405 ACK with an outbound native OTP message. Meta documents
 * authentication templates as WhatsApp Business Cloud API assets, and the
 * official Android client only renders this receiver-side button type. Keep
 * this diagnostic narrowly scoped: 405 must not be interpreted for other
 * interactive messages.
 */
export const getNativeOtpAckDiagnostic = (
	error: string | undefined,
	message?: AckMessageContent
): NativeOtpAckDiagnostic | undefined => {
	if (error !== '405') return undefined

	const interactiveMessage = unwrapViewOnceAckMessage(message)?.interactiveMessage
	const buttons = (interactiveMessage as { nativeFlowMessage?: { buttons?: unknown } } | null | undefined)
		?.nativeFlowMessage?.buttons
	if (!Array.isArray(buttons) || !buttons.some(isNativeOtpButton)) {
		return undefined
	}

	const otpButton = buttons.find(isNativeOtpButton)
	let otpType: NativeOtpAckDiagnostic['otpType'] = 'unknown'
	try {
		const params = JSON.parse(typeof otpButton?.buttonParamsJson === 'string' ? otpButton.buttonParamsJson : '{}') as {
			otp_type?: unknown
		}
		if (params.otp_type === 'COPY_CODE' || params.otp_type === 'ONE_TAP' || params.otp_type === 'ZERO_TAP') {
			otpType = params.otp_type
		}
	} catch {
		// Keep "unknown" rather than guessing an official type from malformed JSON.
	}

	return {
		category: NATIVE_OTP_REQUIRES_CLOUD_API,
		otpType,
		officialPlatform: 'whatsapp-business-cloud-api',
		retry: false,
		privacyTokenAction: 'none'
	}
}

/**
 * Error ACK policy shared by the production handler and regression tests.
 * Neither 463 nor 479 is a request to fetch a peer privacy token: the only
 * privacy IQ available to companions is `type=set` (our-token issuance).
 */
export const getMessageAckErrorPolicy = (error: string): MessageAckErrorPolicy => ({
	kind: error === '463' ? 'message-account-restriction' : error === '479' ? 'smax-invalid' : 'other',
	retry: false,
	privacyTokenAction: 'none'
})

export type MessageAccountRestrictionDiagnostic = {
	jid: string
	msgId?: string
	code: string
	category: 'message-account-restriction'
	reason: string
	enforcementType?: string
	enforcementEndsAt?: number
	isReachoutActive?: boolean
	cappingStatus?: string
	quota: { total?: number; used?: number }
	cycleStart?: string
	cycleEnd?: string
	reachoutDiagnostic: 'lookup-complete' | 'lookup-failed'
	cappingDiagnostic: 'lookup-complete' | 'lookup-failed'
}

/** Builds the structured 463 evidence without guessing missing server fields. */
export const buildMessageAccountRestrictionDiagnostic = ({
	jid,
	msgId,
	code,
	reason,
	reachout,
	capping,
	reachoutLookup,
	cappingLookup
}: {
	jid: string
	msgId?: string
	code: string
	reason: string
	reachout?: ReachoutTimelockState
	capping?: NewChatMessageCapInfo
	reachoutLookup: 'lookup-complete' | 'lookup-failed'
	cappingLookup: 'lookup-complete' | 'lookup-failed'
}): MessageAccountRestrictionDiagnostic => ({
	jid,
	msgId,
	code,
	category: 'message-account-restriction',
	reason,
	...(reachout?.enforcementType ? { enforcementType: reachout.enforcementType } : {}),
	...(reachout?.timeEnforcementEnds ? { enforcementEndsAt: reachout.timeEnforcementEnds.getTime() } : {}),
	...(reachout?.isActive !== undefined ? { isReachoutActive: reachout.isActive } : {}),
	cappingStatus: capping?.capping_status,
	quota: { total: capping?.total_quota, used: capping?.used_quota },
	cycleStart: capping?.cycle_start_timestamp,
	cycleEnd: capping?.cycle_end_timestamp,
	reachoutDiagnostic: reachoutLookup,
	cappingDiagnostic: cappingLookup
})
