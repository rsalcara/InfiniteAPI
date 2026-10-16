import { jest } from '@jest/globals'
import type { ILogger } from '../../Utils/logger'
import { backfillNctSalt, mintNctSalt, type NctSaltBackfillContext } from '../../Utils/nct-salt-fallback'

const existingSalt = Buffer.alloc(32, 3)

type CtxOptions = {
	salt?: Uint8Array
	ending?: boolean
	enabled?: boolean
	appStateKey?: boolean
	backfilled?: boolean
	localSalt?: boolean
	read?: () => Promise<Uint8Array | undefined>
}

const makeCtx = (options: CtxOptions = {}) => {
	const events: string[] = []
	const stores: Uint8Array[] = []
	const marks: Array<Uint8Array | undefined> = []
	const reads: number[] = []
	let current = options.salt
	let ending = !!options.ending
	const info = jest.fn()
	const warn = jest.fn()

	const ctx: NctSaltBackfillContext = {
		getSalt: () => current,
		isEnding: () => ending,
		enabled: options.enabled ?? true,
		hasAppStateKey: () => options.appStateKey ?? true,
		isLocalSalt: () => options.localSalt ?? false,
		store: salt => {
			events.push('store')
			stores.push(salt)
			current = salt
		},
		logger: { info, warn } as unknown as Pick<ILogger, 'info' | 'warn'>,
		isBackfilled: () => !!options.backfilled,
		markBackfilled: salt => {
			events.push('mark')
			marks.push(salt)
			if (salt) current = salt
		},
		readSnapshotSalt: async () => {
			reads.push(1)
			return (options.read ?? (() => Promise.resolve(undefined)))()
		}
	}

	return {
		ctx,
		events,
		stores,
		marks,
		reads,
		info,
		warn,
		setEnding: (value: boolean) => {
			ending = value
		},
		setSalt: (salt: Uint8Array) => {
			current = salt
		}
	}
}

describe('mintNctSalt (local-only engine fallback)', () => {
	it('stores the minted salt locally and never publishes a mutation', async () => {
		const harness = makeCtx()
		await expect(mintNctSalt(harness.ctx, 'initial-sync-no-salt')).resolves.toBe(true)

		// Local only: the server refuses companion-written `nct_salt_sync`
		// (the salt is created on the primary only), so publishing would be an
		// off-protocol write landing as an error. The salt just provisions
		// `<cstoken>` on sends from this companion until a real one arrives.
		expect(harness.events).toEqual(['store'])
		expect(harness.stores[0]).toHaveLength(32)
		expect(harness.warn.mock.calls[0]?.[0]).toEqual({ reason: 'initial-sync-no-salt' })
	})

	it('keeps an existing salt and stores nothing', async () => {
		const harness = makeCtx({ salt: existingSalt })
		await expect(mintNctSalt(harness.ctx, 'not-in-snapshot')).resolves.toBe(true)
		expect(harness.events).toEqual([])
	})

	it('does nothing when the fallback is off', async () => {
		const harness = makeCtx({ enabled: false })
		await expect(mintNctSalt(harness.ctx, 'initial-sync-no-salt')).resolves.toBe(false)
		expect(harness.events).toEqual([])
	})

	it('does nothing once teardown has started', async () => {
		const harness = makeCtx({ ending: true })
		await expect(mintNctSalt(harness.ctx, 'read-exhausted')).resolves.toBe(false)
		expect(harness.events).toEqual([])
	})

	it('does nothing until the app-state key arrives: before it no read could have ruled out a real salt', async () => {
		const harness = makeCtx({ appStateKey: false })
		await expect(mintNctSalt(harness.ctx, 'not-in-snapshot')).resolves.toBe(false)
		// The key share usually lands milliseconds later; the key-arrival
		// trigger then retries. Minting blind would short-circuit the chain
		// and mask the primary's delivery.
		expect(harness.events).toEqual([])
	})

	it('never overwrites a real salt that landed before the store', async () => {
		const real = Buffer.alloc(32, 7)
		const harness = makeCtx()
		let probes = 0
		const ctx = {
			...harness.ctx,
			// The entry probe sees no salt; the re-check right before the store
			// sees the real one that landed in between.
			getSalt: () => (probes++ === 0 ? undefined : real)
		}
		await expect(mintNctSalt(ctx, 'read-exhausted')).resolves.toBe(true)

		// The re-check caught the real salt: nothing was stored over it.
		expect(harness.events).toEqual([])
		expect(harness.stores).toEqual([])
		expect(harness.info).toHaveBeenCalledWith({ reason: 'read-exhausted' }, 'NCT salt mint superseded by a real salt')
	})

	it('shares one in-flight mint between concurrent calls', async () => {
		const harness = makeCtx()
		const first = mintNctSalt(harness.ctx, 'initial-sync-no-salt')
		const second = mintNctSalt(harness.ctx, 'not-in-snapshot')

		await expect(first).resolves.toBe(true)
		await expect(second).resolves.toBe(true)
		expect(harness.events).toEqual(['store'])
	})
})

describe('backfillNctSalt (read-then-mint chain)', () => {
	it('reads the snapshot even when the fallback mint is off', async () => {
		const harness = makeCtx({ read: async () => existingSalt, enabled: false })
		await backfillNctSalt(harness.ctx)

		// The parameter gates only the engine-side mint. Recovering the
		// primary's real salt from `regular_high` is app behavior and runs
		// regardless — silencing the read would leave the companion without a
		// salt even when the primary delivered one.
		expect(harness.reads).toEqual([1])
		expect(harness.events).toEqual(['mark'])
		expect(Buffer.from(harness.marks[0]!).equals(existingSalt)).toBe(true)
	})

	it('never mints when the fallback is off, even on authoritative absence', async () => {
		const harness = makeCtx({ read: async () => undefined, enabled: false })
		await backfillNctSalt(harness.ctx)

		// The read completed and the account genuinely has no salt. The opt-in
		// only decides whether the engine may mint one; without it the account
		// stays bare (app parity) and nothing is stored or warned about.
		expect(harness.reads).toEqual([1])
		expect(harness.events).toEqual(['mark'])
		expect(harness.stores).toEqual([])
		expect(harness.warn).not.toHaveBeenCalled()
	})

	it('defers the whole chain until the app-state key arrives', async () => {
		const harness = makeCtx({ appStateKey: false, read: async () => existingSalt })
		await backfillNctSalt(harness.ctx)

		// Before the key lands, the snapshot cannot decode: an absence
		// concluded here would be an undecodable read dressed up as evidence,
		// and a mint would mask the primary's delivery. Nothing is read,
		// marked or minted — the key-arrival trigger re-runs the chain.
		expect(harness.reads).toEqual([])
		expect(harness.events).toEqual([])
		expect(harness.info).toHaveBeenCalledWith({}, 'NCT salt backfill deferred: app state key not present yet')
	})

	it('stores the salt the snapshot read found, without minting', async () => {
		const harness = makeCtx({ read: async () => existingSalt })
		await backfillNctSalt(harness.ctx)

		expect(harness.events).toEqual(['mark'])
		expect(Buffer.from(harness.marks[0]!).equals(existingSalt)).toBe(true)
		expect(harness.info).toHaveBeenCalledWith({ found: true }, 'NCT salt backfill finished')
	})

	it('mints locally when the snapshot has no salt', async () => {
		const harness = makeCtx({ read: async () => undefined })
		await backfillNctSalt(harness.ctx)

		expect(harness.events).toEqual(['mark', 'store'])
		expect(harness.marks[0]).toBeUndefined()
		expect(harness.warn.mock.calls[0]?.[0]).toEqual({ reason: 'not-in-snapshot' })
	})

	it('never mints on a failed read: a real salt may simply be unreadable', async () => {
		const readError = new Error('connection dropped')
		const harness = makeCtx({ read: async () => Promise.reject(readError) })
		await backfillNctSalt(harness.ctx)

		expect(harness.events).toEqual([])
		expect(harness.warn).toHaveBeenCalledWith(
			{ err: readError },
			'NCT salt backfill read failed; retrying on the next connection'
		)
	})

	it('a failed read leaves the read pending so the next connection retries it', async () => {
		const harness = makeCtx({ read: async () => Promise.reject(new Error('connection dropped')) })
		await backfillNctSalt(harness.ctx)
		await backfillNctSalt(harness.ctx)

		// Not marked backfilled: both calls attempted the read and neither
		// fell through to the mint.
		expect(harness.reads).toEqual([1, 1])
		expect(harness.marks).toEqual([])
		expect(harness.events).toEqual([])
	})

	it('skips the read and mints when a previous read already completed', async () => {
		const harness = makeCtx({ backfilled: true, read: async () => existingSalt })
		await backfillNctSalt(harness.ctx)

		expect(harness.reads).toEqual([])
		expect(harness.events).toEqual(['store'])
		expect(harness.warn.mock.calls[0]?.[0]).toEqual({ reason: 'read-exhausted' })
	})

	it('does not overwrite a genuine salt that arrived while the read was in flight', async () => {
		const concurrent = Buffer.alloc(32, 9)
		const harness = makeCtx({
			read: async () => {
				// A live mutation stored the real salt mid-read.
				harness.setSalt(concurrent)
				return existingSalt
			}
		})
		await backfillNctSalt(harness.ctx)

		// The snapshot's salt must not win: the genuine one that landed mid-read
		// is at least as new as the snapshot.
		expect(harness.events).toEqual(['mark'])
		expect(harness.marks[0]).toBeUndefined()
	})

	it('yields to the snapshot real salt when the mid-read salt was a local mint', async () => {
		const local = Buffer.alloc(32, 9)
		const harness = makeCtx({
			localSalt: true,
			read: async () => {
				// A concurrent local mint stored its salt mid-read.
				harness.setSalt(local)
				return existingSalt
			}
		})
		await backfillNctSalt(harness.ctx)

		// The read is the primary's actual delivery: it replaces the stopgap.
		expect(harness.events).toEqual(['mark'])
		expect(Buffer.from(harness.marks[0]!).equals(existingSalt)).toBe(true)
	})

	it('does not mint again when a concurrent mint landed during an empty read', async () => {
		const concurrent = Buffer.alloc(32, 9)
		const harness = makeCtx({
			read: async () => {
				harness.setSalt(concurrent)
				return undefined
			}
		})
		await backfillNctSalt(harness.ctx)

		// The mint guard sees the concurrent salt and short-circuits.
		expect(harness.events).toEqual(['mark'])
		expect(harness.stores).toEqual([])
	})

	it('touches nothing when a salt is already present', async () => {
		const harness = makeCtx({ salt: existingSalt, read: async () => existingSalt })
		await backfillNctSalt(harness.ctx)
		expect(harness.events).toEqual([])
		expect(harness.reads).toEqual([])
	})

	it('marks and mints nothing when teardown starts during the read', async () => {
		const harness = makeCtx({
			read: async () => {
				harness.setEnding(true)
				return undefined
			}
		})
		await backfillNctSalt(harness.ctx)
		expect(harness.events).toEqual([])
	})

	it('shares one snapshot read between concurrent triggers', async () => {
		let releaseRead: (value: Uint8Array | undefined) => void = () => undefined
		const gate = new Promise<Uint8Array | undefined>(resolve => {
			releaseRead = resolve
		})
		const harness = makeCtx({ read: () => gate })

		// Two triggers race on the same context — the history-bootstrap end and
		// the app-state key arrival can land within milliseconds of each other.
		const first = backfillNctSalt(harness.ctx)
		const second = backfillNctSalt(harness.ctx)
		releaseRead(undefined)
		await Promise.all([first, second])

		// The second trigger joined the in-flight run: one read, one mint.
		expect(harness.reads).toEqual([1])
		expect(harness.events).toEqual(['mark', 'store'])
	})
})
