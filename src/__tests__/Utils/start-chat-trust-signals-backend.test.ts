import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore, StartChatTrustSignalsBackend } from '../../Utils/multi-db-sqlite'

describe('StartChatTrustSignalsBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'start-chat-trust-backend-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('round-trips and upserts the two official CHAT_FMX observations', () => {
		const backend = new StartChatTrustSignalsBackend(store.handle('wa.db'))
		const jid = '46802258641027@lid'

		backend.save({ jid, isSenderSuspicious: false, isSenderNewAccount: true, observedAt: 1_000 })
		expect(backend.get(jid)).toEqual({
			jid,
			isSenderSuspicious: false,
			isSenderNewAccount: true,
			observedAt: 1_000
		})

		backend.save({ jid, isSenderSuspicious: true, isSenderNewAccount: false, observedAt: 2_000 })
		expect(backend.get(jid)).toEqual({
			jid,
			isSenderSuspicious: true,
			isSenderNewAccount: false,
			observedAt: 2_000
		})
		expect(backend.stats()).toEqual({ recordCount: 1 })
	})

	it('distinguishes absent server booleans from false', () => {
		const backend = new StartChatTrustSignalsBackend(store.handle('wa.db'))
		const jid = '185143255945217@lid'

		backend.save({ jid, isSenderNewAccount: false, observedAt: 3_000 })
		expect(backend.get(jid)).toEqual({
			jid,
			isSenderNewAccount: false,
			isSenderSuspicious: undefined,
			observedAt: 3_000
		})
	})

	it('removes the observation when the official contact trigger deletes wa_contacts', () => {
		const backend = new StartChatTrustSignalsBackend(store.handle('wa.db'))
		const db = store.handle('wa.db')
		const jid = '5511999999999@s.whatsapp.net'

		backend.save({ jid, isSenderSuspicious: false, isSenderNewAccount: false, observedAt: 4_000 })
		db.prepare('INSERT INTO wa_contacts (jid, is_whatsapp_user) VALUES (?, ?)').run(jid, 1)
		db.prepare('DELETE FROM wa_contacts WHERE jid = ?').run(jid)

		expect(backend.get(jid)).toBeNull()
		expect(backend.delete(jid)).toBe(false)
	})
})
