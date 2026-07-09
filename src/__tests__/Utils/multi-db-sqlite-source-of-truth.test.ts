/**
 * `useMultiDbSqliteAuthState({ signalSourceOfTruth: true })` — the typed
 * axolotl.db tables (sessions/prekeys/sender_keys/identities) become the
 * PRIMARY read/write surface, with signal_kv as an atomic fallback + rollback.
 *
 * Verifies:
 *   - every Signal data type round-trips byte-identically through the typed
 *     tables (critically `pre-key`, whose full {public,private} KeyPair a
 *     raw-bytes column could not hold);
 *   - the write actually lands in the structured table (not only signal_kv);
 *   - deletes remove the typed row, so a stale row can't shadow the delete;
 *   - a value written only into signal_kv (a pre-flag row) still resolves via
 *     fallback;
 *   - signal_kv is dual-written in the same transaction (rollback safety net).
 *
 * Native-binding tests (real better-sqlite3) — run in CI, skipped locally
 * when the binding is unavailable.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { KeyPair, SignalDataTypeMap } from '../../Types'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'

const sess = (b: number): SignalDataTypeMap['session'] => Buffer.from([b]) as Uint8Array
const keyPair = (pub: number, priv: number): KeyPair => ({
	public: Buffer.from([pub]) as Uint8Array,
	private: Buffer.from([priv]) as Uint8Array
})

// ProtocolAddress.toString() shape for a plain PN user (no domain suffix).
const SESSION_ID = '5511999999999.0'
// SenderKeyName.serialize() shape: "groupId::signalUser::deviceId".
const SENDER_KEY_ID = '120363000000000000@g.us::5511999999999::0'
const IDENTITY_JID = '5511999999999@s.whatsapp.net'
const LID_IDENTITY_JID = '99887766554433@lid'

describe('useMultiDbSqliteAuthState — signalSourceOfTruth', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'multi-db-sot-test-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('writes a session into axolotl.db.sessions AND signal_kv, and reads it back from the typed table', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await state.keys.set({ session: { [SESSION_ID]: sess(7) } })

		const typedRow = store
			.handle('axolotl.db')
			.prepare('SELECT record FROM sessions WHERE recipient_account_id = ? AND device_id = ?')
			.get('5511999999999', 0) as { record: Buffer } | undefined
		expect(typedRow).toBeDefined()

		// signal_kv is dual-written in the same transaction (rollback net).
		const kvRow = store
			.handle('axolotl.db')
			.prepare("SELECT value FROM signal_kv WHERE type = 'session' AND id = ?")
			.get(SESSION_ID)
		expect(kvRow).toBeDefined()

		const got = await state.keys.get('session', [SESSION_ID])
		expect(Buffer.from(got[SESSION_ID] as Uint8Array).toString('hex')).toBe('07')
		close()
	})

	it('round-trips a pre-key with BOTH public and private halves through prekeys.record', async () => {
		const { state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await state.keys.set({ 'pre-key': { '42': keyPair(0xaa, 0xbb) } })

		const got = await state.keys.get('pre-key', ['42'])
		const kp = got['42'] as KeyPair
		expect(Buffer.from(kp.public).toString('hex')).toBe('aa')
		expect(Buffer.from(kp.private).toString('hex')).toBe('bb')
		close()
	})

	it('round-trips a sender-key through sender_keys.record', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await state.keys.set({ 'sender-key': { [SENDER_KEY_ID]: sess(0x5a) } })

		const typedRow = store
			.handle('axolotl.db')
			.prepare('SELECT record FROM sender_keys WHERE group_id = ? AND sender_account_id = ? AND device_id = ?')
			.get('120363000000000000@g.us', '5511999999999', 0)
		expect(typedRow).toBeDefined()

		const got = await state.keys.get('sender-key', [SENDER_KEY_ID])
		expect(Buffer.from(got[SENDER_KEY_ID] as Uint8Array).toString('hex')).toBe('5a')
		close()
	})

	it('stores an identity-key in identities with recipient_type=0 (PN) / 1 (LID) and round-trips', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await state.keys.set({
			'identity-key': {
				[IDENTITY_JID]: Buffer.from([0xc1]) as Uint8Array,
				[LID_IDENTITY_JID]: Buffer.from([0xc2]) as Uint8Array
			}
		})

		const pnRowId = store
			.handle('msgstore.db')
			.prepare('SELECT _id FROM jid WHERE raw_string = ?')
			.get(IDENTITY_JID) as {
			_id: number
		}
		const pnIdentity = store
			.handle('axolotl.db')
			.prepare('SELECT recipient_type FROM identities WHERE recipient_id = ?')
			.get(pnRowId._id) as { recipient_type: number }
		expect(pnIdentity.recipient_type).toBe(0)

		const lidRowId = store
			.handle('msgstore.db')
			.prepare('SELECT _id FROM jid WHERE raw_string = ?')
			.get(LID_IDENTITY_JID) as { _id: number }
		const lidIdentity = store
			.handle('axolotl.db')
			.prepare('SELECT recipient_type FROM identities WHERE recipient_id = ?')
			.get(lidRowId._id) as { recipient_type: number }
		expect(lidIdentity.recipient_type).toBe(1)

		const got = await state.keys.get('identity-key', [IDENTITY_JID, LID_IDENTITY_JID])
		expect(Buffer.from(got[IDENTITY_JID] as Uint8Array).toString('hex')).toBe('c1')
		expect(Buffer.from(got[LID_IDENTITY_JID] as Uint8Array).toString('hex')).toBe('c2')
		close()
	})

	it('delete removes the typed row too, so it cannot shadow the delete on read', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await state.keys.set({ session: { [SESSION_ID]: sess(9) } })
		await state.keys.set({ session: { [SESSION_ID]: null as unknown as SignalDataTypeMap['session'] } })

		const typedRow = store
			.handle('axolotl.db')
			.prepare('SELECT record FROM sessions WHERE recipient_account_id = ? AND device_id = ?')
			.get('5511999999999', 0)
		expect(typedRow).toBeUndefined()

		const got = await state.keys.get('session', [SESSION_ID])
		expect(got[SESSION_ID]).toBeUndefined()
		close()
	})

	it('falls back to signal_kv for a row written before the flag was enabled', async () => {
		// First session: flag OFF — value lands in signal_kv (+ best-effort
		// mirror), but not necessarily in the authoritative typed format.
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await first.state.keys.set({ session: { [SESSION_ID]: sess(0x33) } })
		// Wipe the typed table to simulate "typed has no authoritative row yet".
		first.store.handle('axolotl.db').prepare('DELETE FROM sessions').run()
		first.close()

		// Reopen with the flag ON: the typed read misses, so it falls back to
		// signal_kv and still returns the value.
		const second = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		const got = await second.state.keys.get('session', [SESSION_ID])
		expect(Buffer.from(got[SESSION_ID] as Uint8Array).toString('hex')).toBe('33')
		second.close()
	})

	it('persists typed-authoritative data across close + reopen', async () => {
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await first.state.keys.set({ 'pre-key': { '7': keyPair(0x10, 0x20) } })
		first.close()

		const second = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		const got = await second.state.keys.get('pre-key', ['7'])
		const kp = got['7'] as KeyPair
		expect(Buffer.from(kp.public).toString('hex')).toBe('10')
		expect(Buffer.from(kp.private).toString('hex')).toBe('20')
		second.close()
	})

	it('leaves non-typed data (lid-mapping) on signal_kv even with the flag on', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await state.keys.set({ 'lid-mapping': { '5511999999999': '99887766554433' } })

		const kvRow = store
			.handle('axolotl.db')
			.prepare("SELECT value FROM signal_kv WHERE type = 'lid-mapping' AND id = ?")
			.get('5511999999999')
		expect(kvRow).toBeDefined()

		const got = await state.keys.get('lid-mapping', ['5511999999999'])
		expect(got['5511999999999']).toBe('99887766554433')
		close()
	})
})
