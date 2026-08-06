import type { SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../Types'
import type { BinaryNode } from '../WABinary'
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isAnyLidUser,
	isHostedLidUser,
	isHostedPnUser,
	isJidMetaAI,
	isPnUser,
	jidNormalizedUser
} from '../WABinary'
import type { HistoryTcToken } from './history'

// Same phone-number pattern as WABinary's isJidBot, applied against the user
// part so the check is invariant to @c.us ↔ @s.whatsapp.net normalization.
const BOT_PHONE_REGEX = /^1313555\d{4}$|^131655500\d{2}$/

/**
 * Mirrors WA Web's `Wid.isRegularUser()` (user ∧ ¬PSA ∧ ¬Bot). Used to gate tctoken
 * storage against malformed notifications — WA Web filters server-side but we
 * defend here for parity with `WAWebSetTcTokenChatAction.handleIncomingTcToken`.
 * Works for both pre- and post-normalized JIDs (`@c.us` vs `@s.whatsapp.net`).
 */
export function isRegularUser(jid: string | undefined): boolean {
	if (!jid) return false
	const user = jid.split('@')[0] ?? ''
	if (!user) return false // empty user part (e.g. malformed `@s.whatsapp.net`)
	if (user === '0') return false // PSA
	if (BOT_PHONE_REGEX.test(user)) return false // Bot by phone pattern
	if (isJidMetaAI(jid)) return false // MetaAI (@bot server)
	return !!(isPnUser(jid) || isAnyLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid) || jid.endsWith('@c.us'))
}

/** 7 days in seconds — matches WA Web AB prop tctoken_duration */
const TC_TOKEN_BUCKET_DURATION = 604800
/** 4 buckets → ~28-day rolling window — matches WA Web AB prop tctoken_num_buckets */
const TC_TOKEN_NUM_BUCKETS = 4

export type TcTokenAbProps = NonNullable<import('../Types').SocketConfig['tcTokenAbProps']>
export type TcTokenBucketPolicy = {
	profile: 'web' | 'native_android'
	incoming: { durationSeconds: number; numBuckets: number }
	sent: { durationSeconds: number; numBuckets: number }
}

const positiveInteger = (value: number | undefined, fallback: number): number =>
	Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback

/** Resolves captured profile defaults and applies server AB props independently per direction. */
export function resolveTcTokenBucketPolicy(
	profile: TcTokenBucketPolicy['profile'],
	abProps: TcTokenAbProps = {}
): TcTokenBucketPolicy {
	return {
		profile,
		incoming: {
			durationSeconds: positiveInteger(abProps.tctoken_duration, TC_TOKEN_BUCKET_DURATION),
			numBuckets: positiveInteger(abProps.tctoken_num_buckets, TC_TOKEN_NUM_BUCKETS)
		},
		sent: {
			durationSeconds: positiveInteger(abProps.tctoken_duration_sender, TC_TOKEN_BUCKET_DURATION),
			numBuckets: positiveInteger(abProps.tctoken_num_buckets_sender, TC_TOKEN_NUM_BUCKETS)
		}
	}
}

/**
 * Check if a received token is expired using WA Web's rolling bucket algorithm.
 * Reference: WAWebTrustedContactsUtils.isTokenExpired
 *
 * Uses Receiver mode constants (tctoken_duration, tctoken_num_buckets).
 * NOTE: WA Web distinguishes Sender vs Receiver mode via AB props
 * (tctoken_duration_sender / tctoken_num_buckets_sender). Currently both
 * use identical values (604800 / 4), so we use a single function for both.
 * If WA ever diverges these, add a `mode` parameter here.
 */
export function isTcTokenExpired(
	timestamp: number | string | null | undefined,
	policy = resolveTcTokenBucketPolicy('web'),
	mode: 'incoming' | 'sent' = 'incoming'
): boolean {
	if (timestamp === null || timestamp === undefined) return true
	const ts = typeof timestamp === 'string' ? Number(timestamp) : timestamp
	if (isNaN(ts)) return true
	const now = Math.floor(Date.now() / 1000)
	const { durationSeconds, numBuckets } = policy[mode]
	const currentBucket = Math.floor(now / durationSeconds)
	const cutoffBucket = currentBucket - (numBuckets - 1)
	const cutoffTimestamp = cutoffBucket * durationSeconds
	return ts < cutoffTimestamp
}

export type TcTokenUsability = {
	usable: boolean
	reason?: 'missing-token' | 'empty-token' | 'expired-token'
}

/** Official incoming-token conflict rule: only a strictly newer timestamp wins. */
export function isStrictlyNewerTcTokenTimestamp(
	incoming: number | string | null | undefined,
	existing: number | string | null | undefined
): boolean {
	const incomingTimestamp = Number(incoming ?? 0)
	const existingTimestamp = Number(existing ?? 0)
	return Number.isFinite(incomingTimestamp) && incomingTimestamp > 0 && incomingTimestamp > existingTimestamp
}

/**
 * Evaluates every alias independently and accepts the first usable token.
 * A stale/empty LID row must not mask a valid PN row (or the inverse).
 */
export function selectUsableTcToken(
	candidates: Array<SignalDataTypeMap['tctoken'] | null | undefined>,
	policy = resolveTcTokenBucketPolicy('web')
): TcTokenUsability {
	const present = candidates.filter((entry): entry is SignalDataTypeMap['tctoken'] => !!entry)
	if (present.length === 0) return { usable: false, reason: 'missing-token' }
	const nonEmpty = present.filter(entry => !!entry.token?.length)
	if (nonEmpty.length === 0) return { usable: false, reason: 'empty-token' }
	if (nonEmpty.some(entry => !isTcTokenExpired(entry.timestamp, policy))) return { usable: true }
	return { usable: false, reason: 'expired-token' }
}

/**
 * Check if we should issue a new token to this contact (bucket boundary crossed).
 * Reference: WAWebTrustedContactsUtils.shouldSendNewToken
 *
 * Returns true if senderTimestamp is null/undefined or in a previous bucket.
 */
export function shouldSendNewTcToken(
	senderTimestamp: number | undefined,
	policy = resolveTcTokenBucketPolicy('web'),
	nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
	if (senderTimestamp === undefined) return true
	const currentBucket = Math.floor(nowSeconds / policy.sent.durationSeconds)
	const senderBucket = Math.floor(senderTimestamp / policy.sent.durationSeconds)
	return currentBucket > senderBucket
}

export type PrunedTcToken = {
	next: SignalDataTypeMap['tctoken'] | null
	incomingPruned: boolean
	sentPruned: boolean
}

/** Prunes incoming and sent halves independently; neither half can delete a still-live peer. */
export function pruneTcTokenHalves(
	entry: SignalDataTypeMap['tctoken'],
	policy = resolveTcTokenBucketPolicy('web')
): PrunedTcToken {
	const incomingPruned = !!entry.token?.length && isTcTokenExpired(entry.timestamp, policy, 'incoming')
	const sentPruned = entry.senderTimestamp !== undefined && isTcTokenExpired(entry.senderTimestamp, policy, 'sent')
	const hasIncoming = !!entry.token?.length && !incomingPruned
	const hasSent = entry.senderTimestamp !== undefined && !sentPruned
	if (!hasIncoming && !hasSent) return { next: null, incomingPruned, sentPruned }

	return {
		next: {
			token: hasIncoming ? Buffer.from(entry.token) : Buffer.alloc(0),
			...(hasIncoming && entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
			...(hasSent ? { senderTimestamp: entry.senderTimestamp, realIssueTimestamp: entry.realIssueTimestamp } : {})
		},
		incomingPruned,
		sentPruned
	}
}

export type TcTokenAliasResolvers = {
	getLIDForPN: (pn: string) => Promise<string | null>
	getPNForLID?: (lid: string) => Promise<string | null>
}

/**
 * Returns the canonical LID first and its PN alias second when both are known.
 * The Android store performs the equivalent `jid IN (LID, PN)` lookup and
 * persists new rows under LID. Keeping the order stable also gives callers a
 * single canonical key for writes without hiding a legacy PN row during reads.
 */
export async function resolveTcTokenAliases(jid: string, resolvers: TcTokenAliasResolvers): Promise<string[]> {
	const normalized = jidNormalizedUser(jid)
	const lid = isAnyLidUser(normalized) ? normalized : await resolvers.getLIDForPN(normalized)
	const canonical = lid ? jidNormalizedUser(lid) : normalized
	const pn = isAnyLidUser(canonical) ? await resolvers.getPNForLID?.(canonical) : normalized

	return [...new Set([canonical, pn ? jidNormalizedUser(pn) : undefined].filter((value): value is string => !!value))]
}

/** Includes the notification's authoritative PN even before the LID map is populated. */
export async function resolveIncomingTcTokenAliases(
	from: string,
	senderLid: string | undefined,
	resolvers: TcTokenAliasResolvers
): Promise<string[]> {
	const resolved = await resolveTcTokenAliases(senderLid || from, resolvers)

	return [...new Set([...resolved, jidNormalizedUser(from)])]
}

export type SelectedTcToken = TcTokenUsability & {
	jid?: string
	entry?: SignalDataTypeMap['tctoken']
}

/** Selects the newest non-empty, non-expired incoming token across PN/LID aliases. */
export function selectNewestUsableTcToken(
	candidates: ReadonlyArray<readonly [jid: string, entry: SignalDataTypeMap['tctoken'] | null | undefined]>,
	policy = resolveTcTokenBucketPolicy('web')
): SelectedTcToken {
	const present = candidates.filter(
		(candidate): candidate is readonly [string, SignalDataTypeMap['tctoken']] => !!candidate[1]
	)
	if (present.length === 0) return { usable: false, reason: 'missing-token' }
	const nonEmpty = present.filter(([, entry]) => !!entry.token?.length)
	if (nonEmpty.length === 0) return { usable: false, reason: 'empty-token' }
	const usable = nonEmpty
		.filter(([, entry]) => !isTcTokenExpired(entry.timestamp, policy))
		.sort(([, left], [, right]) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0))[0]
	if (!usable) return { usable: false, reason: 'expired-token' }

	return { usable: true, jid: usable[0], entry: usable[1] }
}

export type TcTokenIssueAliasGroup = {
	requestedJid: string
	aliases: string[]
}

export type RestoreHistoryTcTokensResult = {
	restored: number
	skipped: number
}

/**
 * Restores the two independent trusted-contact token halves carried by a
 * history conversation. Mappings are expected to be committed before this
 * runs, allowing a PN row to be canonicalized under its LID in the same
 * durable history apply that owns the checkpoint.
 */
export async function restoreTcTokensFromHistory({
	entries,
	keys,
	resolvers
}: {
	entries: readonly HistoryTcToken[]
	keys: SignalKeyStoreWithTransaction
	resolvers: TcTokenAliasResolvers
}): Promise<RestoreHistoryTcTokensResult> {
	let restored = 0
	let skipped = 0

	for (const entry of entries) {
		if (!isRegularUser(entry.jid)) {
			skipped++
			continue
		}

		const aliases = await resolveTcTokenAliases(entry.jid, resolvers)
		const canonicalJid = aliases[0]!
		const records = aliases.map(id => ({ type: 'tctoken' as const, id }))
		let applied = false
		const work = async () => {
			const current = await keys.get('tctoken', aliases)
			const existingIncoming = aliases
				.map(alias => current[alias])
				.filter(
					(candidate): candidate is SignalDataTypeMap['tctoken'] =>
						!!candidate?.token?.length && Number(candidate.timestamp ?? 0) > 0
				)
				.sort((left, right) => Number(right.timestamp) - Number(left.timestamp))[0]
			const existingSent = aliases
				.map(alias => current[alias])
				.filter(
					(candidate): candidate is SignalDataTypeMap['tctoken'] =>
						candidate?.senderTimestamp !== undefined && Number(candidate.senderTimestamp) > 0
				)
				.sort((left, right) => Number(right.senderTimestamp) - Number(left.senderTimestamp))[0]

			const historyIncomingIsNewer =
				!!entry.token?.length && isStrictlyNewerTcTokenTimestamp(entry.timestamp, existingIncoming?.timestamp)
			const historySentIsNewer =
				Number(entry.senderTimestamp ?? 0) > 0 &&
				Number(entry.senderTimestamp) > Number(existingSent?.senderTimestamp ?? 0)
			const hasLegacyAliasState = aliases.slice(1).some(alias => current[alias] !== undefined)
			if (!historyIncomingIsNewer && !historySentIsNewer && !hasLegacyAliasState) return

			const incoming = historyIncomingIsNewer
				? { token: Buffer.from(entry.token!), timestamp: String(entry.timestamp) }
				: existingIncoming
			const sent = historySentIsNewer
				? { senderTimestamp: entry.senderTimestamp, realIssueTimestamp: null as number | null }
				: existingSent
			const canonical: SignalDataTypeMap['tctoken'] = {
				token: incoming?.token ? Buffer.from(incoming.token) : Buffer.alloc(0),
				...(incoming?.timestamp !== undefined ? { timestamp: String(incoming.timestamp) } : {}),
				...(sent?.senderTimestamp !== undefined ? { senderTimestamp: Number(sent.senderTimestamp) } : {}),
				...(sent?.realIssueTimestamp !== undefined ? { realIssueTimestamp: sent.realIssueTimestamp } : {})
			}
			const bucket: Record<string, SignalDataTypeMap['tctoken'] | null> = { [canonicalJid]: canonical }
			for (const alias of aliases.slice(1)) bucket[alias] = null
			await keys.set({ tctoken: bucket })
			applied = true
		}

		if (keys.transactWith) await keys.transactWith({ records }, work)
		else await keys.transaction(work, `history-tctoken:${records.map(record => record.id).join(',')}`)
		if (applied) restored++
		else skipped++
	}

	return { restored, skipped }
}

/**
 * Joins in-flight work by canonical contact key. Callers serialize invocation
 * while inspecting the map; cleanup is identity-checked so an old completion
 * can never delete a newer flight registered for the same contact.
 */
export function getOrCreateTcTokenIssueFlight<T>(
	flights: Map<string, Promise<T>>,
	keys: string[],
	create: (uncoveredKeys: string[]) => Promise<T>
): Promise<T> {
	const uniqueKeys = [...new Set(keys)]
	const existing = [
		...new Set(uniqueKeys.map(key => flights.get(key)).filter((flight): flight is Promise<T> => !!flight))
	]
	const uncovered = uniqueKeys.filter(key => !flights.has(key))
	if (!uncovered.length && existing.length) {
		return existing.length === 1 ? existing[0]! : Promise.all(existing).then(results => results.at(-1)!)
	}

	const flight = create(uncovered)
	for (const key of uncovered) flights.set(key, flight)
	const release = () => {
		for (const key of uncovered) {
			if (flights.get(key) === flight) flights.delete(key)
		}
	}

	flight.then(release, release)

	return existing.length ? Promise.all([...existing, flight]).then(results => results.at(-1)!) : flight
}

/**
 * Mirrors the observed mobile sent-token state machine in the key-store
 * abstraction so relational authority and signal_kv backup move together:
 * scheduled = realIssueTimestamp 0, confirmed = NULL. The confirmation
 * checks the newest alias timestamp under the same record lock, preventing a
 * late ACK from overwriting a newer issue, then removes only the PN sent half.
 */
export async function updateTcTokenIssueState({
	keys,
	aliasGroups,
	issueTimestamp,
	phase,
	onStaleAck
}: {
	keys: SignalKeyStoreWithTransaction
	aliasGroups: TcTokenIssueAliasGroup[]
	issueTimestamp: number
	phase: 'scheduled' | 'confirmed'
	onStaleAck?: (details: { requestedJid: string; canonicalJid: string; newerTimestamp: number }) => void
}): Promise<boolean> {
	const records = aliasGroups.flatMap(({ aliases }) => aliases.map(id => ({ type: 'tctoken' as const, id })))
	let applied = true
	const work = async () => {
		for (const { requestedJid, aliases } of aliasGroups) {
			const canonicalJid = aliases[0]!
			const current = await keys.get('tctoken', aliases)
			const sentEntries = aliases
				.map(alias => current[alias])
				.filter((entry): entry is SignalDataTypeMap['tctoken'] => entry?.senderTimestamp !== undefined)
				.sort((left, right) => Number(right.senderTimestamp) - Number(left.senderTimestamp))
			const newestSent = sentEntries[0]

			if (phase === 'confirmed' && Number(newestSent?.senderTimestamp ?? 0) > issueTimestamp) {
				applied = false
				onStaleAck?.({
					requestedJid,
					canonicalJid,
					newerTimestamp: Number(newestSent!.senderTimestamp)
				})
				continue
			}

			const canonical = current[canonicalJid]
			const bucket: Record<string, SignalDataTypeMap['tctoken'] | null> = {
				[canonicalJid]: {
					...canonical,
					token: canonical?.token ?? Buffer.alloc(0),
					senderTimestamp: issueTimestamp,
					realIssueTimestamp:
						phase === 'confirmed'
							? null
							: newestSent?.realIssueTimestamp === null
								? 0
								: (newestSent?.realIssueTimestamp ?? 0)
				}
			}

			if (phase === 'confirmed') {
				for (const alias of aliases.slice(1)) {
					const aliasEntry = current[alias]
					if (aliasEntry?.senderTimestamp === undefined) continue
					bucket[alias] = aliasEntry.token?.length ? { token: aliasEntry.token, timestamp: aliasEntry.timestamp } : null
				}
			}

			await keys.set({ tctoken: bucket })
		}
	}

	if (keys.transactWith) {
		await keys.transactWith({ records }, work)
	} else {
		await keys.transaction(work, `privacy-token-issue:${records.map(record => record.id).join(',')}`)
	}

	return applied
}

/**
 * Resolve a JID to its LID for tctoken storage, mirroring how Signal sessions
 * use LID keys via resolveLIDSignalAddress.
 *
 * WA Web always resolves to LID before storing/looking up tctokens:
 * `senderLid ?? toLid(from)` (WAWebSetTcTokenChatAction.handleIncomingTcToken)
 *
 * @param jid - The JID to resolve (can be PN or LID)
 * @param getLIDForPN - Resolver function (from lidMapping)
 * @returns The LID if mapping exists, otherwise the original JID
 */
export async function resolveTcTokenJid(
	jid: string,
	getLIDForPN: (pn: string) => Promise<string | null>
): Promise<string> {
	const normalized = jidNormalizedUser(jid)
	if (isAnyLidUser(normalized)) return normalized
	const lid = await getLIDForPN(normalized)
	return lid ?? normalized
}

type TcTokenParams = {
	jid: string
	baseContent?: BinaryNode[]
	authState: {
		keys: SignalKeyStoreWithTransaction
	}
	getLIDForPN?: (pn: string) => Promise<string | null>
	getPNForLID?: (lid: string) => Promise<string | null>
	bucketPolicy?: TcTokenBucketPolicy
}

/**
 * Resolved tctoken state for a JID, shared by the two public builders.
 *
 * - `buffer`: present iff a non-expired, non-empty token exists in store.
 * - Absent `buffer`: caller produces a "no tctoken" result (the shape of
 *   that result differs per builder — array vs single node).
 *
 * The helper is also responsible for the opportunistic expired-token wipe
 * documented inline. Callers must NOT re-do that bookkeeping.
 */
export type ResolvedTcToken = { buffer?: Buffer; timestamp?: string }

/**
 * Shared retrieval + expiry + opportunistic-cleanup pipeline used by both
 * `buildTcTokenFromJid` (sibling-array shape, kept for legacy call sites)
 * and `buildTcTokenNode` (single-node shape, used for nested tctoken in
 * `<picture>`). Extracting this collapses what used to be two
 * byte-for-byte identical critical sections so any future change to the
 * expiry / cleanup semantics happens in one place.
 *
 * Returns `{}` (no buffer) on every "no usable token" outcome:
 *   - store miss
 *   - empty token
 *   - expired token (also performs the cleanup write)
 *   - key-store error (swallowed; callers fall back to base content)
 *
 * Notes on the cleanup write (preserved from the original implementation):
 *   - Only fires when an EXPIRED non-empty token was found. Missing tokens
 *     are NOT wiped because nothing exists to wipe.
 *   - If the entry carried a `senderTimestamp`, we preserve it via a
 *     placeholder `{ token: Buffer.alloc(0), senderTimestamp }` so the
 *     fire-and-forget issuance dedupe in messages-send survives. Otherwise
 *     we tombstone the entry with `null`.
 *   - Matches the exact same shape messages-send writes for issuance
 *     placeholders, so we never accidentally widen the wipe to clear a
 *     legitimate placeholder.
 */
async function resolveTcTokenForJid({
	authState,
	jid,
	getLIDForPN,
	getPNForLID,
	bucketPolicy
}: Pick<TcTokenParams, 'authState' | 'jid' | 'getLIDForPN' | 'getPNForLID' | 'bucketPolicy'>): Promise<ResolvedTcToken> {
	try {
		const aliases = getLIDForPN
			? await resolveTcTokenAliases(jid, { getLIDForPN, getPNForLID })
			: [jidNormalizedUser(jid)]
		const tcTokenData = await authState.keys.get('tctoken', aliases)
		const selected = selectNewestUsableTcToken(
			aliases.map(alias => [alias, tcTokenData?.[alias]] as const),
			bucketPolicy
		)
		const entry = selected.entry
		const tcTokenBuffer = entry?.token

		if (!selected.usable || !tcTokenBuffer?.length) {
			if (selected.reason === 'expired-token') {
				const expired: Record<string, SignalDataTypeMap['tctoken'] | null> = {}
				const expiredAliases = aliases.filter(alias => {
					const candidate = tcTokenData?.[alias]

					return !!candidate?.token?.length && isTcTokenExpired(candidate.timestamp, bucketPolicy)
				})

				for (const alias of expiredAliases) {
					const candidate = tcTokenData[alias]!

					expired[alias] =
						candidate.senderTimestamp !== undefined
							? {
									token: Buffer.alloc(0),
									senderTimestamp: candidate.senderTimestamp,
									realIssueTimestamp: candidate.realIssueTimestamp
								}
							: null
				}

				if (Object.keys(expired).length) await authState.keys.set({ tctoken: expired })
			}

			return {}
		}

		return { buffer: tcTokenBuffer, timestamp: entry?.timestamp }
	} catch {
		return {}
	}
}

/** Returns the current incoming privacy token for an explicitly selected protocol call site. */
export async function resolveUsableTcTokenForJid(
	params: Pick<TcTokenParams, 'authState' | 'jid' | 'getLIDForPN' | 'getPNForLID' | 'bucketPolicy'>
): Promise<ResolvedTcToken> {
	return resolveTcTokenForJid(params)
}

/**
 * Legacy sibling-array shape. Used by `presenceSubscribe` where the tctoken
 * is the only content of a `<presence>` (so the "sibling" framing is moot —
 * there's nothing to sibling against). Kept on the legacy
 * `buildTcTokenFromJid` + `getLIDForPN` resolver pair for behavioral
 * stability.
 *
 * Returns `baseContent` (mutated in place with the `<tctoken>` appended)
 * when a token exists, or `baseContent | undefined` otherwise — same exact
 * contract as before the helper extraction.
 */
export async function buildTcTokenFromJid({
	authState,
	jid,
	baseContent = [],
	getLIDForPN,
	getPNForLID,
	bucketPolicy
}: TcTokenParams): Promise<BinaryNode[] | undefined> {
	const { buffer } = await resolveTcTokenForJid({ authState, jid, getLIDForPN, getPNForLID, bucketPolicy })

	if (!buffer) {
		return baseContent.length > 0 ? baseContent : undefined
	}

	baseContent.push({ tag: 'tctoken', attrs: {}, content: buffer })
	return baseContent
}

/**
 * Build a standalone <tctoken> BinaryNode (no container, no sibling array).
 *
 * Use this when the caller needs the tctoken as a CHILD of another stanza node
 * — e.g. nested inside <picture> for `w:profile:picture` queries (port of
 * upstream PR #2614 / matches WA Web's `WASmaxOutProfilePictureTCTokenMixin`
 * + whatsmeow's `pictureContent`).
 *
 * Returns the node when a valid (non-expired, non-empty) tctoken exists for
 * the resolved storage JID, or `undefined` otherwise.
 */
export async function buildTcTokenNode({
	authState,
	jid,
	getLIDForPN,
	getPNForLID,
	bucketPolicy
}: Omit<TcTokenParams, 'baseContent'>): Promise<BinaryNode | undefined> {
	const { buffer } = await resolveTcTokenForJid({ authState, jid, getLIDForPN, getPNForLID, bucketPolicy })

	return buffer ? { tag: 'tctoken', attrs: {}, content: buffer } : undefined
}

type StoreTcTokensParams = {
	result: BinaryNode
	fallbackJid: string
	keys: SignalKeyStoreWithTransaction
	getLIDForPN: (pn: string) => Promise<string | null>
	/** Optional callback when a new JID is stored (for index tracking) */
	onNewJidStored?: (jid: string) => void
}

export type StoreTcTokensResult = {
	storedJids: string[]
	validTokenNodes: number
}

export type ParsedTrustedContactToken = {
	from: string
	senderLid?: string
	timestamp?: string
	timestampSource?: 'token-node' | 'notification-node'
	childTimestamp?: string
	outerTimestamp?: string
	token: Buffer
}

/** Parses the outer notification attributes with child overrides, as WABA does. */
export function parseTrustedContactTokenNotification(node: BinaryNode): ParsedTrustedContactToken[] {
	const tokensNode = getBinaryNodeChild(node, 'tokens')
	if (!tokensNode) return []
	const from = jidNormalizedUser(node.attrs.from)
	const outerSenderLid = node.attrs.sender_lid ? jidNormalizedUser(node.attrs.sender_lid) : undefined
	return getBinaryNodeChildren(tokensNode, 'token').flatMap(tokenNode => {
		if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) return []
		const childTimestamp = tokenNode.attrs.t
		const outerTimestamp = node.attrs.t
		return [
			{
				from,
				senderLid:
					outerSenderLid || (tokenNode.attrs.sender_lid ? jidNormalizedUser(tokenNode.attrs.sender_lid) : undefined),
				timestamp: childTimestamp || outerTimestamp,
				timestampSource: childTimestamp ? 'token-node' : outerTimestamp ? 'notification-node' : undefined,
				childTimestamp,
				outerTimestamp,
				token: Buffer.from(tokenNode.content)
			}
		]
	})
}

/**
 * Parse and store peer tctoken(s) from a legacy result-shaped node.
 * Includes the timestamp monotonicity guard used by incoming notifications.
 *
 * @deprecated A privacy `type=set` IQ is issuance and its empty result is an
 * ACK, not a peer-token response. New socket paths ingest peer tokens only
 * from `privacy_token` notifications; this remains for API compatibility.
 */
export async function storeTcTokensFromIqResult({
	result,
	fallbackJid,
	keys,
	getLIDForPN,
	onNewJidStored
}: StoreTcTokensParams): Promise<StoreTcTokensResult> {
	const storedJids = new Set<string>()
	let validTokenNodes = 0
	const tokensNode = getBinaryNodeChild(result, 'tokens')
	if (!tokensNode) return { storedJids: [], validTokenNodes }

	const tokenNodes = getBinaryNodeChildren(tokensNode, 'token')
	for (const tokenNode of tokenNodes) {
		if (tokenNode.attrs.type !== 'trusted_contact' || !(tokenNode.content instanceof Uint8Array)) {
			continue
		}

		const rawJid = jidNormalizedUser(tokenNode.attrs.jid || fallbackJid)
		// Defensive parity with WA Web: never store tokens under PSA/bot/MetaAI JIDs,
		// which a malformed notification could otherwise smuggle in.
		if (!isRegularUser(rawJid)) {
			continue
		}

		const storageJid = await resolveTcTokenJid(rawJid, getLIDForPN)
		const existingTcData = await keys.get('tctoken', [storageJid])
		const existingEntry = existingTcData[storageJid]

		// Timestamp monotonicity guard — only a strictly newer token may replace
		// the accepted value. Equal timestamps are replays even if bytes differ.
		// Matches WA Web handleIncomingTcToken
		const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0
		const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : 0
		if (!isStrictlyNewerTcTokenTimestamp(incomingTs, existingTs)) {
			continue
		}

		validTokenNodes++

		const tokenEntry = {
			...existingEntry,
			token: Buffer.from(tokenNode.content),
			timestamp: tokenNode.attrs.t
		}

		// Store under the resolved identity and under fallbackJid only when both
		// resolve to the same contact. An IQ may return a token for a different
		// JID (including our own LID); copying that token onto the requested
		// recipient would poison future sends with another account's token.
		const normalizedFallback = jidNormalizedUser(fallbackJid)
		const keysToStore: Record<string, typeof tokenEntry | null> = {
			[storageJid]: tokenEntry
		}
		const fallbackStorageJid = await resolveTcTokenJid(normalizedFallback, getLIDForPN)
		if (normalizedFallback !== storageJid && fallbackStorageJid === storageJid) {
			keysToStore[normalizedFallback] = tokenEntry
		}

		await keys.set({ tctoken: keysToStore })
		for (const jid of Object.keys(keysToStore)) {
			storedJids.add(jid)
			onNewJidStored?.(jid)
		}
	}

	return { storedJids: [...storedJids], validTokenNodes }
}
