/**
 * H4 — `deleteSession` / `migrateSession` use synthetic transaction keys.
 *
 * Per-JID encrypt/decrypt transactions key on `jid`. Bulk delete and migrate
 * paths key on synthetic strings (`delete-${count}-sessions`,
 * `migrate-${count}-sessions-${user}`) that do NOT overlap with the per-JID
 * keyspace. As a result a session can be mid-encrypt for `jid:foo` while
 * `deleteSession(['foo'])` simultaneously writes `session.foo = null`.
 *
 * Desired behavior: any transaction that mutates `session.${addr}` serializes
 * with any other transaction (encrypt, decrypt, delete, migrate) that touches
 * the same `session.${addr}` record — regardless of how the caller "named" the
 * transaction.
 *
 * Failing while H4 is unresolved. Flipped to `it(...)` in Stages 2-3.
 */
import type { SignalDataSet, SignalKeyStore } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth-utils'
import type { ILogger } from '../../Utils/logger'

const silentLogger = (): ILogger =>
	({
		level: 'silent',
		child: () => silentLogger(),
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {}
	}) as unknown as ILogger

const makeStore = (): SignalKeyStore => {
	const data: Record<string, Record<string, unknown>> = {}
	return {
		async get(type, ids) {
			const bucket = data[type] ?? {}
			const out: Record<string, any> = {}
			for (const id of ids) {
				if (id in bucket) out[id] = bucket[id]
			}

			return out
		},
		async set(d: SignalDataSet) {
			for (const type in d) {
				data[type] = data[type] ?? {}
				const incoming = (d as any)[type] as Record<string, unknown>
				for (const id in incoming) {
					const v = incoming[id]
					if (v === null) delete data[type][id]
					else data[type][id] = v
				}
			}
		}
	}
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe('libsignal — bulk session delete/migrate vs per-JID encrypt (H4)', () => {
	// NOTE: H4 fix shipped via Stage 2 (upstream #2572) — see `libsignal.ts:777`.
	// These two suites exercise a local `addTransactionCapability` mock with
	// synthetic addresses, NOT the real `transactWith({ records })` path used
	// in production. They were intended to flip from `it.failing` to `it` once
	// the fix landed, but they can't observe the production lock semantics
	// (per-record `transactWith` vs the namespace-keyed `transaction` here),
	// so they'd keep "failing as expected" forever and signal a phantom open
	// issue. Demoting to `it.skip` until somebody rewrites them against the
	// real `parsedKeys.transactWith({ records: [{type:'session', id}] })`
	// path. Same pattern as the H8/H9 skips. (audit TST-07)
	it.skip('deleteSession serializes against an in-flight encrypt for the same address (placeholder)', async () => {
		const keys = addTransactionCapability(makeStore(), silentLogger(), {
			maxCommitRetries: 1,
			delayBetweenTriesMs: 1
		})

		const addr = '12025550100.0' // signal protocol address string

		let encryptActive = false
		let deleteSawEncryptActive = false

		// Encrypt-shaped tx: keyed by per-recipient address.
		const encrypt = keys.transaction(async () => {
			encryptActive = true
			await delay(30)
			encryptActive = false
		}, addr)

		// Delete-shaped tx: keyed by synthetic `delete-1-sessions`.
		const deleteAll = (async () => {
			await delay(5)
			await keys.transaction(async () => {
				if (encryptActive) deleteSawEncryptActive = true
				await keys.set({ session: { [addr]: null } })
			}, `delete-1-sessions`)
		})()

		await Promise.all([encrypt, deleteAll])

		expect(deleteSawEncryptActive).toBe(false)
	})

	it.skip('migrateSession serializes against in-flight encrypts for any of the migrated addresses (placeholder)', async () => {
		const keys = addTransactionCapability(makeStore(), silentLogger(), {
			maxCommitRetries: 1,
			delayBetweenTriesMs: 1
		})

		const pnAddr = '12025550100.0'
		const lidAddr = '12025550100_1.0'
		const user = '12025550100'

		let encryptForPnActive = false
		let migrationSawEncrypt = false

		const encrypt = keys.transaction(async () => {
			encryptForPnActive = true
			await delay(30)
			encryptForPnActive = false
		}, pnAddr)

		const migrate = (async () => {
			await delay(5)
			await keys.transaction(async () => {
				if (encryptForPnActive) migrationSawEncrypt = true
				await keys.set({
					session: { [pnAddr]: null, [lidAddr]: Buffer.from([0x01]) as any }
				})
			}, `migrate-1-sessions-${user}`)
		})()

		await Promise.all([encrypt, migrate])

		expect(migrationSawEncrypt).toBe(false)
	})
})
