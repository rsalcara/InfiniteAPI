/**
 * Per-process cache of the envelope data a receipt has to echo back for an
 * inbound message: the server `sts` timestamp and the sender's device JID.
 *
 * Both values live only on the inbound stanza (`sts` attr, `from`/`participant`
 * with device suffix) and are stripped from the public `WAMessageKey`, but the
 * W4B receipt builder (`X/AbstractC29398Cuq.A00`, addressing via
 * `X/AbstractC29271CsI.A06`) needs them: `sts` is echoed verbatim (no `t`) and
 * the receipt is addressed to the sending *device*. `readMessages(keys)` only
 * receives keys, so decode time stashes them here keyed by account + message id.
 *
 * Entries are scoped per account (the same id under two accounts is two
 * different messages and one account's burst must never evict another's),
 * expire after `ENTRY_TTL_MS`, evict FIFO past `MAX_ENTRIES_PER_ACCOUNT`, and
 * are consumed by the read-family receipt — the last receipt a message id gets.
 * Delivery, `hist_sync` and `inactive` receipts come first and peek, so the
 * later read receipt can still echo `sts`. A lookup that misses (restart, TTL,
 * eviction) leaves the caller the bare-jid `:0` addressing with no `sts`.
 */

import { jidNormalizedUser } from '../WABinary'

export type MessageEcho = {
	/** Server timestamp (µs string) added to inbound envelopes. */
	sts?: string | null
	/** Sender's device JID as it appeared on the stanza (from/participant). */
	senderDeviceJid?: string | null
}

type EchoEntry = {
	echo: MessageEcho
	storedAt: number
}

const echoesByAccount = new Map<string, Map<string, EchoEntry>>()
const MAX_ENTRIES_PER_ACCOUNT = 10_000
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000

const bucketFor = (accountId: string | null | undefined, create: boolean): Map<string, EchoEntry> | undefined => {
	const key = (accountId ? jidNormalizedUser(accountId) : '') || ''
	let bucket = echoesByAccount.get(key)
	if (!bucket && create) {
		bucket = new Map()
		echoesByAccount.set(key, bucket)
	}

	return bucket
}

const freshEntry = (entry: EchoEntry | undefined, now: number): EchoEntry | undefined =>
	entry && now - entry.storedAt <= ENTRY_TTL_MS ? entry : undefined

export const rememberMessageEcho = (
	accountId: string | null | undefined,
	id: string | null | undefined,
	echo: MessageEcho
): void => {
	if (!id) return
	const bucket = bucketFor(accountId, true)!
	// Re-decrypted delivery refreshes the entry and its eviction position.
	bucket.delete(id)
	if (bucket.size >= MAX_ENTRIES_PER_ACCOUNT) {
		const oldest = bucket.keys().next()
		if (!oldest.done) {
			bucket.delete(oldest.value)
		}
	}

	bucket.set(id, { echo, storedAt: Date.now() })
}

export const getMessageEcho = (
	accountId: string | null | undefined,
	id: string | null | undefined
): MessageEcho | undefined => {
	if (!id) return undefined
	const bucket = bucketFor(accountId, false)
	if (!bucket) return undefined
	const entry = bucket.get(id)
	if (!freshEntry(entry, Date.now())) {
		if (entry) {
			bucket.delete(id)
		}

		return undefined
	}

	return entry!.echo
}

/** Peek-and-drop: the read-family receipt spends the echo it consumes. */
export const takeMessageEcho = (
	accountId: string | null | undefined,
	id: string | null | undefined
): MessageEcho | undefined => {
	const echo = getMessageEcho(accountId, id)
	if (id) {
		bucketFor(accountId, false)?.delete(id)
	}

	return echo
}

/** Test hook — clears the process cache. */
export const clearMessageEchoCache = (): void => {
	echoesByAccount.clear()
}
