/**
 * `useMultiDbSqliteAuthState` skeleton smoke test.
 *
 * Covers:
 *   - creates all 11 physical .db files (creds, axolotl, msgstore, wa, sync,
 *     media, companion_devices, chatsettings, location, stickers, status);
 *   - typed tables exist with expected names in the right .db files;
 *   - creds round-trip via creds.db;
 *   - signal data round-trip via axolotl.db.signal_kv in legacy/kill-switch
 *     mode;
 *   - app-state-sync-key round-trips via creds.db.app_state_sync_keys
 *     instead of signal_kv, including the legacy-row migration path;
 *   - session/pre-key/sender-key/identity-key writes best-effort MIRROR into
 *     axolotl.db's typed tables (sessions/prekeys/sender_keys/identities)
 *     alongside the authoritative signal_kv write in that mode;
 *   - close + reopen preserves all data.
 *
 * Uses on-disk DBs in a tmp directory because the multi-file layout
 * requires real files (`:memory:` is per-connection and doesn't apply
 * across the 11 handles).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SignalDataTypeMap } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth-utils'
import { BufferJSON } from '../../Utils/generics'
import type { ILogger } from '../../Utils/logger'
import { SignalTypedBackend, TrustedContactsBackend, useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { markPrekeyDirectDistributionIntent } from '../../Utils/prekey-direct-distribution'

const silentLogger = (): ILogger => ({
	level: 'silent',
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger()
})

const sampleSession = (b: number): SignalDataTypeMap['session'] => Buffer.from([b]) as Uint8Array

const sampleAppStateSyncKey = (n: number): SignalDataTypeMap['app-state-sync-key'] =>
	({
		keyData: Buffer.from([n]),
		fingerprint: { rawId: n, currentIndex: n, deviceIndexes: [n] },
		timestamp: String(1_700_000_000 + n)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any

describe('useMultiDbSqliteAuthState', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'multi-db-sqlite-test-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('opens all 11 physical .db files on first open', async () => {
		const { close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		const { promises: fs } = await import('fs')
		const files = await fs.readdir(dir)
		expect(files).toEqual(
			expect.arrayContaining([
				'creds.db',
				'axolotl.db',
				'msgstore.db',
				'wa.db',
				'sync.db',
				'media.db',
				'companion_devices.db',
				'chatsettings.db',
				'location.db',
				'stickers.db',
				'status.db'
			])
		)
		// Discontinued DBs must NOT be created anymore.
		expect(files).not.toContain('payments.db')
		expect(files).not.toContain('smb.db')
		expect(files).not.toContain('prometheus.db')
		close()
	})

	it('creates typed tables in the right .db files', async () => {
		const { store, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })

		const axolotlTables = (
			store.handle('axolotl.db').prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
				name: string
			}>
		).map(r => r.name)
		expect(axolotlTables).toEqual(
			expect.arrayContaining([
				'sessions',
				'prekeys',
				'signed_prekeys',
				'kyber_prekeys',
				'identities',
				'sender_keys',
				'fast_ratchet_sender_keys',
				'message_base_key',
				'preacks',
				'prekey_uploads',
				'chat_stanza_queue',
				'e2ee_stanza_queue',
				'unordered_stanza_queue',
				'signal_kv'
			])
		)

		const msgstoreTables = (
			store.handle('msgstore.db').prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
				name: string
			}>
		).map(r => r.name)
		expect(msgstoreTables).toEqual(
			expect.arrayContaining([
				'jid',
				'jid_map',
				'user_device',
				'user_device_info',
				'primary_device_version',
				'message_orphaned_edit',
				'message_quarantine'
			])
		)

		const credsTables = (
			store.handle('creds.db').prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
				name: string
			}>
		).map(r => r.name)
		expect(credsTables).toEqual(expect.arrayContaining(['creds', 'app_state_sync_keys']))

		const waTables = (
			store.handle('wa.db').prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
				name: string
			}>
		).map(r => r.name)
		expect(waTables).toEqual(expect.arrayContaining(['wa_contacts', 'wa_trusted_contacts', 'wa_trusted_contacts_send']))

		const syncTables = (
			store.handle('sync.db').prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
				name: string
			}>
		).map(r => r.name)
		expect(syncTables).toEqual(
			expect.arrayContaining([
				'collection_versions',
				'syncd_mutations',
				'pending_mutations',
				'crypto_info',
				'missing_keys',
				'placeholder_retry_message',
				'peer_messages'
			])
		)

		const statusTables = (
			store.handle('status.db').prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
				name: string
			}>
		).map(r => r.name)
		expect(statusTables).toEqual(
			expect.arrayContaining([
				'status',
				'status_attribution',
				'status_crossposting_v3',
				'status_info',
				'status_text',
				'status_media_link',
				'status_thumbnail',
				'status_seen_receipt',
				'status_privacy_custom_list',
				'key_value_store',
				'props'
			])
		)

		close()
	})

	it('persists creds across close+reopen via creds.db', async () => {
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
		first.state.creds.advSecretKey = 'sentinel-creds'
		await first.saveCreds()
		first.close()

		const second = await useMultiDbSqliteAuthState({ sessionDir: dir })
		expect(second.state.creds.advSecretKey).toBe('sentinel-creds')
		second.close()
	})

	it('persists signal data across close+reopen via axolotl.db.signal_kv', async () => {
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await first.state.keys.set({
			session: { 'aaa:0': sampleSession(7), 'bbb:0': sampleSession(42) }
		})
		first.close()

		const second = await useMultiDbSqliteAuthState({ sessionDir: dir })
		const got = await second.state.keys.get('session', ['aaa:0', 'bbb:0'])
		expect(got['aaa:0']).toBeDefined()
		expect(got['bbb:0']).toBeDefined()
		expect(Buffer.from(got['aaa:0'] as Uint8Array).toString('hex')).toBe('07')
		expect(Buffer.from(got['bbb:0'] as Uint8Array).toString('hex')).toBe('2a')
		second.close()
	})

	it('deletes a signal key when set to null', async () => {
		const { state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await state.keys.set({ session: { x: sampleSession(1) } })
		await state.keys.set({ session: { x: null as unknown as SignalDataTypeMap['session'] } })

		const got = await state.keys.get('session', ['x'])
		expect(got['x']).toBeUndefined()
		close()
	})

	it('enumerates ids via listIds AsyncIterable', async () => {
		const { state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await state.keys.set({
			session: { a: sampleSession(1), b: sampleSession(2), c: sampleSession(3) }
		})

		const listIds = state.keys.listIds
		if (!listIds) throw new Error('listIds not implemented')
		const ids: string[] = []
		for await (const id of listIds('session')) ids.push(id)
		expect(ids.sort()).toEqual(['a', 'b', 'c'])
		close()
	})

	it('routes app-state-sync-key to creds.db.app_state_sync_keys, not axolotl.signal_kv', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await state.keys.set({
			'app-state-sync-key': { 'key-1': sampleAppStateSyncKey(9) }
		})

		const credsRow = store
			.handle('creds.db')
			.prepare('SELECT key_id FROM app_state_sync_keys WHERE key_id = ?')
			.get('key-1')
		expect(credsRow).toBeDefined()

		const signalKvRow = store
			.handle('axolotl.db')
			.prepare("SELECT id FROM signal_kv WHERE type = 'app-state-sync-key' AND id = ?")
			.get('key-1')
		expect(signalKvRow).toBeUndefined()

		const got = await state.keys.get('app-state-sync-key', ['key-1'])
		expect(got['key-1']?.keyData).toBeDefined()
		expect(Buffer.from(got['key-1']!.keyData as Uint8Array).toString('hex')).toBe('09')
		close()
	})

	it('rejects a cross-database keys.set batch before either database is written', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await expect(
			state.keys.set({
				'app-state-sync-key': { mixed: sampleAppStateSyncKey(9) },
				session: { '5511999999999.0': sampleSession(7) }
			})
		).rejects.toThrow('cannot mix app-state-sync-key')
		expect(
			store.handle('creds.db').prepare('SELECT key_id FROM app_state_sync_keys WHERE key_id = ?').get('mixed')
		).toBeUndefined()
		expect(store.handle('axolotl.db').prepare("SELECT id FROM signal_kv WHERE type = 'session'").get()).toBeUndefined()
		close()
	})

	it('lists app-state-sync-key ids/entries from creds.db.app_state_sync_keys', async () => {
		const { state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await state.keys.set({
			'app-state-sync-key': { a: sampleAppStateSyncKey(1), b: sampleAppStateSyncKey(2) }
		})

		const listIds = state.keys.listIds
		if (!listIds) throw new Error('listIds not implemented')
		const ids: string[] = []
		for await (const id of listIds('app-state-sync-key')) ids.push(id)
		expect(ids.sort()).toEqual(['a', 'b'])

		const list = state.keys.list
		if (!list) throw new Error('list not implemented')
		const entries: string[] = []
		for await (const [id] of list('app-state-sync-key')) entries.push(id)
		expect(entries.sort()).toEqual(['a', 'b'])
		close()
	})

	it('clear() wipes app_state_sync_keys along with signal_kv and jid_map', async () => {
		const { state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await state.keys.set({ 'app-state-sync-key': { x: sampleAppStateSyncKey(1) } })
		if (!state.keys.clear) throw new Error('clear not implemented')
		await state.keys.clear()

		const got = await state.keys.get('app-state-sync-key', ['x'])
		expect(got['x']).toBeUndefined()
		close()
	})

	it('migrates legacy app-state-sync-key rows from axolotl.signal_kv on open()', async () => {
		// Simulate a session persisted by a prior version of this adapter,
		// before app-state-sync-key had its own table — write directly into
		// axolotl.signal_kv the way the old code path did.
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
		first.store
			.handle('axolotl.db')
			.prepare("INSERT INTO signal_kv (type, id, value) VALUES ('app-state-sync-key', ?, ?)")
			.run('legacy-key', JSON.stringify(sampleAppStateSyncKey(5), BufferJSON.replacer))
		first.close()

		const second = await useMultiDbSqliteAuthState({ sessionDir: dir })
		const migratedRow = second.store
			.handle('creds.db')
			.prepare('SELECT key_id FROM app_state_sync_keys WHERE key_id = ?')
			.get('legacy-key')
		expect(migratedRow).toBeDefined()

		const leftoverRow = second.store
			.handle('axolotl.db')
			.prepare("SELECT id FROM signal_kv WHERE type = 'app-state-sync-key' AND id = ?")
			.get('legacy-key')
		expect(leftoverRow).toBeUndefined()

		const got = await second.state.keys.get('app-state-sync-key', ['legacy-key'])
		expect(got['legacy-key']?.keyData).toBeDefined()
		expect(Buffer.from(got['legacy-key']!.keyData as Uint8Array).toString('hex')).toBe('05')
		second.close()
	})

	it('mirrors a session write into axolotl.db.sessions alongside signal_kv (legacy/kill-switch mode)', async () => {
		// signalSourceOfTruth:false is the legacy/kill-switch mode where the
		// best-effort mirror writes raw bytes and signal_kv stays authoritative.
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		// Matches ProtocolAddress.toString() = "signalUser.deviceId" — a bare
		// PN user has no domainType suffix (see signal-id-parsing.ts doc).
		await state.keys.set({ session: { '5511999999999.0': sampleSession(7) } })

		const row = store
			.handle('axolotl.db')
			.prepare(
				'SELECT record, recipient_account_id, recipient_account_type, device_id FROM sessions ' +
					'WHERE recipient_account_id = ? AND device_id = ?'
			)
			.get('5511999999999', 0) as { record: Buffer; recipient_account_type: number } | undefined
		expect(row).toBeDefined()
		expect(row?.recipient_account_type).toBe(0)
		expect(Buffer.from(row!.record).toString('hex')).toBe('07')

		// signal_kv is still the authoritative store the real read path uses.
		const got = await state.keys.get('session', ['5511999999999.0'])
		expect(Buffer.from(got['5511999999999.0'] as Uint8Array).toString('hex')).toBe('07')
		close()
	})

	it('mirrors a protocol-address LID identity-key into identities with recipient_type=1 (legacy mode)', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		await state.keys.set({ 'identity-key': { '123456789_1.0': Buffer.from([0xaa]) as Uint8Array } })

		const jidRowId = store
			.handle('msgstore.db')
			.prepare('SELECT _id FROM jid WHERE raw_string = ?')
			.get('123456789@lid') as { _id: number } | undefined
		expect(jidRowId).toBeDefined()

		const row = store
			.handle('axolotl.db')
			.prepare('SELECT public_key, recipient_type FROM identities WHERE recipient_id = ?')
			.get(jidRowId!._id) as { public_key: Buffer; recipient_type: number } | undefined
		expect(row).toBeDefined()
		expect(row?.recipient_type).toBe(1)
		expect(Buffer.from(row!.public_key).toString('hex')).toBe('aa')
		close()
	})

	it('mirrors a sender-key write into axolotl.db.sender_keys (legacy mode)', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		// Matches SenderKeyName.serialize() = "groupId::signalUser::deviceId".
		await state.keys.set({
			'sender-key': { '123456-789@g.us::5511999999999::0': Buffer.from([0xbb]) as Uint8Array }
		})

		const row = store
			.handle('axolotl.db')
			.prepare('SELECT record FROM sender_keys WHERE group_id = ? AND sender_account_id = ? AND device_id = ?')
			.get('123456-789@g.us', '5511999999999', 0) as { record: Buffer } | undefined
		expect(row).toBeDefined()
		expect(Buffer.from(row!.record).toString('hex')).toBe('bb')
		close()
	})

	it('mirrors a pre-key write into axolotl.db.prekeys (public half) and honors delete (legacy mode)', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		await state.keys.set({
			'pre-key': { '42': { public: Buffer.from([0xcc]), private: Buffer.from([0xdd]) } }
		})

		const row = store.handle('axolotl.db').prepare('SELECT record FROM prekeys WHERE prekey_id = ?').get(42) as
			| { record: Buffer }
			| undefined
		expect(row).toBeDefined()
		expect(Buffer.from(row!.record).toString('hex')).toBe('cc')

		await state.keys.set({ 'pre-key': { '42': null } })
		const afterDelete = store.handle('axolotl.db').prepare('SELECT record FROM prekeys WHERE prekey_id = ?').get(42)
		expect(afterDelete).toBeUndefined()
		close()
	})

	it('does not throw and leaves signal_kv intact when a session id cannot be parsed for the mirror (legacy mode)', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		// No "." device separator — parseProtocolAddressId returns null.
		await expect(state.keys.set({ session: { 'not-a-valid-address': sampleSession(1) } })).resolves.not.toThrow()

		const got = await state.keys.get('session', ['not-a-valid-address'])
		expect(Buffer.from(got['not-a-valid-address'] as Uint8Array).toString('hex')).toBe('01')

		const sessionsCount = store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM sessions').get() as {
			n: number
		}
		expect(sessionsCount.n).toBe(0)
		close()
	})

	it('keeps hosted sessions in signal_kv without colliding with a typed PN row', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		await state.keys.set({
			session: {
				'5511999999999.0': sampleSession(1),
				'5511999999999_128.0': sampleSession(2)
			}
		})
		const typedRows = store
			.handle('axolotl.db')
			.prepare('SELECT recipient_account_type, record FROM sessions WHERE recipient_account_id = ?')
			.all('5511999999999') as Array<{ recipient_account_type: number; record: Buffer }>
		expect(typedRows).toHaveLength(1)
		expect(typedRows[0]?.recipient_account_type).toBe(0)
		const got = await state.keys.get('session', ['5511999999999.0', '5511999999999_128.0'])
		expect(Buffer.from(got['5511999999999.0'] as Uint8Array).toString('hex')).toBe('01')
		expect(Buffer.from(got['5511999999999_128.0'] as Uint8Array).toString('hex')).toBe('02')
		close()
	})

	// Integration guard for the retry-receipt direct_distribution flag: the
	// object-identity intent must survive the transaction cache and make the
	// typed prekey INSERT + flag atomic with signal_kv.
	it('commits a freshly-generated retry prekey with direct_distribution atomically', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		try {
			// The raw auth-state keys have no transaction(); the socket adds it via
			// addTransactionCapability — replicate that here so the deferred-mutation
			// semantics match production.
			const keys = addTransactionCapability(state.keys, silentLogger(), {
				maxCommitRetries: 1,
				delayBetweenTriesMs: 1
			})
			const backend = new SignalTypedBackend(store.handle('axolotl.db'))
			const kp = { public: Buffer.from([1, 2, 3]) as Uint8Array, private: Buffer.from([4, 5, 6]) as Uint8Array }
			const readDd = (id: number) =>
				(
					store.handle('axolotl.db').prepare('SELECT direct_distribution FROM prekeys WHERE prekey_id = ?').get(id) as
						| { direct_distribution?: number }
						| undefined
				)?.direct_distribution

			await keys.transaction(async () => {
				await keys.set({ 'pre-key': { 43: kp } })
				markPrekeyDirectDistributionIntent(kp)
			}, 'itest')
			expect(readDd(43)).toBe(1)
			expect(backend.isPrekeyDirectDistribution(43)).toBe(true)
			expect(backend.countUnsentPrekeys()).toBe(0)
		} finally {
			close()
		}
	})

	it('routes tctoken through wa_trusted_contacts / _send (authoritative) with signal_kv fallback', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		try {
			const jid = '46802258641027@lid'
			await state.keys.set({
				tctoken: {
					[jid]: {
						token: Buffer.from([1, 2, 3]),
						timestamp: '1784050585',
						senderTimestamp: 1783471194,
						realIssueTimestamp: null
					}
				}
			})

			// Authoritative write landed in the relational tables (not just signal_kv).
			const inc = store
				.handle('wa.db')
				.prepare(
					'SELECT hex(incoming_tc_token) AS t, incoming_tc_token_timestamp AS ts FROM wa_trusted_contacts WHERE jid = ?'
				)
				.get(jid) as { t: string; ts: number }
			expect(inc).toEqual({ t: '010203', ts: 1784050585 })
			const snt = store
				.handle('wa.db')
				.prepare(
					'SELECT sent_tc_token_timestamp AS s, real_issue_timestamp AS r FROM wa_trusted_contacts_send WHERE jid = ?'
				)
				.get(jid) as { s: number; r: number }
			expect(snt).toEqual({ s: 1783471194, r: 0 }) // realIssueTimestamp null → 0

			// Read merges both tables back into the bundled KV value.
			const got = await state.keys.get('tctoken', [jid])
			expect(Buffer.from(got[jid]!.token).toString('hex')).toBe('010203')
			expect(got[jid]!.senderTimestamp).toBe(1783471194)

			// Metadata keys (no `@`) are NOT contacts → signal_kv only.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await state.keys.set({ tctoken: { __index: { jids: [jid] } as any } })
			expect(
				(
					store
						.handle('wa.db')
						.prepare('SELECT COUNT(*) AS n FROM wa_trusted_contacts WHERE jid = ?')
						.get('__index') as { n: number }
				).n
			).toBe(0)
			expect((await state.keys.get('tctoken', ['__index']))['__index']).toBeDefined()

			// Delete (set null) clears both relational rows; read returns undefined.
			await state.keys.set({ tctoken: { [jid]: null as unknown as SignalDataTypeMap['tctoken'] } })
			expect(
				(
					store.handle('wa.db').prepare('SELECT COUNT(*) AS n FROM wa_trusted_contacts WHERE jid = ?').get(jid) as {
						n: number
					}
				).n
			).toBe(0)
			expect((await state.keys.get('tctoken', [jid]))[jid]).toBeUndefined()
		} finally {
			close()
		}
	})

	it('exposes tctoken authority only in source-of-truth mode and CAS-prunes without deleting a refresh', async () => {
		const { state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir })
		try {
			const jid = '12345@lid'
			// Production socket wraps authState.keys before messages-recv consumes it.
			// Both the authority and signal_kv enumeration must survive that wrapper.
			const keys = addTransactionCapability(state.keys, silentLogger(), {
				maxCommitRetries: 1,
				delayBetweenTriesMs: 1
			})
			const authority = keys.trustedContactTokens
			expect(authority?.authoritative).toBe(true)
			await keys.set({ tctoken: { [jid]: { token: Buffer.from([1]), timestamp: '100' } } })
			await keys.set({ tctoken: { [jid]: { token: Buffer.from([2]), timestamp: '200' } } })
			const listedIds: string[] = []
			for await (const id of keys.listIds!('tctoken')) listedIds.push(id)
			expect(listedIds).toContain(jid)

			// Prune observed timestamp=100, but the token was refreshed to 200.
			expect(await authority!.compareAndPrune(jid, 100, Buffer.from([1]))).toBe(false)
			let got = await keys.get('tctoken', [jid])
			expect(Buffer.from(got[jid]!.token).toString('hex')).toBe('02')

			// Same-second refresh is also protected by the token bytes, not only timestamp.
			await keys.set({ tctoken: { [jid]: { token: Buffer.from([3]), timestamp: '200' } } })
			expect(await authority!.compareAndPrune(jid, 200, Buffer.from([2]))).toBe(false)
			expect(await authority!.compareAndPrune(jid, 200, Buffer.from([3]))).toBe(true)
			expect(authority!.listIncoming()).toEqual([])
			got = await keys.get('tctoken', [jid])
			expect(got[jid]).toBeUndefined()
		} finally {
			close()
		}
	})

	it('keeps the relational tctoken readable and logs an actionable reason when the signal_kv backup write fails', async () => {
		const error = jest.fn()
		const logger: ILogger = { ...silentLogger(), error }
		const { store, state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, logger })
		const jid = 'backup-failure@lid'
		try {
			store.handle('axolotl.db').exec(`
				CREATE TRIGGER fail_tctoken_signal_kv_backup
				BEFORE INSERT ON signal_kv
				WHEN NEW.type = 'tctoken'
				BEGIN
					SELECT RAISE(ABORT, 'forced tctoken signal_kv backup failure');
				END;
			`)

			await expect(
				state.keys.set({ tctoken: { [jid]: { token: Buffer.from([0xab]), timestamp: '321' } } })
			).rejects.toThrow('forced tctoken signal_kv backup failure')

			const got = await state.keys.get('tctoken', [jid])
			expect(Buffer.from(got[jid]!.token).toString('hex')).toBe('ab')
			expect(error).toHaveBeenCalledWith(
				expect.objectContaining({
					reason: 'signal-kv-fallback-write-failed',
					authoritativeStore: 'wa.db',
					fallbackStore: 'axolotl.db.signal_kv',
					fallbackState: 'stale-or-missing',
					recovery: 'retry-the-same-keys.set-batch'
				}),
				expect.stringContaining('tctoken committed to wa.db')
			)
		} finally {
			store.handle('axolotl.db').exec('DROP TRIGGER IF EXISTS fail_tctoken_signal_kv_backup')
			close()
		}
	})

	it('recovers an interrupted cross-file tctoken clear without resurrecting signal_kv', async () => {
		const first = await useMultiDbSqliteAuthState({ sessionDir: dir })
		const jid = '67890@lid'
		await first.state.keys.set({ tctoken: { [jid]: { token: Buffer.from([7]), timestamp: '100' } } })
		new TrustedContactsBackend(first.store.handle('wa.db')).beginClear()
		first.close()

		const second = await useMultiDbSqliteAuthState({ sessionDir: dir })
		try {
			expect((await second.state.keys.get('tctoken', [jid]))[jid]).toBeUndefined()
			expect(new TrustedContactsBackend(second.store.handle('wa.db')).hasPendingClear()).toBe(false)
		} finally {
			second.close()
		}
	})

	it('does not advertise relational tctoken authority in kill-switch mode', async () => {
		const { state, close } = await useMultiDbSqliteAuthState({ sessionDir: dir, signalSourceOfTruth: false })
		try {
			expect(state.keys.trustedContactTokens).toBeUndefined()
		} finally {
			close()
		}
	})

	it('keeps signal_kv operational when a direct-distribution mirror fails in kill-switch mode', async () => {
		const { store, state, close } = await useMultiDbSqliteAuthState({
			sessionDir: dir,
			signalSourceOfTruth: false,
			logger: silentLogger()
		})
		try {
			store.handle('axolotl.db').exec(`
				CREATE TRIGGER fail_direct_distribution_mirror
				BEFORE INSERT ON prekeys
				BEGIN
					SELECT RAISE(ABORT, 'forced typed mirror failure');
				END;
			`)
			const kp = { public: Buffer.from([0x31]), private: Buffer.from([0x32]) }
			markPrekeyDirectDistributionIntent(kp)

			await expect(state.keys.set({ 'pre-key': { 44: kp } })).resolves.not.toThrow()
			const got = await state.keys.get('pre-key', ['44'])
			expect(Buffer.from(got['44']!.public).toString('hex')).toBe('31')
			expect(store.handle('axolotl.db').prepare('SELECT 1 FROM prekeys WHERE prekey_id = 44').get()).toBeUndefined()
		} finally {
			store.handle('axolotl.db').exec('DROP TRIGGER IF EXISTS fail_direct_distribution_mirror')
			close()
		}
	})
})
