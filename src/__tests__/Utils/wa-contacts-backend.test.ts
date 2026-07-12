/**
 * `WaContactsBackend` smoke tests — the canonical mobile `wa_contacts` mirror
 * in `wa.db`. Exercises the row CRUD the socket wiring builds the LID+PN pair
 * on top of: upsert-by-jid (partial-update COALESCE), read, pair backfill, and
 * clear. The upsert also proves wa.db migration v2 ran (ON CONFLICT(jid) needs
 * the UNIQUE jid index the migration adds).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore, WaContactsBackend } from '../../Utils/multi-db-sqlite'

const PN = '5515991426667@s.whatsapp.net'
const LID = '46802258641027@lid'

describe('WaContactsBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: WaContactsBackend

	const countRows = () =>
		(store.handle('wa.db').prepare('SELECT COUNT(*) AS n FROM wa_contacts').get() as { n: number }).n

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'wa-contacts-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new WaContactsBackend(store.handle('wa.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('upserts a row and reads it back (is_whatsapp_user defaults to 1)', () => {
		backend.upsertRow({ jid: PN, waName: 'Renato', status: 'busy', username: 'renato' })
		const row = backend.getByJid(PN)
		expect(row).not.toBeNull()
		expect(row!.wa_name).toBe('Renato')
		expect(row!.status).toBe('busy')
		expect(row!.username).toBe('renato')
		expect(row!.is_whatsapp_user).toBe(1)
		expect(backend.getByJid('nobody@s.whatsapp.net')).toBeNull()
	})

	it('ON CONFLICT(jid) dedupes and a partial update never clobbers other fields (COALESCE)', () => {
		backend.upsertRow({ jid: PN, waName: 'Renato', status: 'busy', username: 'renato' })
		// A pushName-only update (status/username undefined) must keep the stored
		// values, not null them — this is the mobile per-field UPDATE behavior.
		backend.upsertRow({ jid: PN, waName: 'Renato Alcará' })
		expect(countRows()).toBe(1)

		const row = backend.getByJid(PN)!
		expect(row.wa_name).toBe('Renato Alcará')
		expect(row.status).toBe('busy')
		expect(row.username).toBe('renato')
	})

	it('backfills the LID↔PN pair via copyFieldsTo', () => {
		// Only the PN side was written (mapping unknown at event time).
		backend.upsertRow({ jid: PN, waName: 'Renato', username: 'renato' })
		expect(backend.getByJid(LID)).toBeNull()

		// Mapping resolves → backfill the LID row from the PN row.
		backend.copyFieldsTo(PN, LID)
		const lidRow = backend.getByJid(LID)
		expect(lidRow).not.toBeNull()
		expect(lidRow!.wa_name).toBe('Renato')
		expect(lidRow!.username).toBe('renato')
		expect(countRows()).toBe(2)

		// copyFieldsTo from a jid with no row is a no-op.
		backend.copyFieldsTo('ghost@s.whatsapp.net', PN)
		expect(countRows()).toBe(2)
	})

	it('clear wipes every row', () => {
		backend.upsertRow({ jid: PN, waName: 'a' })
		backend.upsertRow({ jid: LID, waName: 'a' })
		expect(countRows()).toBe(2)
		backend.clear()
		expect(countRows()).toBe(0)
	})
})
