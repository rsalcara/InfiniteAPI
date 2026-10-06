/**
 * Contact Refresh (peer data operation type 14) + CompanionContactAutoHealer.
 *
 * Covers the full companion-side lifecycle:
 *   - request-id generation (golden vector, 1:1 with the app's format)
 *   - the bare type-14 request payload (wire golden)
 *   - ContactRefreshResponse fact extraction
 *   - pending/patch-log store lifecycle (ContactRefreshBackend)
 *   - reconcile (settle only when local syncd state reached the target)
 *   - healOnce gates + local replay repair + the app's heal log line
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import type { BaileysEventEmitter, Contact } from '../../Types'
import { type ContactAutoHealDeps, healOnce } from '../../Utils/companion-contact-auto-healer'
import {
	buildContactRefreshCapabilitySyncAction,
	buildContactRefreshRequest,
	extractContactRefreshReply,
	generateContactRefreshRequestId,
	readContactRefreshCapability,
	reconcileContactRefresh,
	replyFactsForPending
} from '../../Utils/contact-refresh'
import type { ILogger } from '../../Utils/logger'
import {
	AppStateBackend,
	ContactRefreshBackend,
	LAST_CONTACT_AUTO_HEAL_TIMESTAMP_KEY,
	MultiDbSqliteStore
} from '../../Utils/multi-db-sqlite'

const FIXED_NOW = 1_700_000_000_000
const TEST_JID = '5511999999999@s.whatsapp.net'
/**
 * MD5(ts8B BE || jid || 16 zero bytes) with byte 0 stamped 0xAC, upper hex.
 * Format authority: W4B 2.26.36.72 X/C13580ja.java A02/A04 (decompiled APK).
 * The vector below is a deterministic fixture of that formula (injected
 * clock + zero salt), not a capture from a live primary.
 */
const GOLDEN_REQUEST_ID = 'ACC031468689068CC4FAD408218C9EA0'

describe('contact-refresh request id', () => {
	it('matches the app format: MD5(ts BE || jid || random), byte 0 = 0xAC, uppercase hex', () => {
		const zeroRandom = () => Buffer.alloc(16, 0)
		const id = generateContactRefreshRequestId(TEST_JID, FIXED_NOW, zeroRandom)
		expect(id).toBe(GOLDEN_REQUEST_ID)
		expect(id).toHaveLength(32)
		expect(id).toBe(id.toUpperCase())
		const firstByte = Buffer.from(id.slice(0, 2), 'hex')[0]
		expect(firstByte).toBe(0xac)
	})

	it('varies with the random salt and the jid', () => {
		const idA = generateContactRefreshRequestId(TEST_JID, FIXED_NOW, () => Buffer.alloc(16, 0))
		const idB = generateContactRefreshRequestId(TEST_JID, FIXED_NOW, () => Buffer.alloc(16, 1))
		const idC = generateContactRefreshRequestId('5511888888888@s.whatsapp.net', FIXED_NOW, () => Buffer.alloc(16, 0))
		expect(idA).not.toBe(idB)
		expect(idA).not.toBe(idC)
	})
})

describe('contact-refresh request payload', () => {
	it('is the bare type-14 request (wire golden: field 1 varint 14)', () => {
		const payload = buildContactRefreshRequest()
		expect(payload.peerDataOperationRequestType).toBe(
			proto.Message.PeerDataOperationRequestType.CONTACT_REFRESH_REQUEST
		)
		// No payload branch for type 14 — the encoded message is exactly the
		// type field (tag 0x08, value 0x0e), 1:1 with the app's serializer.
		const encoded = proto.Message.PeerDataOperationRequestMessage.encode(payload).finish()
		expect(Buffer.from(encoded)).toEqual(Buffer.from([0x08, 0x0e]))
	})

	it('capability sync action round-trips through readContactRefreshCapability', () => {
		const action = buildContactRefreshCapabilitySyncAction(true)
		expect(readContactRefreshCapability(action)).toBe(true)
		expect(readContactRefreshCapability(buildContactRefreshCapabilitySyncAction(false))).toBe(false)
		expect(readContactRefreshCapability({})).toBeUndefined()
	})
})

describe('contact-refresh reply extraction', () => {
	it('reads facts out of the ContactRefreshResponse entry', () => {
		const response = proto.Message.PeerDataOperationRequestResponseMessage.fromObject({
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.CONTACT_REFRESH_REQUEST,
			peerDataOperationResult: [
				{
					contactRefreshResponse: {
						coveredRequestIds: [GOLDEN_REQUEST_ID, 'AABB'],
						collectionVersion: 42,
						primaryDurationMs: 1234,
						uniqueContactCount: 17
					}
				}
			]
		})
		const reply = extractContactRefreshReply(response)
		expect(reply).not.toBeNull()
		expect(reply!.coveredRequestIds.sort()).toEqual([GOLDEN_REQUEST_ID, 'AABB'].sort())
		expect(reply!.collectionVersion).toBe(42)
		expect(reply!.primaryDurationMs).toBe(1234)
		expect(reply!.uniqueContactCount).toBe(17)

		const facts = replyFactsForPending(reply!)
		expect(facts).toEqual({ targetVersion: 42, primaryDurationMs: 1234, contactUploadedCount: 17 })
	})

	it('ignores responses without a contact-refresh result', () => {
		const response = proto.Message.PeerDataOperationRequestResponseMessage.fromObject({
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.CONTACT_REFRESH_REQUEST,
			peerDataOperationResult: [{ placeholderMessageResendResponse: {} }]
		})
		expect(extractContactRefreshReply(response)).toBeNull()
		expect(extractContactRefreshReply(null)).toBeNull()
	})
})

describe('contact-refresh backend + reconcile', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: ContactRefreshBackend

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'contact-refresh-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new ContactRefreshBackend(store.handle('wa.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('tracks a request from send to settled', () => {
		backend.recordRequestSent(GOLDEN_REQUEST_ID, FIXED_NOW)
		expect(backend.getPending(GOLDEN_REQUEST_ID)).toEqual({
			refreshId: GOLDEN_REQUEST_ID,
			requestStartMs: FIXED_NOW,
			targetVersion: null,
			primaryDurationMs: null,
			contactUploadedCount: null
		})

		// Reply facts arrive without contact data (that comes via syncd).
		backend.captureReplyFacts(GOLDEN_REQUEST_ID, {
			targetVersion: 42,
			primaryDurationMs: 100,
			contactUploadedCount: 3
		})
		expect(backend.getPending(GOLDEN_REQUEST_ID)!.targetVersion).toBe(42)

		// Data not landed locally yet: patch log empty → waits.
		const waiting = reconcileContactRefresh(backend.listPending(), {
			getCollectionVersion: () => 42,
			hasPatchAtOrAbove: v => backend.hasPatchAtOrAbove(v),
			deletePending: id => backend.deletePending(id),
			deletePatchesAtOrBelow: v => backend.deletePatchesAtOrBelow(v)
		})
		expect(waiting.settled).toHaveLength(0)
		expect(waiting.waiting).toBe(1)

		// Ingestion recorded (as chats.ts's mirror does) → settles + prunes.
		backend.recordPatchApplied({ version: 42, appliedTimestampMs: FIXED_NOW + 10 })
		expect(backend.hasPatchAtOrAbove(42)).toBe(true)
		expect(backend.hasPatchAtOrAbove(43)).toBe(false)

		const outcome = reconcileContactRefresh(backend.listPending(), {
			getCollectionVersion: () => 42,
			hasPatchAtOrAbove: v => backend.hasPatchAtOrAbove(v),
			deletePending: id => backend.deletePending(id),
			deletePatchesAtOrBelow: v => backend.deletePatchesAtOrBelow(v)
		})
		expect(outcome.settled).toHaveLength(1)
		expect(outcome.settled[0]!.refreshId).toBe(GOLDEN_REQUEST_ID)
		expect(outcome.settled[0]!.targetVersion).toBe(42)
		expect(backend.getPending(GOLDEN_REQUEST_ID)).toBeNull()
		expect(backend.hasPatchAtOrAbove(1)).toBe(false) // pruned at/below target
	})

	it('waits while the local collection is behind the target version', () => {
		backend.recordRequestSent(GOLDEN_REQUEST_ID, FIXED_NOW)
		backend.captureReplyFacts(GOLDEN_REQUEST_ID, {
			targetVersion: 42,
			primaryDurationMs: null,
			contactUploadedCount: null
		})
		backend.recordPatchApplied({ version: 42, appliedTimestampMs: FIXED_NOW })

		const outcome = reconcileContactRefresh(backend.listPending(), {
			getCollectionVersion: () => 41,
			hasPatchAtOrAbove: v => backend.hasPatchAtOrAbove(v),
			deletePending: id => backend.deletePending(id),
			deletePatchesAtOrBelow: v => backend.deletePatchesAtOrBelow(v)
		})
		expect(outcome.settled).toHaveLength(0)
		expect(outcome.waiting).toBe(1)
		expect(backend.getPending(GOLDEN_REQUEST_ID)).not.toBeNull()
	})

	it('M2 regression: a settle never prunes patch rows a smaller-target pending still needs', () => {
		// A: older request, target 150. B: newer request, target 100.
		// listPending order puts A first; the old prune-at-settled-target
		// destroyed the only patch row (version 150) before B's probe ran,
		// so B could never settle.
		backend.recordRequestSent('A', FIXED_NOW - 1_000)
		backend.recordRequestSent('B', FIXED_NOW)
		backend.captureReplyFacts('A', { targetVersion: 150, primaryDurationMs: null, contactUploadedCount: null })
		backend.captureReplyFacts('B', { targetVersion: 100, primaryDurationMs: null, contactUploadedCount: null })
		backend.recordPatchApplied({ version: 150, appliedTimestampMs: FIXED_NOW })

		const outcome = reconcileContactRefresh(backend.listPending(), {
			getCollectionVersion: () => 150,
			hasPatchAtOrAbove: v => backend.hasPatchAtOrAbove(v),
			deletePending: id => backend.deletePending(id),
			deletePatchesAtOrBelow: v => backend.deletePatchesAtOrBelow(v)
		})
		expect(outcome.settled.map(s => s.refreshId).sort()).toEqual(['A', 'B'])
		expect(outcome.waiting).toBe(0)
		expect(backend.getPending('B')).toBeNull()
	})

	it('prunes nothing while a pending has no reply facts yet (unknown future target)', () => {
		backend.recordRequestSent('A', FIXED_NOW - 1_000)
		backend.recordRequestSent('B', FIXED_NOW) // no reply facts yet
		backend.captureReplyFacts('A', { targetVersion: 150, primaryDurationMs: null, contactUploadedCount: null })
		backend.recordPatchApplied({ version: 150, appliedTimestampMs: FIXED_NOW })

		const outcome = reconcileContactRefresh(backend.listPending(), {
			getCollectionVersion: () => 150,
			hasPatchAtOrAbove: v => backend.hasPatchAtOrAbove(v),
			deletePending: id => backend.deletePending(id),
			deletePatchesAtOrBelow: v => backend.deletePatchesAtOrBelow(v)
		})
		expect(outcome.settled.map(s => s.refreshId)).toEqual(['A'])
		expect(outcome.waiting).toBe(1)
		// Row 150 survived: B's reply may still claim it as settlement evidence.
		expect(backend.hasPatchAtOrAbove(150)).toBe(true)
	})

	it('accumulates patch counts and keeps the auto-heal window marker', () => {
		backend.recordPatchApplied({ version: 5, appliedTimestampMs: 1, addedCount: 1 })
		backend.recordPatchApplied({ version: 5, appliedTimestampMs: 2, editedCount: 2 })
		const patch = backend.getPatchByVersion(5)!
		expect(patch.addedCount).toBe(1)
		expect(patch.editedCount).toBe(2)

		expect(backend.getLastContactAutoHealTimestamp()).toBeNull()
		backend.setLastContactAutoHealTimestamp(FIXED_NOW)
		expect(backend.getLastContactAutoHealTimestamp()).toBe(FIXED_NOW)
		expect(LAST_CONTACT_AUTO_HEAL_TIMESTAMP_KEY).toBe('last_contact_auto_heal_timestamp')
	})
})

describe('CompanionContactAutoHealer', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let appState: AppStateBackend
	let backend: ContactRefreshBackend
	let emitted: Array<{ event: string; data: unknown }>
	let infoLines: string[]
	let clock: number

	const buildDeps = (overrides?: Partial<ContactAutoHealDeps>): ContactAutoHealDeps => ({
		isCompanion: () => true,
		isEnabled: () => true,
		intervalHours: () => 24,
		getLastHealTimestamp: () => backend.getLastContactAutoHealTimestamp(),
		setLastHealTimestamp: ms => backend.setLastContactAutoHealTimestamp(ms),
		listContactMutationsForHeal: () => appState.listContactMutationsForHeal(),
		listPendingContactMutations: () => appState.listPendingContactMutations(),
		getLocalContact: () => null,
		ev: {
			emit: (event: string, data: unknown) => {
				emitted.push({ event, data })
			}
		} as unknown as BaileysEventEmitter,
		logger: {
			info: (msg: unknown) => {
				infoLines.push(String(msg))
			},
			warn: () => {},
			error: () => {}
		} as unknown as ILogger,
		now: () => clock,
		...overrides
	})

	const seedContactMutation = (index: number, name: string, action: proto.SyncActionValue.IContactAction) => {
		appState.insertMutation({
			mutationIndex: `idx-${index}`,
			mutationValue: Buffer.from(
				proto.SyncActionData.encode({
					index: Buffer.from(JSON.stringify(['contact', TEST_JID])),
					value: { contactAction: action }
				}).finish()
			),
			mutationVersion: index,
			collectionName: 'critical_unblock_low',
			areDependenciesMissing: 0,
			mutationMac: Buffer.alloc(0),
			deviceId: 0,
			epoch: 0,
			chatJid: TEST_JID,
			mutationName: name
		})
	}

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'contact-auto-heal-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		appState = new AppStateBackend(store.handle('sync.db'))
		backend = new ContactRefreshBackend(store.handle('wa.db'))
		emitted = []
		infoLines = []
		clock = FIXED_NOW
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('replays missing contact effects and logs the app heal line', async () => {
		seedContactMutation(1, 'contact', { fullName: 'Fulano', pnJid: TEST_JID })
		seedContactMutation(2, 'contact', { fullName: 'Beltrano', pnJid: TEST_JID })

		const result = await healOnce(buildDeps())
		expect(result.status).toBe('ran')
		if (result.status !== 'ran') throw new Error('unreachable')
		expect(result.repaired).toBe(2)
		expect(result.attempted).toBe(2)
		expect(result.added).toBe(2)
		expect(result.edited).toBe(0)
		expect(emitted.filter(e => e.event === 'contacts.upsert')).toHaveLength(2)
		expect(infoLines).toContain('CompanionContactAutoHealer/healOnce repaired=2 attempted=2 added=2 edited=0')
		expect(backend.getLastContactAutoHealTimestamp()).toBe(FIXED_NOW)
	})

	it('skips mutations whose effect already matches the local contact', async () => {
		seedContactMutation(1, 'contact', { fullName: 'Fulano', pnJid: TEST_JID })
		const local: Contact = { id: TEST_JID, name: 'Fulano', phoneNumber: TEST_JID }

		const result = await healOnce(buildDeps({ getLocalContact: () => local }))
		expect(result.status).toBe('ran')
		if (result.status !== 'ran') throw new Error('unreachable')
		expect(result.repaired).toBe(0)
		expect(result.skippedApplied).toBe(1)
		expect(emitted).toHaveLength(0)
	})

	it('M3 regression: skips PN contacts whose effect matches (index id IS the phone number)', async () => {
		// The live apply writes phoneNumber = index id for PN ids and uses
		// contactAction.pnJid (usually null) only as fallback — the skip
		// comparison must derive it the same way or it never fires for PN.
		seedContactMutation(1, 'contact', { fullName: 'Fulano' })
		const local: Contact = { id: TEST_JID, name: 'Fulano', phoneNumber: TEST_JID }

		const result = await healOnce(buildDeps({ getLocalContact: () => local }))
		expect(result.status).toBe('ran')
		if (result.status !== 'ran') throw new Error('unreachable')
		expect(result.repaired).toBe(0)
		expect(result.skippedApplied).toBe(1)
		expect(emitted).toHaveLength(0)
	})

	it('counts edits when a local contact exists with different values', async () => {
		seedContactMutation(1, 'contact', { fullName: 'Fulano', pnJid: TEST_JID })
		const local: Contact = { id: TEST_JID, name: 'Outro Nome', phoneNumber: TEST_JID }

		const result = await healOnce(buildDeps({ getLocalContact: () => local }))
		expect(result.status).toBe('ran')
		if (result.status !== 'ran') throw new Error('unreachable')
		expect(result.repaired).toBe(1)
		expect(result.edited).toBe(1)
		expect(result.added).toBe(0)
	})

	it('gate order: companion / enabled / interval / window', async () => {
		expect((await healOnce(buildDeps({ isCompanion: () => false }))).status).toBe('skipped')
		expect((await healOnce(buildDeps({ isEnabled: () => false }))).status).toBe('skipped')
		expect((await healOnce(buildDeps({ intervalHours: () => 0 }))).status).toBe('skipped')

		backend.setLastContactAutoHealTimestamp(FIXED_NOW - 3_600_000) // 1h ago, window 24h
		const withinWindow = await healOnce(buildDeps())
		expect(withinWindow).toEqual({ status: 'skipped', reason: 'within_window' })

		// Skips never consume the window marker.
		expect(backend.getLastContactAutoHealTimestamp()).toBe(FIXED_NOW - 3_600_000)
	})

	it('NOT_SETTLED: pending contact mutations block the run without consuming the window', async () => {
		seedContactMutation(1, 'contact', { fullName: 'Fulano', pnJid: TEST_JID })
		const handle = store.handle('sync.db') as unknown as {
			prepare: (sql: string) => { run: (...params: unknown[]) => unknown }
		}
		handle
			.prepare('INSERT INTO pending_mutations (mutation_index, mutation_name) VALUES (?, ?)')
			.run('pending-idx', 'contact')

		const result = await healOnce(buildDeps())
		expect(result).toEqual({ status: 'skipped', reason: 'not_settled' })
		expect(emitted).toHaveLength(0)
		expect(backend.getLastContactAutoHealTimestamp()).toBeNull()
	})

	it('scan only picks contact/lid_contact mutations with resolved dependencies', () => {
		seedContactMutation(1, 'contact', { fullName: 'A' })
		seedContactMutation(2, 'pinAction', {})
		seedContactMutation(3, 'lid_contact', { fullName: 'B' })
		appState.insertMutation({
			mutationIndex: 'idx-missing-deps',
			mutationValue: Buffer.from(
				proto.SyncActionData.encode({
					index: Buffer.from(JSON.stringify(['contact', TEST_JID])),
					value: { contactAction: { fullName: 'C' } }
				}).finish()
			),
			mutationVersion: 4,
			collectionName: 'critical_unblock_low',
			areDependenciesMissing: 1,
			mutationMac: Buffer.alloc(0),
			deviceId: 0,
			epoch: 0,
			chatJid: TEST_JID,
			mutationName: 'contact'
		})

		const rows = appState.listContactMutationsForHeal()
		expect(rows.map(r => r.mutationName)).toEqual(['contact', 'lid_contact'])
		expect(rows.map(r => r.mutationIndex)).toEqual(['idx-1', 'idx-3'])
	})
})
