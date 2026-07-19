import type { SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../Types'
import type { BinaryNode } from '../WABinary'
import {
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isHostedLidUser,
	isHostedPnUser,
	isJidMetaAI,
	isLidUser,
	isPnUser,
	jidNormalizedUser
} from '../WABinary'

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
	return !!(isPnUser(jid) || isLidUser(jid) || isHostedPnUser(jid) || isHostedLidUser(jid) || jid.endsWith('@c.us'))
}

/** 7 days in seconds — matches WA Web AB prop tctoken_duration */
const TC_TOKEN_BUCKET_DURATION = 604800
/** 4 buckets → ~28-day rolling window — matches WA Web AB prop tctoken_num_buckets */
const TC_TOKEN_NUM_BUCKETS = 4

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
export function isTcTokenExpired(timestamp: number | string | null | undefined): boolean {
	if (timestamp === null || timestamp === undefined) return true
	const ts = typeof timestamp === 'string' ? Number(timestamp) : timestamp
	if (isNaN(ts)) return true
	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
	const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1)
	const cutoffTimestamp = cutoffBucket * TC_TOKEN_BUCKET_DURATION
	return ts < cutoffTimestamp
}

export type TcTokenUsability = {
	usable: boolean
	reason?: 'missing-token' | 'empty-token' | 'expired-token'
}

/**
 * Evaluates every alias independently and accepts the first usable token.
 * A stale/empty LID row must not mask a valid PN row (or the inverse).
 */
export function selectUsableTcToken(
	candidates: Array<SignalDataTypeMap['tctoken'] | null | undefined>
): TcTokenUsability {
	const present = candidates.filter((entry): entry is SignalDataTypeMap['tctoken'] => !!entry)
	if (present.length === 0) return { usable: false, reason: 'missing-token' }
	const nonEmpty = present.filter(entry => !!entry.token?.length)
	if (nonEmpty.length === 0) return { usable: false, reason: 'empty-token' }
	if (nonEmpty.some(entry => !isTcTokenExpired(entry.timestamp))) return { usable: true }
	return { usable: false, reason: 'expired-token' }
}

/**
 * Check if we should issue a new token to this contact (bucket boundary crossed).
 * Reference: WAWebTrustedContactsUtils.shouldSendNewToken
 *
 * Returns true if senderTimestamp is null/undefined or in a previous bucket.
 */
export function shouldSendNewTcToken(senderTimestamp: number | undefined): boolean {
	if (senderTimestamp === undefined) return true
	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
	const senderBucket = Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION)
	return currentBucket > senderBucket
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
	const lid = isLidUser(normalized) ? normalized : await resolvers.getLIDForPN(normalized)
	const canonical = lid ? jidNormalizedUser(lid) : normalized
	const pn = isLidUser(canonical) ? await resolvers.getPNForLID?.(canonical) : normalized

	return [...new Set([canonical, pn ? jidNormalizedUser(pn) : undefined].filter((value): value is string => !!value))]
}

export type SelectedTcToken = TcTokenUsability & {
	jid?: string
	entry?: SignalDataTypeMap['tctoken']
}

/** Selects the newest non-empty, non-expired incoming token across PN/LID aliases. */
export function selectNewestUsableTcToken(
	candidates: ReadonlyArray<readonly [jid: string, entry: SignalDataTypeMap['tctoken'] | null | undefined]>
): SelectedTcToken {
	const present = candidates.filter(
		(candidate): candidate is readonly [string, SignalDataTypeMap['tctoken']] => !!candidate[1]
	)
	if (present.length === 0) return { usable: false, reason: 'missing-token' }
	const nonEmpty = present.filter(([, entry]) => !!entry.token?.length)
	if (nonEmpty.length === 0) return { usable: false, reason: 'empty-token' }
	const usable = nonEmpty
		.filter(([, entry]) => !isTcTokenExpired(entry.timestamp))
		.sort(([, left], [, right]) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0))[0]
	if (!usable) return { usable: false, reason: 'expired-token' }

	return { usable: true, jid: usable[0], entry: usable[1] }
}

export type TcTokenIssueAliasGroup = {
	requestedJid: string
	aliases: string[]
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
	if (isLidUser(normalized)) return normalized
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
type ResolvedTcToken = { buffer?: Buffer }

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
	getPNForLID
}: Pick<TcTokenParams, 'authState' | 'jid' | 'getLIDForPN' | 'getPNForLID'>): Promise<ResolvedTcToken> {
	try {
		const aliases = getLIDForPN
			? await resolveTcTokenAliases(jid, { getLIDForPN, getPNForLID })
			: [jidNormalizedUser(jid)]
		const tcTokenData = await authState.keys.get('tctoken', aliases)
		const selected = selectNewestUsableTcToken(aliases.map(alias => [alias, tcTokenData?.[alias]] as const))
		const entry = selected.entry
		const tcTokenBuffer = entry?.token

		if (!selected.usable || !tcTokenBuffer?.length) {
			if (selected.reason === 'expired-token') {
				const expired: Record<string, SignalDataTypeMap['tctoken'] | null> = {}
				const expiredAliases = aliases.filter(alias => {
					const candidate = tcTokenData?.[alias]

					return !!candidate?.token?.length && isTcTokenExpired(candidate.timestamp)
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

		return { buffer: tcTokenBuffer }
	} catch {
		return {}
	}
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
	getPNForLID
}: TcTokenParams): Promise<BinaryNode[] | undefined> {
	const { buffer } = await resolveTcTokenForJid({ authState, jid, getLIDForPN, getPNForLID })

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
	getPNForLID
}: Omit<TcTokenParams, 'baseContent'>): Promise<BinaryNode | undefined> {
	const { buffer } = await resolveTcTokenForJid({ authState, jid, getLIDForPN, getPNForLID })

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

		// Timestamp monotonicity guard — only store if incoming timestamp >= existing
		// Matches WA Web handleIncomingTcToken
		const existingTs = existingEntry?.timestamp ? Number(existingEntry.timestamp) : 0
		const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : 0
		if (existingTs > 0 && incomingTs > 0 && existingTs > incomingTs) {
			continue
		}

		// Don't store timestamp-less tokens at all — isTcTokenExpired treats them
		// as immediately expired regardless of whether an existing entry is present
		if (!incomingTs) {
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
