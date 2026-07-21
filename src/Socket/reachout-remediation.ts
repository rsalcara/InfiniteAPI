import { Boom } from '@hapi/boom'
import type {
	ReachoutTimelockRemediationConfig,
	ReachoutTimelockRemediationEligibility,
	ReachoutTimelockRemediationRequest,
	ReachoutTimelockRemediationResult,
	ReachoutTimelockState
} from '../Types'
import { ReachoutTimelockEnforcementType } from '../Types'

export const REMOVE_REACHOUT_TIMELOCK_INPUT = Object.freeze({
	input: Object.freeze({
		violation_type: 'SPAM',
		reason: 'User watched remediation video',
		reachout_timelock_type: 'BIZ_QUALITY'
	})
})

export type RemoveReachoutTimelockServerResult = {
	success?: boolean
	error_message?: string
}

type RemediationDependencies = {
	config?: ReachoutTimelockRemediationConfig
	fetchState: (emitUpdate?: boolean) => Promise<ReachoutTimelockState>
	removeOnServer: (variables: typeof REMOVE_REACHOUT_TIMELOCK_INPUT) => Promise<RemoveReachoutTimelockServerResult>
	callerTimeoutMs?: number
	log: (level: 'info' | 'warn', details: Record<string, unknown>, message: string) => void
}

const errorMessage = (error: unknown): string => {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error

	return 'unknown server error'
}

const withCallerTimeout = <T>(operation: Promise<T>, timeoutMs?: number): Promise<T> => {
	if (!timeoutMs || timeoutMs <= 0) return operation

	let timeout: NodeJS.Timeout | undefined
	const deadline = new Promise<T>((_, reject) => {
		timeout = setTimeout(
			() =>
				reject(
					new Boom('Reachout remediation request timed out; the server outcome is still pending', { statusCode: 408 })
				),
			timeoutMs
		)
	})

	return Promise.race([operation, deadline]).finally(() => {
		if (timeout) clearTimeout(timeout)
	})
}

const validOfficialVideoUrl = (value?: string): string | undefined => {
	if (!value) return undefined

	try {
		const url = new URL(value)
		return url.protocol === 'https:' ? url.toString() : undefined
	} catch {
		return undefined
	}
}

export const evaluateReachoutTimelockRemediation = (
	config: ReachoutTimelockRemediationConfig | undefined,
	state: ReachoutTimelockState
): ReachoutTimelockRemediationEligibility => {
	const videoUrl = validOfficialVideoUrl(config?.officialVideoUrl)
	let reason: ReachoutTimelockRemediationEligibility['reason'] = 'eligible'

	if (config?.enabled !== true) reason = 'feature-disabled'
	else if (state.isActive !== true) reason = 'restriction-inactive'
	else if (state.enforcementType !== ReachoutTimelockEnforcementType.BIZ_QUALITY) reason = 'wrong-enforcement-type'
	else if (config.androidFeatureFlagEnabled !== true) reason = 'android-feature-flag-not-confirmed'
	else if (!videoUrl) reason = 'official-video-url-missing-or-invalid'

	return {
		eligible: reason === 'eligible',
		reason,
		state,
		officialVideoUrl: videoUrl
	}
}

/**
 * Builds the future remediation API without coupling it to the message path.
 * Calls are single-flight so two UI confirmations cannot submit the mutation twice.
 */
export const makeReachoutTimelockRemediation = (dependencies: RemediationDependencies) => {
	let inFlight: Promise<ReachoutTimelockRemediationResult> | undefined

	const getEligibility = async (): Promise<ReachoutTimelockRemediationEligibility> => {
		const state = await dependencies.fetchState(false)
		return evaluateReachoutTimelockRemediation(dependencies.config, state)
	}

	const remove = async (request: ReachoutTimelockRemediationRequest): Promise<ReachoutTimelockRemediationResult> => {
		if (request?.videoWatched !== true || request.confirmation !== 'USER_WATCHED_OFFICIAL_VIDEO') {
			throw new Boom('Reachout remediation requires explicit confirmation that the official video was watched', {
				statusCode: 400
			})
		}

		if (inFlight) return withCallerTimeout(inFlight, dependencies.callerTimeoutMs)

		const operation: Promise<ReachoutTimelockRemediationResult> = (async () => {
			const eligibility = await getEligibility()
			if (!eligibility.eligible) {
				dependencies.log(
					'warn',
					{
						reason: eligibility.reason,
						isActive: eligibility.state.isActive,
						enforcementType: eligibility.state.enforcementType
					},
					'reachout remediation refused before server mutation'
				)
				throw new Boom(`Reachout remediation is not eligible: ${eligibility.reason}`, { statusCode: 409 })
			}

			let serverResult: RemoveReachoutTimelockServerResult
			try {
				serverResult = await dependencies.removeOnServer(REMOVE_REACHOUT_TIMELOCK_INPUT)
			} catch (error) {
				const serverError = errorMessage(error)
				dependencies.log('warn', { serverError }, 'reachout remediation mutation request failed')
				return {
					removed: false,
					status: 'server-rejected',
					before: eligibility.state,
					serverSuccess: false,
					serverError
				} satisfies ReachoutTimelockRemediationResult
			}

			if (serverResult?.success !== true) {
				const serverError = serverResult?.error_message || 'server returned success=false without an error message'
				dependencies.log('warn', { serverError }, 'reachout remediation mutation was rejected by the server')
				return {
					removed: false,
					status: 'server-rejected',
					before: eligibility.state,
					serverSuccess: false,
					serverError
				} satisfies ReachoutTimelockRemediationResult
			}

			let after: ReachoutTimelockState
			try {
				after = await dependencies.fetchState(true)
			} catch (error) {
				const verificationError = errorMessage(error)
				dependencies.log(
					'warn',
					{ status: 'server-accepted-pending-verification', verificationError },
					'reachout remediation was accepted but the verification read failed'
				)
				return {
					removed: false,
					status: 'server-accepted-pending-verification',
					before: eligibility.state,
					serverSuccess: true,
					verificationError
				} satisfies ReachoutTimelockRemediationResult
			}

			// Fail closed: an omitted/malformed `is_active` is not proof that the
			// server lifted the restriction. Only an explicit `false` confirms it.
			const removed = after.isActive === false
			const status: ReachoutTimelockRemediationResult['status'] = removed
				? 'removed'
				: 'server-accepted-pending-verification'
			dependencies.log(
				removed ? 'info' : 'warn',
				{ status, isActive: after.isActive, enforcementType: after.enforcementType },
				removed
					? 'reachout remediation verified by a fresh server read'
					: 'reachout remediation accepted but the fresh server state remains restricted'
			)

			return {
				removed,
				status,
				before: eligibility.state,
				after,
				serverSuccess: true
			}
		})().finally(() => {
			inFlight = undefined
		})
		inFlight = operation

		return withCallerTimeout(operation, dependencies.callerTimeoutMs)
	}

	return { getEligibility, remove }
}
