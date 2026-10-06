/**
 * Contact Refresh — peer data operation type 14 (CONTACT_REFRESH_REQUEST).
 *
 * This is the app's legitimate way for a companion to ask the primary to
 * refresh contact data WITHOUT contact mutations (which the server-side
 * mutation gate blocks for companion accounts). The request is bare — no
 * payload — the whole identity is the request id in `protocolMessage.key.id`:
 *
 *   requestId = HEX(MD5(timestamp 8B big-endian || userJid raw bytes ||
 *                      16 random bytes)), byte 0 overwritten with 0xAC,
 *              uppercase hex (32 chars) — 1:1 with the app's generator.
 *
 * Wire shape (peer message, category 'peer', to the primary):
 *
 *   Message.protocolMessage {
 *     key.id = requestId,
 *     type = PEER_DATA_OPERATION_REQUEST_MESSAGE (16),
 *     peerDataOperationRequestMessage {
 *       peerDataOperationRequestType = CONTACT_REFRESH_REQUEST (14)
 *     }
 *   }
 *
 * The response (PeerDataOperationRequestResponseMessage) carries only facts:
 * covered request ids, the target collection version on the primary, how long
 * the primary took and how many contacts it scanned. Contact DATA arrives
 * later as syncd contact/lid_contact mutations on critical_unblock_low —
 * reconcile then settles the pending request when the local collection
 * reaches the target version and the patch log confirms ingestion.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type { ContactRefreshPendingRow, ContactRefreshReplyFacts } from './multi-db-sqlite/contact-refresh-backend'

/** Magic first byte the app stamps into every request id. */
export const CONTACT_REFRESH_REQUEST_ID_MARKER = 0xac

/**
 * Defensive ceiling on how many covered request ids a single reply may
 * settle in one pass. The app coalesces only a handful per reply; the cap
 * bounds worst-case DB writes in the receive path.
 */
export const CONTACT_REFRESH_MAX_COVERED_IDS = 256

/**
 * Generates the request id exactly like the app:
 * MD5(timestamp 8B BE || userJid raw bytes || 16 random bytes), byte 0
 * replaced with 0xAC, uppercase hex. `now`/`random` are injectable for
 * golden tests; production uses Date.now() and crypto.randomBytes.
 */
export const generateContactRefreshRequestId = (
	userJidRawString: string,
	now: number = Date.now(),
	random: (size: number) => Buffer = nodeRandomBytes
): string => {
	const timestamp = Buffer.alloc(8)
	timestamp.writeBigUInt64BE(BigInt(now))
	const jidBytes = Buffer.from(userJidRawString, 'utf8')
	const salt = random(16)
	const digest = createHash('md5').update(timestamp).update(jidBytes).update(salt).digest()
	digest[0] = CONTACT_REFRESH_REQUEST_ID_MARKER
	return digest.toString('hex').toUpperCase()
}

/**
 * Builds the bare type-14 request payload. 1:1 with the app's serializer:
 * for type 14 only `peerDataOperationRequestType` is set — no payload field.
 */
export const buildContactRefreshRequest = (): proto.Message.IPeerDataOperationRequestMessage => ({
	peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.CONTACT_REFRESH_REQUEST
})

export type ContactRefreshReply = {
	/** Request ids this reply covers (the primary may coalesce several). */
	coveredRequestIds: string[]
	/** Primary's critical_unblock_low collection version at answer time. */
	collectionVersion: number | null
	primaryDurationMs: number | null
	uniqueContactCount: number | null
}

/**
 * Coerces proto numeric fields (uint64 etc.) that protobufjs may surface as
 * number, string or Long. Absent values stay null. Wire values are uint64
 * versions/durations/counts, so negatives (and NaN/Infinity) are rejected
 * as malformed. NOTE: Long.toNumber() loses precision above 2^53 — fine for
 * collection versions and durations in practice.
 */
const coerceOptionalNumber = (value: unknown): number | null => {
	if (value === null || value === undefined) return null
	let parsed: number | null = null
	if (typeof value === 'number') {
		parsed = value
	} else if (typeof value === 'string') {
		const n = Number(value)
		parsed = Number.isFinite(n) ? n : null
	} else if (
		typeof value === 'object' &&
		'toNumber' in value &&
		typeof (value as { toNumber: unknown }).toNumber === 'function'
	) {
		parsed = (value as { toNumber: () => number }).toNumber()
	}

	return parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Extracts the ContactRefreshResponse facts out of a peer data operation
 * response message. Returns null when the response isn't a type-14 reply.
 */
export const extractContactRefreshReply = (
	response: proto.Message.IPeerDataOperationRequestResponseMessage | null | undefined
): ContactRefreshReply | null => {
	if (!response) return null
	if (
		typeof response.peerDataOperationRequestType === 'number' &&
		response.peerDataOperationRequestType !== proto.Message.PeerDataOperationRequestType.CONTACT_REFRESH_REQUEST
	) {
		return null
	}

	const coveredRequestIds = new Set<string>()
	let collectionVersion: number | null = null
	let primaryDurationMs: number | null = null
	let uniqueContactCount: number | null = null
	let sawRefreshResponse = false

	for (const result of response.peerDataOperationResult ?? []) {
		const refresh = result?.contactRefreshResponse
		if (!refresh) continue
		sawRefreshResponse = true
		for (const id of refresh.coveredRequestIds ?? []) {
			if (typeof id === 'string') coveredRequestIds.add(id)
		}

		const version = coerceOptionalNumber(refresh.collectionVersion)
		if (version !== null) {
			collectionVersion = version
		}

		const duration = coerceOptionalNumber(refresh.primaryDurationMs)
		if (duration !== null) {
			primaryDurationMs = duration
		}

		const count = coerceOptionalNumber(refresh.uniqueContactCount)
		if (count !== null) {
			uniqueContactCount = count
		}
	}

	if (!sawRefreshResponse && coveredRequestIds.size === 0) return null

	return {
		coveredRequestIds: [...coveredRequestIds],
		collectionVersion,
		primaryDurationMs,
		uniqueContactCount
	}
}

/** Facts captured from a reply, keyed by the covered request id. */
export const replyFactsForPending = (reply: ContactRefreshReply): ContactRefreshReplyFacts => ({
	targetVersion: reply.collectionVersion,
	primaryDurationMs: reply.primaryDurationMs,
	contactUploadedCount: reply.uniqueContactCount
})

export type ContactRefreshReconcileDeps = {
	/** Local critical_unblock_low collection version (null = not tracked yet). */
	getCollectionVersion: () => number | null
	/**
	 * Patch log probe: "has local ingestion reached at least `version`?".
	 * The app checks its per-patch log for the exact target version; the
	 * engine mirrors one row per ingested mutation version, so the equivalent
	 * predicate is "a row exists at or above the target".
	 */
	hasPatchAtOrAbove: (version: number) => boolean
	deletePending: (refreshId: string) => void
	/**
	 * Patch-log prune (the app's deleteAtOrBelow) at the safe bound the
	 * reconcile computes: never below the smallest target of a request still
	 * waiting, and nothing at all while a waiting request has no reply facts
	 * yet (its future target is unknown).
	 */
	deletePatchesAtOrBelow: (version: number) => void
}

export type ContactRefreshSettled = {
	refreshId: string
	requestStartMs: number
	targetVersion: number
	primaryDurationMs: number | null
	contactUploadedCount: number | null
	/** Local collection version at settle time. */
	settledAtVersion: number
	settledAtMs: number
}

export type ContactRefreshReconcileOutcome = {
	settled: ContactRefreshSettled[]
	/** Pending rows still waiting (no reply yet, or data not landed locally). */
	waiting: number
}

/**
 * Capability advertisement (1:1 with the app's DeviceCapabilities sync
 * action): the refresh capability is an account-level sync action on
 * SyncActionValue (fields deviceCapabilities=54 / deviceCapabilitiesV2=92),
 * NOT part of the pairing DeviceProps. The app writes both fields live —
 * readers pick one by era — so both carry the same flag. Returns the
 * SyncActionValue to push through the normal appPatch path; the send-side
 * gate reads the primary's copy via readContactRefreshCapability.
 */
export const buildContactRefreshCapabilitySyncAction = (refreshSupported = true): proto.ISyncActionValue =>
	({
		deviceCapabilities: { contactRefresh: { refreshSupported } },
		deviceCapabilitiesV2: { contactRefresh: { refreshSupported } }
	}) as proto.ISyncActionValue

/**
 * Reads the contact-refresh capability out of an inbound device-capabilities
 * sync action (either era field). Returns undefined when the action doesn't
 * carry capabilities.
 */
export const readContactRefreshCapability = (
	action: proto.ISyncActionValue | null | undefined
): boolean | undefined => {
	const caps = action?.deviceCapabilities ?? action?.deviceCapabilitiesV2
	if (!caps?.contactRefresh) return undefined
	return caps.contactRefresh.refreshSupported ?? undefined
}

/**
 * Reconciles pending contact-refresh requests against local syncd state.
 * Settles each request whose reply already arrived (targetVersion known) once
 * the local collection reached the target version AND the patch log confirms
 * ingestion — mirroring the app's CYS reconcile: delete the pending row,
 * emit the wam_companion_contact_refresh facts, prune the patch log.
 */
export const reconcileContactRefresh = (
	pending: readonly ContactRefreshPendingRow[],
	deps: ContactRefreshReconcileDeps,
	now: number = Date.now()
): ContactRefreshReconcileOutcome => {
	const collectionVersion = deps.getCollectionVersion()
	const settled: ContactRefreshSettled[] = []
	const waitingTargets: number[] = []
	let waitingWithoutTarget = 0

	for (const row of pending) {
		const target = row.targetVersion
		if (target === null) {
			waitingWithoutTarget++
			continue
		}

		if (collectionVersion === null || collectionVersion < target || !deps.hasPatchAtOrAbove(target)) {
			waitingTargets.push(target)
			continue
		}

		deps.deletePending(row.refreshId)
		settled.push({
			refreshId: row.refreshId,
			requestStartMs: row.requestStartMs,
			targetVersion: target,
			primaryDurationMs: row.primaryDurationMs,
			contactUploadedCount: row.contactUploadedCount,
			settledAtVersion: collectionVersion,
			settledAtMs: now
		})
	}

	// Patch-log prune — at most one call per pass, at a bound no live pending
	// can still need: rows at/above the smallest target still waiting ARE the
	// evidence that request will settle on, so prune only below it. While a
	// waiting request has no reply facts yet its future target is unknown —
	// it could claim any version — so prune nothing at all in that case.
	// (Regression: pruning at the settled target mid-pass stranded
	// smaller-target pendings — e.g. A(target 150) settling before
	// B(target 100) destroyed the only patch row B's probe needed.)
	if (settled.length > 0 && waitingWithoutTarget === 0) {
		const maxSettledTarget = Math.max(...settled.map(entry => entry.targetVersion))
		const pruneBound = waitingTargets.length > 0 ? Math.min(...waitingTargets) - 1 : maxSettledTarget
		if (pruneBound >= 0) {
			deps.deletePatchesAtOrBelow(pruneBound)
		}
	}

	return { settled, waiting: waitingTargets.length + waitingWithoutTarget }
}
