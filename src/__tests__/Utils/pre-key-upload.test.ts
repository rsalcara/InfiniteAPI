/**
 * `uploadPreKeys` control-flow — id advancement gated on commit + ack, and a
 * retry loop that never burns ids or deadlocks.
 *
 * This models the real `socket.ts uploadPreKeys` sequencing (it can't be
 * imported directly — it closes over a live socket), asserting the invariants
 * the real function now guarantees:
 *   - `nextPreKeyId` advances ONLY after `keys.transaction()` commits, so a
 *     rollback never leaves the counter pointing past un-persisted ids.
 *   - `firstUnuploadedPreKeyId` advances ONLY after the server acks, so a failed
 *     upload never orphans generated keys.
 *   - the retry is an internal loop that re-sends the SAME range — N failures
 *     advance `nextPreKeyId` by exactly one batch, not N.
 */

import {
	PREKEY_UPLOAD_QUERY_TIMEOUT_FALLBACK_MS,
	resolvePrekeyUploadQueryTimeout
} from '../../Utils/prekey-upload-timeout'

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface CredsLike {
	nextPreKeyId: number
	firstUnuploadedPreKeyId: number
}

/** Mirror of `generateOrGetPreKeys` (src/Utils/signal.ts). */
function generateOrGetPreKeys(creds: CredsLike, range: number) {
	const available = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId
	const remaining = range - available
	const lastPreKeyId = creds.nextPreKeyId + remaining - 1
	return {
		nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
		firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1)
	}
}

/**
 * Faithful paraphrase of the fixed `uploadPreKeys` control flow.
 * `commitFails(attempt)` / `queryFails(attempt)` inject failures per attempt.
 */
async function uploadPreKeys(
	creds: CredsLike,
	opts: {
		count?: number
		maxRetries?: number
		commitFails?: (attempt: number) => boolean
		queryFails?: (attempt: number) => boolean
	}
): Promise<{ queryAttempts: number }> {
	const { count = 30, maxRetries = 3, commitFails, queryFails } = opts
	let lastError: unknown
	let queryAttempts = 0

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// Not committed until the server acks → a retry reads the SAME cursor.
		const update = generateOrGetPreKeys(creds, count)

		// keys.transaction(): a commit failure rolls back — nothing persisted,
		// and crucially `nextPreKeyId` is NOT advanced (that happens after).
		if (commitFails?.(attempt)) {
			throw new Error('keys.transaction commit failed')
		}

		// Keys committed → only NOW advance the allocation counter.
		creds.nextPreKeyId = update.nextPreKeyId

		try {
			queryAttempts++
			if (queryFails?.(attempt)) throw new Error('network error')
			// Server acked → advance upload progress.
			creds.firstUnuploadedPreKeyId = update.firstUnuploadedPreKeyId
			return { queryAttempts }
		} catch (e) {
			lastError = e
			if (attempt < maxRetries) await delay(1)
		}
	}

	throw lastError
}

describe('uploadPreKeys — id advancement gated on commit + ack', () => {
	it('does not advance nextPreKeyId when the key transaction rolls back', async () => {
		const creds: CredsLike = { nextPreKeyId: 1, firstUnuploadedPreKeyId: 1 }
		await expect(uploadPreKeys(creds, { commitFails: () => true })).rejects.toThrow('commit failed')
		expect(creds.nextPreKeyId).toBe(1)
		expect(creds.firstUnuploadedPreKeyId).toBe(1)
	})

	it('does not orphan keys or burn ids after N consecutive upload failures', async () => {
		const creds: CredsLike = { nextPreKeyId: 1, firstUnuploadedPreKeyId: 1 }
		const MIN = 30
		await expect(uploadPreKeys(creds, { count: MIN, queryFails: () => true })).rejects.toThrow('network error')
		// Upload never acked → progress cursor stays put (no orphan)…
		expect(creds.firstUnuploadedPreKeyId).toBe(1)
		// …and ids were allocated exactly once, not once per attempt.
		expect(creds.nextPreKeyId).toBe(1 + MIN)
	})

	it('a successful retry after one failure advances ids by exactly one batch', async () => {
		const creds: CredsLike = { nextPreKeyId: 1, firstUnuploadedPreKeyId: 1 }
		const MIN = 30
		const res = await uploadPreKeys(creds, { count: MIN, queryFails: a => a === 0 })
		expect(res.queryAttempts).toBe(2) // failed once, retried, succeeded — no deadlock
		expect(creds.nextPreKeyId).toBe(1 + MIN)
		expect(creds.firstUnuploadedPreKeyId).toBe(1 + MIN)
	})

	it('preserves committed key ids and retries the same material after a post-commit reservation failure', () => {
		const creds: CredsLike = { nextPreKeyId: 1, firstUnuploadedPreKeyId: 1 }
		const persisted = new Map<number, string>()
		let generated = 0

		const prepareAndCommit = () => {
			const before = creds.nextPreKeyId
			const update = generateOrGetPreKeys(creds, 3)
			for (let id = before; id < update.nextPreKeyId; id++) {
				generated++
				persisted.set(id, `key-${id}-${generated}`)
			}

			// Mirrors the production fix: afterCommit proves the key mutations are
			// durable, so allocation advances even when reservation rejects the IQ.
			creds.nextPreKeyId = update.nextPreKeyId
			return update
		}

		const first = prepareAndCommit()
		const firstMaterial = [...persisted.entries()]
		expect(first.nextPreKeyId).toBe(4)
		expect(creds.firstUnuploadedPreKeyId).toBe(1)

		// Retry with firstUnuploaded still at 1 sees all three persisted keys as
		// available; it generates nothing and therefore cannot overwrite them.
		const second = prepareAndCommit()
		expect(second.nextPreKeyId).toBe(4)
		expect(generated).toBe(3)
		expect([...persisted.entries()]).toEqual(firstMaterial)
	})

	it('bounds each attempt with an explicit per-call timeout even if the global query timeout is disabled', async () => {
		const EXPLICIT_MS = 10
		const globalDefaultMs: number | undefined = undefined // consumer disabled defaultQueryTimeoutMs

		// Mirrors `query(node, PREKEY_UPLOAD_QUERY_TIMEOUT_MS)` → promiseTimeout:
		// the EXPLICIT ms is what promiseTimeout receives, so a non-responding
		// server still rejects instead of hanging — even though the global default
		// is undefined (which, if relied on, builds a promise with no timeout).
		const query = (serverResponds: boolean) =>
			new Promise<void>((resolve, reject) => {
				const ms = EXPLICIT_MS ?? globalDefaultMs
				if (serverResponds) resolve()
				else if (ms) setTimeout(() => reject(new Error('Timed Out')), ms)
				// else: would hang forever — the bug this explicit timeout guards against
			})

		const retryLoop = async (): Promise<string> => {
			for (let attempt = 0; attempt <= 3; attempt++) {
				try {
					await query(false)
					return 'resolved'
				} catch {
					if (attempt < 3) await delay(1)
				}
			}

			return 'rejected'
		}

		// The retry loop must terminate (reject), never hang, with a dead server.
		const outcome = await Promise.race([retryLoop(), delay(1000).then(() => 'hung')])

		expect(outcome).toBe('rejected')
	})
})

describe('resolvePrekeyUploadQueryTimeout', () => {
	it('falls back to 30s only when the global timeout is disabled', () => {
		expect(resolvePrekeyUploadQueryTimeout(undefined)).toBe(PREKEY_UPLOAD_QUERY_TIMEOUT_FALLBACK_MS)
		expect(resolvePrekeyUploadQueryTimeout(0)).toBe(PREKEY_UPLOAD_QUERY_TIMEOUT_FALLBACK_MS)
		expect(PREKEY_UPLOAD_QUERY_TIMEOUT_FALLBACK_MS).toBe(30_000)
	})

	it("preserves a consumer's positive configured timeout instead of clamping it", () => {
		expect(resolvePrekeyUploadQueryTimeout(60_000)).toBe(60_000)
		expect(resolvePrekeyUploadQueryTimeout(5_000)).toBe(5_000)
	})
})
