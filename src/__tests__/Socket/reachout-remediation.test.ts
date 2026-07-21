import { jest } from '@jest/globals'
import {
	evaluateReachoutTimelockRemediation,
	makeReachoutTimelockRemediation,
	REMOVE_REACHOUT_TIMELOCK_INPUT,
	type RemoveReachoutTimelockServerResult
} from '../../Socket/reachout-remediation'
import {
	QueryIds,
	ReachoutTimelockEnforcementType,
	type ReachoutTimelockRemediationConfig,
	type ReachoutTimelockState,
	XWAPaths
} from '../../Types'

const eligibleState: ReachoutTimelockState = {
	isActive: true,
	enforcementType: ReachoutTimelockEnforcementType.BIZ_QUALITY
}

const eligibleConfig: ReachoutTimelockRemediationConfig = {
	enabled: true,
	androidFeatureFlagEnabled: true,
	officialVideoUrl: 'https://static.example.test/remediation/video.mp4'
}

const confirmation = {
	videoWatched: true as const,
	confirmation: 'USER_WATCHED_OFFICIAL_VIDEO' as const
}

const makeHarness = (
	states: ReachoutTimelockState[] = [eligibleState, { isActive: false }],
	serverResult: RemoveReachoutTimelockServerResult = { success: true },
	config: ReachoutTimelockRemediationConfig = eligibleConfig
) => {
	const fetchState = jest.fn<(emitUpdate?: boolean) => Promise<ReachoutTimelockState>>()
	for (const state of states) fetchState.mockResolvedValueOnce(state)
	const removeOnServer = jest
		.fn<(variables: typeof REMOVE_REACHOUT_TIMELOCK_INPUT) => Promise<RemoveReachoutTimelockServerResult>>()
		.mockResolvedValue(serverResult)
	const log = jest.fn<(level: 'info' | 'warn', details: Record<string, unknown>, message: string) => void>()
	const remediation = makeReachoutTimelockRemediation({ config, fetchState, removeOnServer, log })

	return { remediation, fetchState, removeOnServer, log }
}

describe('experimental reachout timelock remediation', () => {
	it('locks the captured MEX contract and exact Android mutation input', () => {
		expect(QueryIds.REMOVE_REACHOUT_TIMELOCK).toBe('25040013452293167')
		expect(XWAPaths.xwa2_remove_account_reachout_timelock).toBe('xwa2_remove_account_reachout_timelock')
		expect(REMOVE_REACHOUT_TIMELOCK_INPUT).toEqual({
			input: {
				violation_type: 'SPAM',
				reason: 'User watched remediation video',
				reachout_timelock_type: 'BIZ_QUALITY'
			}
		})
		expect(Object.isFrozen(REMOVE_REACHOUT_TIMELOCK_INPUT)).toBe(true)
		expect(Object.isFrozen(REMOVE_REACHOUT_TIMELOCK_INPUT.input)).toBe(true)
	})

	it.each([
		[undefined, eligibleState, 'feature-disabled'],
		[{ ...eligibleConfig, enabled: false }, eligibleState, 'feature-disabled'],
		[eligibleConfig, { ...eligibleState, isActive: false }, 'restriction-inactive'],
		[
			eligibleConfig,
			{ ...eligibleState, enforcementType: ReachoutTimelockEnforcementType.DEFAULT },
			'wrong-enforcement-type'
		],
		[{ ...eligibleConfig, androidFeatureFlagEnabled: false }, eligibleState, 'android-feature-flag-not-confirmed'],
		[
			{ ...eligibleConfig, officialVideoUrl: 'http://insecure.test/video.mp4' },
			eligibleState,
			'official-video-url-missing-or-invalid'
		]
	] as const)('fails closed for reason %s/%s/%s', (config, state, reason) => {
		expect(evaluateReachoutTimelockRemediation(config, state)).toMatchObject({ eligible: false, reason })
	})

	it('returns the normalized HTTPS video URL only for an eligible fresh state', () => {
		expect(evaluateReachoutTimelockRemediation(eligibleConfig, eligibleState)).toEqual({
			eligible: true,
			reason: 'eligible',
			state: eligibleState,
			officialVideoUrl: 'https://static.example.test/remediation/video.mp4'
		})
	})

	it('rejects an accidental call without the explicit video confirmation', async () => {
		const { remediation, fetchState, removeOnServer } = makeHarness()

		await expect(
			remediation.remove({ videoWatched: true, confirmation: 'WRONG' as 'USER_WATCHED_OFFICIAL_VIDEO' })
		).rejects.toThrow(/explicit confirmation/)
		expect(fetchState).not.toHaveBeenCalled()
		expect(removeOnServer).not.toHaveBeenCalled()
	})

	it('does not mutate the server when fresh eligibility fails', async () => {
		const { remediation, removeOnServer } = makeHarness([
			{ isActive: true, enforcementType: ReachoutTimelockEnforcementType.RESTRICT_ALL_COMPANIONS }
		])

		await expect(remediation.remove(confirmation)).rejects.toThrow(/wrong-enforcement-type/)
		expect(removeOnServer).not.toHaveBeenCalled()
	})

	it('reports removed only after a fresh server read is inactive', async () => {
		const after = { isActive: false, enforcementType: ReachoutTimelockEnforcementType.BIZ_QUALITY }
		const { remediation, fetchState, removeOnServer } = makeHarness([eligibleState, after])

		await expect(remediation.remove(confirmation)).resolves.toEqual({
			removed: true,
			status: 'removed',
			before: eligibleState,
			after,
			serverSuccess: true
		})
		expect(removeOnServer).toHaveBeenCalledWith(REMOVE_REACHOUT_TIMELOCK_INPUT)
		expect(fetchState).toHaveBeenNthCalledWith(1, false)
		expect(fetchState).toHaveBeenNthCalledWith(2, true)
	})

	it('preserves the exact server rejection reason', async () => {
		const { remediation } = makeHarness([eligibleState], {
			success: false,
			error_message: 'account is not eligible for remediation'
		})

		await expect(remediation.remove(confirmation)).resolves.toMatchObject({
			removed: false,
			status: 'server-rejected',
			serverSuccess: false,
			serverError: 'account is not eligible for remediation'
		})
	})

	it('does not claim removal when mutation succeeds but the fresh state is still active', async () => {
		const { remediation } = makeHarness([eligibleState, eligibleState])

		await expect(remediation.remove(confirmation)).resolves.toMatchObject({
			removed: false,
			status: 'server-accepted-pending-verification',
			serverSuccess: true,
			after: eligibleState
		})
	})

	it('does not claim removal when the verification response omits isActive', async () => {
		const incompleteState = { enforcementType: ReachoutTimelockEnforcementType.BIZ_QUALITY }
		const { remediation } = makeHarness([eligibleState, incompleteState])

		await expect(remediation.remove(confirmation)).resolves.toMatchObject({
			removed: false,
			status: 'server-accepted-pending-verification',
			serverSuccess: true,
			after: incompleteState
		})
	})

	it('coalesces concurrent confirmations into one server mutation', async () => {
		let releaseMutation!: (value: RemoveReachoutTimelockServerResult) => void
		const mutation = new Promise<RemoveReachoutTimelockServerResult>(resolve => {
			releaseMutation = resolve
		})
		const fetchState = jest
			.fn<(emitUpdate?: boolean) => Promise<ReachoutTimelockState>>()
			.mockResolvedValueOnce(eligibleState)
			.mockResolvedValueOnce({ isActive: false })
		const removeOnServer = jest
			.fn<(variables: typeof REMOVE_REACHOUT_TIMELOCK_INPUT) => Promise<RemoveReachoutTimelockServerResult>>()
			.mockReturnValue(mutation)
		const remediation = makeReachoutTimelockRemediation({
			config: eligibleConfig,
			fetchState,
			removeOnServer,
			log: () => undefined
		})

		const first = remediation.remove(confirmation)
		const second = remediation.remove(confirmation)
		releaseMutation({ success: true })

		await expect(Promise.all([first, second])).resolves.toHaveLength(2)
		expect(removeOnServer).toHaveBeenCalledTimes(1)
	})
})
