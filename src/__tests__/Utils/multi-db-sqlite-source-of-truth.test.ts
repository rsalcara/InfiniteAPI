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
import type { ILogger } from '../../Utils/logger'
import { useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { WAJIDDomains } from '../../WABinary'

const sess = (b: number): SignalDataTypeMap['session'] => Buffer.from([b]) as Uint8Array
const keyPair = (pub: number, priv: number): KeyPair => ({
	public: Buffer.from([pub]) as Uint8Array,
	private: Buffer.from([priv]) as Uint8Array
})

/** Minimal ILogger that records its `debug` calls for assertions. */
const makeRecordingLogger = (): ILogger & { debugCalls: Array<{ obj: unknown; msg?: string }> } => {
	const debugCalls: Array<{ obj: unknown; msg?: string }> = []
	const logger: ILogger & { debugCalls: typeof debugCalls } = {
		level: 'debug',
		debugCalls,
		child: () => logger,
		trace: () => {},
		debug: (obj: unknown, msg?: string) => {
			debugCalls.push({ obj, msg })
		},
		info: () => {},
		warn: () => {},
		error: () => {}
	}
	return logger
}

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

	it('falls back to signal_kv when the typed table lacks a row it holds', async () => {
		// Write normally (default ON → typed + signal_kv), then wipe ONLY the
		// typed table to simulate a row that exists in signal_kv but not (yet)
		// in the typed table — e.g. data from before the typed path existed.
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await first.state.keys.set({ session: { [SESSION_ID]: sess(0x33) } })
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

	it('falls back to signal_kv (no throw) when the typed row is legacy mirror bytes, not BufferJSON', async () => {
		// Flag OFF: the best-effort mirror writes RAW session bytes into
		// sessions.record — not the BufferJSON string the source-of-truth read
		// path expects. Use bytes that are not valid JSON.
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await first.state.keys.set({ session: { [SESSION_ID]: Buffer.from([0x00, 0x01, 0xff]) as Uint8Array } })
		const rawRow = first.store
			.handle('axolotl.db')
			.prepare('SELECT record FROM sessions WHERE recipient_account_id = ? AND device_id = ?')
			.get('5511999999999', 0)
		expect(rawRow).toBeDefined() // legacy raw-bytes typed row is present
		first.close()

		// Flag ON: the typed hit fails to parse → treated as a miss → resolved
		// via signal_kv. Must NOT throw, must return the correct value.
		const second = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		const got = await second.state.keys.get('session', [SESSION_ID])
		expect(Buffer.from(got[SESSION_ID] as Uint8Array).toString('hex')).toBe('0001ff')
		second.close()
	})

	it('clear() wipes the typed tables too, so a later typed get returns nothing', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		await state.keys.set({ session: { [SESSION_ID]: sess(0x77) }, 'pre-key': { '3': keyPair(1, 2) } })
		if (!state.keys.clear) throw new Error('clear not implemented')
		await state.keys.clear()

		const sessRow = store.handle('axolotl.db').prepare('SELECT record FROM sessions').get()
		expect(sessRow).toBeUndefined()
		const preRow = store.handle('axolotl.db').prepare('SELECT record FROM prekeys').get()
		expect(preRow).toBeUndefined()

		const got = await state.keys.get('session', [SESSION_ID])
		expect(got[SESSION_ID]).toBeUndefined()
		close()
	})

	it('does not create a jid row on an identity-key get for an unknown contact', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: true })
		const unknownJid = '5500000000000@s.whatsapp.net'
		await state.keys.get('identity-key', [unknownJid])

		const jidRow = store.handle('msgstore.db').prepare('SELECT _id FROM jid WHERE raw_string = ?').get(unknownJid)
		expect(jidRow).toBeUndefined() // read path must not materialize the jid row
		close()
	})

	it('is ON by default (no flag): a session write lands in the typed sessions table', async () => {
		// No signalSourceOfTruth passed → default true.
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await state.keys.set({ session: { [SESSION_ID]: sess(0x5c) } })

		const typedRow = store
			.handle('axolotl.db')
			.prepare('SELECT record FROM sessions WHERE recipient_account_id = ? AND device_id = ?')
			.get('5511999999999', 0) as { record: Buffer } | undefined
		expect(typedRow).toBeDefined()
		// Authoritative format is the BufferJSON string, not raw bytes — so the
		// stored record parses back to the value (round-trips via the typed path).
		const got = await state.keys.get('session', [SESSION_ID])
		expect(Buffer.from(got[SESSION_ID] as Uint8Array).toString('hex')).toBe('5c')
		close()
	})

	it('kill switch (signalSourceOfTruth:false) reverts to the mirror: prekeys stores only the public half', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		await state.keys.set({ 'pre-key': { '9': keyPair(0xab, 0xcd) } })

		// In mirror mode the prekeys.record is the raw PUBLIC half (0xab), not a
		// serialized full KeyPair — proving the kill switch bypassed the source
		// store. (Authoritative mode would store the JSON of both halves.)
		const row = store.handle('axolotl.db').prepare('SELECT record FROM prekeys WHERE prekey_id = ?').get(9) as
			| { record: Buffer }
			| undefined
		expect(row).toBeDefined()
		expect(Buffer.from(row!.record).toString('hex')).toBe('ab')

		// signal_kv is authoritative in this mode, so get still returns the full pair.
		const got = await state.keys.get('pre-key', ['9'])
		const kp = got['9'] as KeyPair
		expect(Buffer.from(kp.public).toString('hex')).toBe('ab')
		expect(Buffer.from(kp.private).toString('hex')).toBe('cd')
		close()
	})

	it('logs a fallback with a cumulative counter when a read is served by signal_kv', async () => {
		// Seed a session with the flag OFF (mirror writes raw bytes; signal_kv
		// authoritative). Then reopen with the default (ON) + a recording logger:
		// the typed read misses/can't-parse the mirror row → served by signal_kv
		// → a fallback debug log is emitted with the cumulative counter.
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		await first.state.keys.set({ session: { [SESSION_ID]: sess(0x42) } })
		first.close()

		const logger = makeRecordingLogger()
		const second = await useMultiDbSqliteAuthState({ sessionDir: dir, logger })
		const got = await second.state.keys.get('session', [SESSION_ID])
		expect(Buffer.from(got[SESSION_ID] as Uint8Array).toString('hex')).toBe('42')

		const fallbackLog = logger.debugCalls.find(
			c => c.msg === 'multi-db-sqlite: typed signal read fell back to signal_kv'
		)
		expect(fallbackLog).toBeDefined()
		expect((fallbackLog!.obj as { cumulativeFallbacks: number }).cumulativeFallbacks).toBeGreaterThanOrEqual(1)
		second.close()
	})

	it('keeps hosted/unsupported identities in signal_kv without overwriting the typed PN identity', async () => {
		const logger = makeRecordingLogger()
		const { store, state, close } = await useMultiDbSqliteAuthState({
			sessionDir: dir,
			signalSourceOfTruth: true,
			logger
		})
		const user = '123456789'
		const pn = `${user}.0`
		const hosted = `${user}_${WAJIDDomains.HOSTED}.0`
		const unsupportedServer = `${user}@g.us`

		await state.keys.set({
			'identity-key': {
				[pn]: Buffer.from([0xa1]) as Uint8Array,
				[hosted]: Buffer.from([0xb2]) as Uint8Array,
				[unsupportedServer]: Buffer.from([0xc3]) as Uint8Array
			}
		})

		const typedRows = store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM identities').get() as {
			n: number
		}
		expect(typedRows.n).toBe(1)

		const kvRows = store
			.handle('axolotl.db')
			.prepare("SELECT id FROM signal_kv WHERE type = 'identity-key' ORDER BY id")
			.all() as Array<{ id: string }>
		expect(kvRows.map(row => row.id)).toEqual([hosted, pn, unsupportedServer].sort())

		const got = await state.keys.get('identity-key', [pn, hosted, unsupportedServer])
		expect(Buffer.from(got[pn] as Uint8Array).toString('hex')).toBe('a1')
		expect(Buffer.from(got[hosted] as Uint8Array).toString('hex')).toBe('b2')
		expect(Buffer.from(got[unsupportedServer] as Uint8Array).toString('hex')).toBe('c3')

		const writeFallback = logger.debugCalls.find(
			call => call.msg === 'multi-db-sqlite: identity-key not mapped to a typed row, signal_kv still written'
		)
		expect(writeFallback?.obj).toMatchObject({
			id: hosted,
			reason: 'hosted-domain',
			domainType: WAJIDDomains.HOSTED
		})
		const unsupportedFallback = logger.debugCalls.find(
			call =>
				call.msg === 'multi-db-sqlite: identity-key not mapped to a typed row, signal_kv still written' &&
				(call.obj as { id?: string }).id === unsupportedServer
		)
		expect(unsupportedFallback?.obj).toMatchObject({
			id: unsupportedServer,
			reason: 'unsupported-jid-server',
			server: 'g.us'
		})
		close()
	})
})
