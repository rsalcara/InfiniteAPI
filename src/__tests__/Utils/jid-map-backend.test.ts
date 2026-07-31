/**
 * `JidMapBackend` + `wrapKeysWithJidMap` test.
 *
 * Verifies the typed `jid_map`-backed storage answers the same
 * SignalKeyStore queries that the existing `LIDMappingStore` issues:
 *
 *   - `keys.set({ 'lid-mapping': { [pnUser]: lidUser, [`${lidUser}_reverse`]: pnUser } })`
 *     persists a single bidirectional mapping
 *   - `keys.get('lid-mapping', [pnUser])` resolves to the LID
 *   - `keys.get('lid-mapping', [`${lidUser}_reverse`])` resolves to the PN
 *   - Non-`'lid-mapping'` types pass through to the inner store
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SignalKeyStoreWithTransaction } from '../../Types'
import {
	JidMapBackend,
	LidChatStateBackend,
	MultiDbSqliteStore,
	REVERSE_SUFFIX,
	wrapKeysWithJidMap
} from '../../Utils/multi-db-sqlite'

function makeInnerStub(): SignalKeyStoreWithTransaction & { _calls: string[] } {
	const calls: string[] = []
	const stub = {
		_calls: calls,
		isInTransaction: () => false,
		transaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
		get: async () => ({}),
		set: async () => {
			calls.push('inner.set')
		}
	} as unknown as SignalKeyStoreWithTransaction & { _calls: string[] }
	return stub
}

describe('JidMapBackend + wrapKeysWithJidMap', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'jid-map-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('stores and resolves a PN↔LID pair via JidMapBackend directly', () => {
		const backend = new JidMapBackend(store.handle('msgstore.db'))
		backend.storeMapping('5515991426667@s.whatsapp.net', '46802258641027@lid')

		expect(backend.getLidForPn('5515991426667@s.whatsapp.net')).toBe('46802258641027@lid')
		expect(backend.getPnForLid('46802258641027@lid')).toBe('5515991426667@s.whatsapp.net')
		expect(backend.getLidForPn('unknown@s.whatsapp.net')).toBeNull()
		expect(backend.getPnForLid('unknown@lid')).toBeNull()
	})

	it('batchGetLidForPn returns only mappings that exist', () => {
		const backend = new JidMapBackend(store.handle('msgstore.db'))
		backend.storeMappingsBatch([
			{ pnUser: '111@s.whatsapp.net', lidUser: '11000@lid' },
			{ pnUser: '222@s.whatsapp.net', lidUser: '22000@lid' }
		])

		const got = backend.batchGetLidForPn(['111@s.whatsapp.net', '222@s.whatsapp.net', '333@s.whatsapp.net'])
		expect(got).toEqual({ '111@s.whatsapp.net': '11000@lid', '222@s.whatsapp.net': '22000@lid' })
	})

	it('reserves a strictly monotonic sort_id range for a batch', () => {
		const backend = new JidMapBackend(store.handle('msgstore.db'))
		backend.storeMappingsBatch([
			{ pnUser: '111@s.whatsapp.net', lidUser: '11000@lid' },
			{ pnUser: '111@s.whatsapp.net', lidUser: '11001@lid' },
			{ pnUser: '111@s.whatsapp.net', lidUser: '11002@lid' }
		])

		const rows = store
			.handle('msgstore.db')
			.prepare('SELECT sort_id FROM jid_map ORDER BY sort_id ASC')
			.all() as Array<{ sort_id: number }>
		expect(rows.map(row => row.sort_id)).toHaveLength(3)
		expect(new Set(rows.map(row => row.sort_id)).size).toBe(3)
		expect(backend.getLidForPn('111@s.whatsapp.net')).toBe('11002@lid')
	})

	it('wrapKeysWithJidMap intercepts lid-mapping get + set, delegates rest', async () => {
		const inner = makeInnerStub()
		const backend = new JidMapBackend(store.handle('msgstore.db'))
		const wrapped = wrapKeysWithJidMap(inner, backend)

		const pn = '5515991426667@s.whatsapp.net'
		const lid = '46802258641027@lid'

		await wrapped.set({
			'lid-mapping': {
				[pn]: lid,
				[`${lid}${REVERSE_SUFFIX}`]: pn
			}
		} as never)

		const got = await wrapped.get('lid-mapping' as never, [pn, `${lid}${REVERSE_SUFFIX}`])
		expect(got[pn]).toBe(lid)
		expect(got[`${lid}${REVERSE_SUFFIX}`]).toBe(pn)

		// Non-lid-mapping types fall through to inner.set
		await wrapped.set({ session: { x: Buffer.from([1]) as Uint8Array } } as never)
		expect(inner._calls).toContain('inner.set')
	})

	it('does NOT call inner.set when the set payload only contains lid-mapping', async () => {
		const inner = makeInnerStub()
		const backend = new JidMapBackend(store.handle('msgstore.db'))
		const wrapped = wrapKeysWithJidMap(inner, backend)

		await wrapped.set({
			'lid-mapping': {
				'5515991426667@s.whatsapp.net': '46802258641027@lid',
				[`46802258641027@lid${REVERSE_SUFFIX}`]: '5515991426667@s.whatsapp.net'
			}
		} as never)

		expect(inner._calls).not.toContain('inner.set')
	})

	it('marks lid_chat_state.is_pn_shared at the wrapper choke point (covers every storeLIDPNMappings path)', async () => {
		const inner = makeInnerStub()
		const db = store.handle('msgstore.db')
		const backend = new JidMapBackend(db)
		const lidChatState = new LidChatStateBackend(db, backend)
		const wrapped = wrapKeysWithJidMap(inner, backend, lidChatState)

		const pn = '5515991426667@s.whatsapp.net'
		const lid = '46802258641027@lid'
		await wrapped.set({
			'lid-mapping': { [pn]: lid, [`${lid}${REVERSE_SUFFIX}`]: pn }
		} as never)

		// The LID whose PN was just persisted is marked is_pn_shared — on the SAME
		// jid row storeMapping resolved, so a single set() covers it end-to-end.
		const jidRowId = backend.resolveJidRowId(lid)
		const row = db.prepare('SELECT is_pn_shared FROM lid_chat_state WHERE jid_row_id = ?').get(jidRowId) as
			| { is_pn_shared: number }
			| undefined
		expect(row?.is_pn_shared).toBe(1)
	})
})
