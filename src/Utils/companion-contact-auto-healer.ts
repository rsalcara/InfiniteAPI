/**
 * CompanionContactAutoHealer — local-only repair of contact syncd mutations.
 *
 * 1:1 with the app's hourly heal task. This is a DISTINCT mechanism from the
 * CONTACT_REFRESH_REQUEST flow: the healer NEVER sends anything on the wire.
 * Its job is to replay contact/lid_contact mutation effects that were
 * persisted in syncd_mutations but whose local effect (the contacts upsert)
 * never landed — the "contact went missing after restart/crash" class of
 * damage.
 *
 * Algorithm (the app's healOnce):
 *
 *   1. Gates: companion only; config master switch; interval hours > 0
 *      (default 0 = disabled); window check against
 *      `last_contact_auto_heal_timestamp` (skips inside the interval do NOT
 *      consume the window).
 *   2. NOT_SETTLED: any contact/lid_contact mutation still staged in
 *      pending_mutations means an outbound sync round-trip is in flight —
 *      skip WITHOUT consuming the window (retried next tick).
 *   3. Repair scan: contact/lid_contact mutations whose dependencies
 *      resolved, oldest first. For each: skip if still pending, skip if the
 *      effect is already applied locally (value comparison), else re-apply
 *      the effect through the same event path the live apply uses.
 *   4. Log `CompanionContactAutoHealer/healOnce repaired=X attempted=Y
 *      added=Z edited=W` and update the window timestamp.
 *
 * The engine mirrors one syncd_mutations row per ingested mutation, so
 * `mutation_value` decodes to the full SyncActionData (index + value) — the
 * replay is byte-identical to the live apply path.
 */
import { proto } from '../../WAProto/index.js'
import type { BaileysEventEmitter, Contact } from '../Types'
import { isPnUser } from '../WABinary'
import type { PendingContactMutationRow, SyncdMutationRow } from './multi-db-sqlite/app-state-backend'
import type { ILogger } from './logger'
import { emitSyncActionResults, processContactAction } from './sync-action-utils'

/** Collection the contact mutations live on. */
export const CONTACT_MUTATION_COLLECTION = 'critical_unblock_low'

export type ContactAutoHealDeps = {
	/** False → skip (the app's heal is companion-only). */
	isCompanion: () => boolean
	/** APK config gate — master switch. */
	isEnabled: () => boolean
	/** APK interval-hours config; 0/absent = disabled. */
	intervalHours: () => number
	getLastHealTimestamp: () => number | null
	setLastHealTimestamp: (ms: number) => void
	listContactMutationsForHeal: () => SyncdMutationRow[]
	listPendingContactMutations: () => PendingContactMutationRow[]
	/**
	 * Local contact state for the effect-applied check (the app's A0S
	 * comparison). Return null/undefined when unknown — the healer then
	 * replays (contacts.upsert is idempotent) and counts the row as `added`.
	 * May be async (the socket's getStoredContact is).
	 */
	getLocalContact?: (id: string) => Contact | null | undefined | Promise<Contact | null | undefined>
	ev: BaileysEventEmitter
	logger: ILogger
	/** Clock injection for tests. */
	now?: () => number
}

export type HealOnceResult =
	| { status: 'skipped'; reason: 'not_companion' | 'disabled' | 'no_interval' | 'within_window' | 'not_settled' }
	| {
			status: 'ran'
			/** Mutations whose effect was re-applied. */
			repaired: number
			/** Mutations examined by the repair scan. */
			attempted: number
			/** Repairs where no local contact existed before. */
			added: number
			/** Repairs where a local contact existed but differed. */
			edited: number
			/** Skipped because the effect already matched locally. */
			skippedApplied: number
			/** Skipped because the mutation is still in pending_mutations. */
			skippedPending: number
			durationMs: number
	  }

type DecodedContactMutation = {
	indexId: string | undefined
	contactAction: proto.SyncActionValue.IContactAction | null | undefined
	lidContactAction: proto.SyncActionValue.ILidContactAction | null | undefined
}

const decodeContactMutation = (row: SyncdMutationRow, logger: ILogger): DecodedContactMutation | null => {
	if (!row.mutationValue) return null
	try {
		const syncAction = proto.SyncActionData.decode(row.mutationValue)
		const index = JSON.parse(Buffer.from(syncAction.index ?? []).toString()) as unknown
		const value = syncAction.value
		const indexId = Array.isArray(index) && typeof index[1] === 'string' ? index[1] : undefined
		return {
			indexId,
			contactAction: value?.contactAction,
			lidContactAction: value?.lidContactAction
		}
	} catch (err) {
		logger.warn({ err, mutationIndex: row.mutationIndex }, 'CompanionContactAutoHealer: undecodable mutation (skipped)')
		return null
	}
}

/**
 * The app's "effect already applied" comparison: every field the mutation
 * would write must already match the local contact. Unknown local contact
 * (null) = not applied.
 */
const effectAlreadyApplied = (
	local: Contact | null | undefined,
	decoded: DecodedContactMutation,
	indexId: string | undefined
): boolean => {
	if (!local) return false

	const action = decoded.contactAction
	const lidAction = decoded.lidContactAction
	const name = action
		? action.fullName || action.firstName || action.username || undefined
		: lidAction
			? lidAction.fullName || lidAction.firstName || lidAction.username || undefined
			: undefined
	const username = action?.username || lidAction?.username || undefined
	const lid = action?.lidJid || (lidAction ? indexId : undefined) || undefined
	// 1:1 with the live apply (sync-action-utils): when the index id is a PN
	// jid the phone number IS the id — contactAction.pnJid is usually null and
	// must only be used as fallback. Comparing against pnJid alone never
	// matched PN contacts, so the skip never fired and every pass replayed.
	const phoneNumber = action ? (isPnUser(indexId) ? indexId : action.pnJid || undefined) : undefined

	if ((name ?? undefined) !== (local.name ?? undefined)) return false
	if ((username ?? undefined) !== (local.username ?? undefined)) return false
	if ((lid ?? undefined) !== (local.lid ?? undefined)) return false
	if (action && (phoneNumber ?? undefined) !== (local.phoneNumber ?? undefined)) return false
	return true
}

const runHeal = async (
	deps: ContactAutoHealDeps,
	nowMs: number
): Promise<Extract<HealOnceResult, { status: 'ran' }>> => {
	const startedAt = nowMs
	const pendingIndexes = new Set(deps.listPendingContactMutations().map(row => row.mutationIndex))
	const rows = deps.listContactMutationsForHeal()

	let repaired = 0
	let added = 0
	let edited = 0
	let skippedApplied = 0
	let skippedPending = 0

	for (const row of rows) {
		if (pendingIndexes.has(row.mutationIndex)) {
			skippedPending++
			continue
		}

		const decoded = decodeContactMutation(row, deps.logger)
		if (!decoded || (!decoded.contactAction && !decoded.lidContactAction)) continue

		const id = decoded.indexId ?? row.chatJid ?? undefined
		const local = await deps.getLocalContact?.(id ?? '')
		if (effectAlreadyApplied(local, decoded, id)) {
			skippedApplied++
			continue
		}

		// Re-apply through the same effect path the live apply uses —
		// processContactAction for contactAction, the chat-utils
		// lidContactAction branch shape for lidContactAction.
		if (decoded.contactAction) {
			const results = processContactAction(decoded.contactAction, id, deps.logger)
			emitSyncActionResults(deps.ev, results)
		} else if (decoded.lidContactAction) {
			deps.ev.emit('contacts.upsert', [
				{
					id: id!,
					name:
						decoded.lidContactAction.fullName ||
						decoded.lidContactAction.firstName ||
						decoded.lidContactAction.username ||
						undefined,
					username: decoded.lidContactAction.username || undefined,
					lid: id!,
					phoneNumber: undefined
				}
			])
		}

		repaired++
		if (local) edited++
		else added++
	}

	return {
		status: 'ran',
		repaired,
		attempted: rows.length,
		added,
		edited,
		skippedApplied,
		skippedPending,
		durationMs: (deps.now ? deps.now() : Date.now()) - startedAt
	}
}

/**
 * One heal pass with the app's gate order. A `skipped` result never touches
 * the window timestamp — 'not_settled' especially must retry next tick.
 */
export const healOnce = async (deps: ContactAutoHealDeps): Promise<HealOnceResult> => {
	const nowMs = (deps.now ?? Date.now)()

	if (!deps.isCompanion()) return { status: 'skipped', reason: 'not_companion' }
	if (!deps.isEnabled()) return { status: 'skipped', reason: 'disabled' }

	const intervalHours = deps.intervalHours()
	if (!(intervalHours > 0)) return { status: 'skipped', reason: 'no_interval' }

	const last = deps.getLastHealTimestamp()
	if (last !== null && nowMs - last < intervalHours * 3_600_000) {
		return { status: 'skipped', reason: 'within_window' }
	}

	if (deps.listPendingContactMutations().length > 0) {
		return { status: 'skipped', reason: 'not_settled' }
	}

	const result = await runHeal(deps, nowMs)
	deps.setLastHealTimestamp(nowMs)
	// 1:1 with the app's heal log line.
	deps.logger.info(
		`CompanionContactAutoHealer/healOnce repaired=${result.repaired} attempted=${result.attempted} added=${result.added} edited=${result.edited}`
	)
	return result
}

export type ContactAutoHealScheduler = {
	start: () => void
	stop: () => void
	/** Forces a pass now, bypassing the tick throttle (still honors the window). */
	runNow: () => Promise<HealOnceResult | null>
}

/**
 * Hourly scheduler around healOnce — the app's HourlyCron with its 30-minute
 * anti-thrash floor between actual passes. Consecutive failures are counted
 * and logged (the app's crash-loop tracker analogue) but never stop the
 * schedule: a transient store error must not permanently disable healing.
 */
export const makeCompanionContactAutoHealer = (
	deps: ContactAutoHealDeps,
	options?: { tickMs?: number; minGapMs?: number }
): ContactAutoHealScheduler => {
	const tickMs = options?.tickMs ?? 3_600_000
	const minGapMs = options?.minGapMs ?? 1_800_000

	let timer: ReturnType<typeof setInterval> | null = null
	let lastAttemptMs = 0
	let consecutiveFailures = 0
	let isRunning = false

	const tick = async (force = false): Promise<HealOnceResult | null> => {
		const nowMs = (deps.now ?? Date.now)()
		if (!force && nowMs - lastAttemptMs < minGapMs) return null
		// Re-entrancy guard: runNow/force bypasses the throttle, so without
		// this two passes could overlap on the same mutation rows.
		if (isRunning) return null
		lastAttemptMs = nowMs
		isRunning = true

		try {
			const result = await healOnce(deps)
			if (result.status === 'ran') consecutiveFailures = 0
			return result
		} catch (err) {
			consecutiveFailures++
			deps.logger.error(
				{ err, consecutiveFailures },
				'CompanionContactAutoHealer: heal pass failed (crash-loop guard: schedule continues)'
			)
			return null
		} finally {
			isRunning = false
		}
	}

	return {
		start: () => {
			if (timer) return
			timer = setInterval(() => void tick(), tickMs)
			timer.unref?.()
			void tick(true)
		},
		stop: () => {
			if (timer) clearInterval(timer)
			timer = null
		},
		runNow: () => tick(true)
	}
}
