import { randomBytes } from 'crypto'
import type { ILogger } from './logger'

/**
 * Engine-side NCT salt fallbacks, not app behavior. The app creates the salt
 * only on the primary (`NctSaltProvider`, `X/C69453Aa.java`) and shares it with
 * companions over end-to-end encrypted channels (initial history bootstrap and
 * a SET `nct_salt_sync` mutation, re-pushed at most every 26897 seconds); a
 * companion never creates one and sends `<cstoken>` only when a salt arrived.
 *
 * When no push ever arrives — a fresh pairing whose primary cannot deliver —
 * mint one locally so this companion still signs `<cstoken>`. The mint is never
 * published: the server refuses companion-written `nct_salt_sync` (the salt is
 * created on the primary only, prop 24915 — companion uploads come back
 * `internal-server-error`), so the write would be an off-protocol mutation and
 * the fallback's only server-visible activity. A local salt is strictly
 * interim: the real one overwrites it whenever it arrives. Mint only on
 * authoritative absence — never after a failed read, which cannot be told
 * apart from a real salt that simply could not be read.
 */
export type NctSaltFallbackContext = {
	/** The salt currently in creds, if any. */
	getSalt: () => Uint8Array | undefined
	/** end() started: never touch the key store or the socket again. */
	isEnding: () => boolean
	/**
	 * `config.nctSaltFallback === 'mint'` (opt-in; default off). Gates only the
	 * engine-side mint: the `regular_high` snapshot read always runs, because
	 * recovering the primary's real salt is app behavior, not a fallback.
	 */
	enabled: boolean
	/**
	 * The app-state key share arrived (`creds.myAppStateKeyId` is set). The
	 * fallback chain is meaningless without it: a snapshot cannot be decoded
	 * (a salt sitting in the response would read as absent). Both delivery
	 * windows of the primary have to be exhausted *and* readable before the
	 * engine may conclude the primary did not deliver.
	 */
	hasAppStateKey: () => boolean
	/**
	 * Whether the salt in creds was minted by this fallback (`'local'`) instead
	 * of delivered by the primary. A genuine salt always wins over a local one;
	 * the local one is a stopgap until delivery.
	 */
	isLocalSalt: () => boolean
	/** Records a minted salt in creds (`creds.update`). */
	store: (salt: Uint8Array) => void
	logger: Pick<ILogger, 'info' | 'warn'>
}

/**
 * Mint a local account NCT salt. Returns true when the account has a usable
 * salt afterwards (already had one, or the mint was stored). The salt is never
 * published: the server refuses companion-written `nct_salt_sync` (the salt is
 * created on the primary only, prop 24915 — companion uploads come back
 * `internal-server-error`), so the write would be an off-protocol mutation and
 * the fallback's only server-visible activity. What the local salt buys is
 * `<cstoken>` presence on sends from this companion until a real salt arrives
 * and takes over.
 */
const runMint = async (ctx: NctSaltFallbackContext, reason: string): Promise<boolean> => {
	if (ctx.getSalt()?.length) return true
	if (!ctx.enabled || ctx.isEnding()) return false
	// Mint only once the app-state key is present: without it no snapshot read
	// could have concluded absence, and a minted salt short-circuits the chain
	// (its entry sees a salt), so the real one would never be looked for again.
	// Better to leave the mint pending for the key-arrival trigger than to
	// mask the primary's delivery.
	if (!ctx.hasAppStateKey()) return false

	const salt = randomBytes(32)
	if (ctx.isEnding()) return false
	// A real salt can land between the entry check and here (the chain reads
	// snapshots asynchronously). The re-check and the store share one
	// synchronous block, so nothing slips in between: the real salt is kept,
	// never overwritten by the minted one.
	if (ctx.getSalt()?.length) {
		ctx.logger.info({ reason }, 'NCT salt mint superseded by a real salt')
		return true
	}

	ctx.store(salt)
	ctx.logger.warn({ reason }, 'NCT salt minted locally (engine fallback, not app behavior)')
	return true
}

const mintInFlight = new WeakMap<NctSaltFallbackContext, Promise<boolean>>()

/** Mint with dedupe: concurrent calls on the same context share one in-flight mint. */
export const mintNctSalt = (ctx: NctSaltFallbackContext, reason: string): Promise<boolean> => {
	const running = mintInFlight.get(ctx)
	if (running) return running

	const started = runMint(ctx, reason).finally(() => mintInFlight.delete(ctx))
	mintInFlight.set(ctx, started)
	return started
}

export type NctSaltBackfillContext = NctSaltFallbackContext & {
	/** A snapshot read already completed (there is nothing left to read). */
	isBackfilled: () => boolean
	/** Records the read completion, with the salt found when there was one. */
	markBackfilled: (salt: Uint8Array | undefined) => void
	/**
	 * Reads the salt from a `regular_high` snapshot (without persisting that
	 * snapshot or emitting any of its other mutations). Throws when the read
	 * fails, e.g. on a momentary drop.
	 */
	readSnapshotSalt: () => Promise<Uint8Array | undefined>
}

/**
 * The read-then-mint fallback chain: read the salt once from a snapshot; when
 * the read completes and there is no salt in it (the account genuinely has
 * none), fall through to mintNctSalt instead of leaving the account bare. A
 * failed read never reaches the mint — it is logged and left for the next
 * connection to retry — because a failure cannot be told apart from a real
 * salt that just could not be read.
 */
const runBackfill = async (ctx: NctSaltBackfillContext): Promise<void> => {
	// The snapshot read is app behavior and always runs — it is how a companion
	// recovers the primary's real salt from `regular_high`. Only the engine-side
	// mint honors `enabled` (runMint gates it), per the opt-in contract.
	if (ctx.getSalt()?.length) return
	// Background work: once end() starts, stop before touching the key store
	// or the socket again, so teardown never waits on it.
	if (ctx.isEnding()) return
	// Both delivery windows of the primary must be readable before absence
	// means anything: the history bootstrap has been processed (the caller's
	// trigger points), and the app-state key is present so the snapshot
	// decodes. On a fresh pairing the key share can arrive tens of
	// milliseconds after the initial sync ends — concluding absence before it
	// would misread an undecodable snapshot as empty and mint blind. Nothing
	// is marked or minted here; the key-arrival trigger re-runs this chain.
	if (!ctx.hasAppStateKey()) {
		ctx.logger.info({}, 'NCT salt backfill deferred: app state key not present yet')
		return
	}

	// A read already completed without a salt: reading the snapshot again
	// cannot conjure one, only minting can.
	if (ctx.isBackfilled()) {
		await mintNctSalt(ctx, 'read-exhausted')
		return
	}

	try {
		const salt = await ctx.readSnapshotSalt()
		if (ctx.isEnding()) return

		// Provenance decides who wins: a genuine salt that landed while the
		// read was in flight (a live mutation) is kept — it is the primary's
		// delivery, at least as new as the snapshot. A locally-minted one,
		// though, must yield to the snapshot's real salt: the mint is a
		// stopgap, the read is the actual delivery.
		const currentIsGenuine = !!ctx.getSalt()?.length && !ctx.isLocalSalt()
		ctx.markBackfilled(currentIsGenuine ? undefined : salt)
		ctx.logger.info({ found: !!salt }, 'NCT salt backfill finished')
		if (!salt) await mintNctSalt(ctx, 'not-in-snapshot')
	} catch (error) {
		if (ctx.isEnding()) return
		// A failed read says nothing about the account: a real salt may exist
		// and simply be unreadable right now, and a minted local salt would
		// short-circuit the chain and mask it. Leave the account untouched and
		// retry on the next connection.
		ctx.logger.warn({ err: error }, 'NCT salt backfill read failed; retrying on the next connection')
	}
}

const backfillInFlight = new WeakMap<NctSaltBackfillContext, Promise<void>>()

/** Backfill with dedupe: concurrent triggers on the same context share one run. */
export const backfillNctSalt = async (ctx: NctSaltBackfillContext): Promise<void> => {
	const running = backfillInFlight.get(ctx)
	if (running) return running

	const started = runBackfill(ctx).finally(() => backfillInFlight.delete(ctx))
	backfillInFlight.set(ctx, started)
	return started
}
