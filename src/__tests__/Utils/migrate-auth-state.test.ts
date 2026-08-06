/**
 * Stage 5 — `migrateAuthState` round-trip test.
 *
 * Source = on-disk `useMultiFileAuthState`. Destination = in-memory
 * `useSqliteAuthState`. Verifies that creds + a representative slice of
 * signal records (pre-key + session + identity-key) round-trip without loss
 * and that a re-run is idempotent (skipExisting).
 *
 * Adapted from upstream WhiskeySockets/Baileys #2575 (Stage 5).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import type { HistorySyncJobInput } from '../../Types'
import { migrateAuthState } from '../../Utils/migrate-auth-state'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const historyJob = (messageId: string, chunkOrder: number): HistorySyncJobInput => ({
	messageId,
	sourceMessageId: messageId,
	messageKey: { id: messageId, remoteJid: '5511999999999@s.whatsapp.net', fromMe: true },
	messageTimestamp: 123,
	notification: proto.Message.HistorySyncNotification.encode({
		syncType: proto.HistorySync.HistorySyncType.RECENT,
		chunkOrder,
		progress: 100
	}).finish(),
	syncType: proto.HistorySync.HistorySyncType.RECENT,
	chunkOrder,
	progress: 100
})

describe('migrateAuthState — multi-file → SQLite', () => {
	let dir: string
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'baileys-migrate-'))
	})
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('copies creds and every signal record type (including app-state-sync-key)', async () => {
		const src = await useMultiFileAuthState(dir)
		src.state.creds.advSecretKey = 'migrate-test-secret'
		await src.saveCreds()

		// `app-state-sync-key` is the type that exercises the
		// `proto.Message.AppStateSyncKeyData.fromObject` codec on read, so
		// migrating it round-trips the protobuf-special-cased path — not
		// just plain Buffer/object values like the other types.

		await src.state.keys.set({
			'pre-key': {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'1': { public: Buffer.from([0x11]), private: Buffer.from([0x12]) } as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'2': { public: Buffer.from([0x21]), private: Buffer.from([0x22]) } as any
			},
			session: {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'peer-a@s.whatsapp.net': Buffer.from([0xa1]) as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'peer-b@s.whatsapp.net': Buffer.from([0xa2]) as any
			},
			'identity-key': {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'peer-a@s.whatsapp.net': Buffer.from([0xb1]) as any
			},
			'app-state-sync-key': {
				'key-id-1': {
					keyData: Buffer.from([0xc1, 0xc2, 0xc3]),
					fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
					timestamp: '1700000000'
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				} as any
			},
			'tctoken-job': {
				'5511999999999@s.whatsapp.net': {
					canonicalJid: '5511999999999@s.whatsapp.net',
					requestedJid: '5511999999999@s.whatsapp.net',
					aliases: ['5511999999999@s.whatsapp.net'],
					issueTimestamp: 1_700_000_000,
					state: 'retry',
					attemptCount: 2,
					nextRetryAt: 1_700_001_000_000,
					leaseUntil: 0,
					timeoutMs: 32_000,
					createdAt: 1_700_000_000_000,
					updatedAt: 1_700_000_001_000
				}
			}
		})

		const dst = await useSqliteAuthState({ dbPath: ':memory:' })

		const result = await migrateAuthState({ from: src.state, to: dst.state, verify: true })

		expect(result.creds.copied).toBe(true)
		expect(result.counts['pre-key']).toBe(2)
		expect(result.counts['session']).toBe(2)
		expect(result.counts['identity-key']).toBe(1)
		expect(result.counts['app-state-sync-key']).toBe(1)
		expect(result.counts['tctoken-job']).toBe(1)
		expect(result.verified).toBe(true)
		expect(result.warnings).toEqual([])

		// Sample-check destination contents.
		expect(dst.state.creds.advSecretKey).toBe('migrate-test-secret')
		const sessions = await dst.state.keys.get('session', ['peer-a@s.whatsapp.net', 'peer-b@s.whatsapp.net'])
		expect(Buffer.from(sessions['peer-a@s.whatsapp.net'] as Uint8Array)).toEqual(Buffer.from([0xa1]))
		expect(Buffer.from(sessions['peer-b@s.whatsapp.net'] as Uint8Array)).toEqual(Buffer.from([0xa2]))

		const preKeys = await dst.state.keys.get('pre-key', ['1', '2'])
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(Buffer.from((preKeys['1'] as any).public)).toEqual(Buffer.from([0x11]))
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(Buffer.from((preKeys['2'] as any).public)).toEqual(Buffer.from([0x21]))

		const appStateKeys = await dst.state.keys.get('app-state-sync-key', ['key-id-1'])
		expect(appStateKeys['key-id-1']).toBeDefined()
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(Buffer.from((appStateKeys['key-id-1'] as any).keyData)).toEqual(Buffer.from([0xc1, 0xc2, 0xc3]))
		expect(
			(await dst.state.keys.get('tctoken-job', ['5511999999999@s.whatsapp.net']))['5511999999999@s.whatsapp.net']
		).toEqual(expect.objectContaining({ state: 'retry', attemptCount: 2 }))

		dst.close()
	})

	it('is idempotent: re-running after a partial migration completes cleanly', async () => {
		const src = await useMultiFileAuthState(dir)
		src.state.creds.advSecretKey = 'idempotent-test'
		await src.saveCreds()

		await src.state.keys.set({
			session: {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'peer-a@s.whatsapp.net': Buffer.from([0x01]) as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'peer-b@s.whatsapp.net': Buffer.from([0x02]) as any,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'peer-c@s.whatsapp.net': Buffer.from([0x03]) as any
			}
		})

		const dst = await useSqliteAuthState({ dbPath: ':memory:' })

		// First migration.
		const first = await migrateAuthState({ from: src.state, to: dst.state })
		expect(first.counts['session']).toBe(3)

		// Add one more record to source, re-run migration. The two already-
		// migrated records should be skipped; only the new one is copied.
		await src.state.keys.set({
			session: {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				'peer-d@s.whatsapp.net': Buffer.from([0x04]) as any
			}
		})

		const second = await migrateAuthState({ from: src.state, to: dst.state })
		expect(second.counts['session']).toBe(1)
		expect(second.verified).toBe(true)

		// All 4 records observable on the destination.
		const all = await dst.state.keys.get('session', [
			'peer-a@s.whatsapp.net',
			'peer-b@s.whatsapp.net',
			'peer-c@s.whatsapp.net',
			'peer-d@s.whatsapp.net'
		])
		expect(Object.keys(all).sort()).toEqual([
			'peer-a@s.whatsapp.net',
			'peer-b@s.whatsapp.net',
			'peer-c@s.whatsapp.net',
			'peer-d@s.whatsapp.net'
		])

		dst.close()
	})

	it('copies pending jobs, checkpoints, post-commit markers, and compatibility metadata', async () => {
		const src = await useMultiFileAuthState(dir)
		const sourceHistory = src.state.historySync!
		await sourceHistory.enqueue(historyJob('MIGRATED-COMMIT', 3))
		await sourceHistory.claimNext(Date.now(), 1_000, {
			initialComplete: true,
			recentComplete: true,
			allowMissingCheckpoint: true
		})
		await sourceHistory.commit('MIGRATED-COMMIT', {
			phase: 'RECENT',
			syncType: proto.HistorySync.HistorySyncType.RECENT,
			chunkOrder: 3,
			progress: 100,
			messageId: 'MIGRATED-COMMIT',
			updatedAt: 100
		})
		await sourceHistory.markPostCommitCompleted('MIGRATED-COMMIT', 200)
		await sourceHistory.enqueue(historyJob('MIGRATED-PENDING', 4))

		const dst = await useSqliteAuthState({ dbPath: ':memory:' })
		const result = await migrateAuthState({ from: src.state, to: dst.state, verify: true })
		const snapshot = await dst.state.historySync!.exportState()

		expect(result.historySync).toEqual({ jobs: 2, checkpoints: 1, copied: true })
		expect(snapshot.compatibilityBaselineConsumed).toBe(true)
		expect(snapshot.checkpoints).toEqual([
			expect.objectContaining({ phase: 'RECENT', chunkOrder: 3, messageId: 'MIGRATED-COMMIT' })
		])
		expect(await dst.state.historySync!.get('MIGRATED-COMMIT')).toMatchObject({
			state: 'committed',
			postCommitCompletedAt: 200
		})
		expect(await dst.state.historySync!.get('MIGRATED-PENDING')).toMatchObject({ state: 'received' })

		const repeated = await migrateAuthState({ from: src.state, to: dst.state, verify: true })
		expect(repeated.historySync).toEqual({ jobs: 0, checkpoints: 0, copied: false })
		expect(repeated.verified).toBe(true)
		expect(repeated.warnings).toEqual([])
		dst.close()
	})

	it('fails verification when a destination does not retain imported history jobs', async () => {
		const src = await useMultiFileAuthState(dir)
		await src.state.historySync!.enqueue(historyJob('MISSING-AFTER-IMPORT', 1))
		const dst = await useSqliteAuthState({ dbPath: ':memory:' })
		dst.state.historySync!.importState = async () => ({
			jobs: 0,
			checkpoints: 0,
			compatibilityBaselineUpdated: false
		})

		const result = await migrateAuthState({ from: src.state, to: dst.state, verify: true })

		expect(result.verified).toBe(false)
		expect(result.warnings).toContain('destination missing history sync job:MISSING-AFTER-IMPORT')
		dst.close()
	})

	it('throws when the source store does not implement list()', async () => {
		const noListSrc = {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			creds: { advSecretKey: 'x' } as any,
			keys: {
				get: async () => ({}),
				set: async () => {}
			}
		}
		const dst = await useSqliteAuthState({ dbPath: ':memory:' })
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await expect(migrateAuthState({ from: noListSrc as any, to: dst.state })).rejects.toThrow(/list\(type\)/)
		dst.close()
	})
})
