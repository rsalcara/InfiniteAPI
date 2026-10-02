import type { NewChatMessageCapInfo, ReachoutTimelockState } from '../Types/State'
import type { ILogger } from './logger'

/**
 * How long a fetched capping state stays fresh. The app refetches the
 * new-chat quota when a new chat is opened and the stored state is older than
 * AB prop 20649, 3600 s by default (`X/C016407t.java:18854`,
 * `ConversationDelegateImplJava`); reachout uses the same window here.
 */
export const OUTBOUND_POLICY_REFRESH_MS = 3_600_000
/** After a failed lookup, wait this long before asking the server again. */
export const OUTBOUND_POLICY_RETRY_MS = 60_000

export type OutboundPolicySnapshot = {
	reachout?: ReachoutTimelockState
	capping?: NewChatMessageCapInfo
}

type Entry<T> = { value?: T; fetchedAt?: number; failedAt?: number; inFlight?: Promise<void> }

/**
 * Account restriction state (reachout timelock and new-chat capping) kept in
 * memory like the app keeps it in preferences (`TOwmL_*`, `key_capping_*`):
 * read from cache on every new-chat send, refreshed by the server's
 * notifications and, when stale, by one lookup shared by concurrent sends.
 * A failed lookup keeps the previous value (fail-open, the server stays the
 * final authority) and is retried after `OUTBOUND_POLICY_RETRY_MS`.
 */
export const makeOutboundPolicyCache = ({
	fetchReachout,
	fetchCapping,
	logger,
	now = Date.now,
	refreshMs = OUTBOUND_POLICY_REFRESH_MS,
	retryMs = OUTBOUND_POLICY_RETRY_MS
}: {
	fetchReachout: () => Promise<ReachoutTimelockState | undefined>
	fetchCapping: () => Promise<NewChatMessageCapInfo | undefined>
	logger: Pick<ILogger, 'warn'>
	now?: () => number
	refreshMs?: number
	retryMs?: number
}) => {
	const reachout: Entry<ReachoutTimelockState> = {}
	const capping: Entry<NewChatMessageCapInfo> = {}

	const isFresh = <T>(entry: Entry<T>, at: number) =>
		(entry.fetchedAt !== undefined && at - entry.fetchedAt < refreshMs) ||
		(entry.failedAt !== undefined && at - entry.failedAt < retryMs)

	const refresh = async <T>(entry: Entry<T>, fetch: () => Promise<T | undefined>, label: string, force: boolean) => {
		if (!force && isFresh(entry, now())) return
		entry.inFlight ??= fetch()
			.then(value => {
				entry.value = value
				entry.fetchedAt = now()
				entry.failedAt = undefined
			})
			.catch(error => {
				entry.failedAt = now()
				logger.warn({ error }, `${label} lookup failed; keeping the last known state`)
			})
			.finally(() => {
				entry.inFlight = undefined
			})
		await entry.inFlight
	}

	return {
		/** Current state, refreshing whatever is stale. Never throws. */
		get: async ({ force = false }: { force?: boolean } = {}): Promise<OutboundPolicySnapshot> => {
			await Promise.all([
				refresh(reachout, fetchReachout, 'reachout timelock', force),
				refresh(capping, fetchCapping, 'new-chat capping', force)
			])
			return { reachout: reachout.value, capping: capping.value }
		},
		/** Server push (`NotificationUserReachoutTimelockUpdate`) or a direct fetch. */
		setReachout: (value: ReachoutTimelockState) => {
			reachout.value = value
			reachout.fetchedAt = now()
		},
		/** Server push (`xwa2_notify_new_chat_messages_capping_info_update`). */
		setCapping: (value: NewChatMessageCapInfo) => {
			capping.value = value
			capping.fetchedAt = now()
		}
	}
}

export type OutboundPolicyCache = ReturnType<typeof makeOutboundPolicyCache>

/** The new-chat quota as the server reports it, for callers that pace their sends. */
export const describeNewChatQuota = (capping: NewChatMessageCapInfo | undefined) => {
	if (!capping) return undefined
	const seconds = (value?: string) => {
		const parsed = Number(value)
		return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined
	}

	const total = capping.total_quota
	const used = capping.used_quota
	return {
		status: capping.capping_status,
		total,
		used,
		remaining: typeof total === 'number' && typeof used === 'number' ? Math.max(0, total - used) : undefined,
		cycleStart: seconds(capping.cycle_start_timestamp),
		cycleEnd: seconds(capping.cycle_end_timestamp),
		oneTimeException: capping.ote_status,
		metaVerified: capping.mv_status
	}
}
