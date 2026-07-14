/**
 * Quarantine wiring — `createMessageQuarantineRecorder` glues
 * `JidMapBackend.resolveJidRowId` (chat/sender JID → `jid` row id) to
 * `MessageQuarantineBackend.quarantine` (the typed `message_quarantine`
 * insert). This is the function `SocketConfig.onMessageQuarantine` wraps —
 * `decode-wa-message.ts` only ever calls it with JID strings, never touches
 * row ids directly.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	createMessageQuarantineRecorder,
	MessageQuarantineBackend,
	MultiDbSqliteStore
} from '../../Utils/multi-db-sqlite'

describe('createMessageQuarantineRecorder', () => {
	let dir: string
	let store: MultiDbSqliteStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'quarantine-recorder-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('resolves chat/sender JIDs to jid row ids and persists a quarantine row', () => {
		const recorder = createMessageQuarantineRecorder({ store })

		recorder({
			chatJid: '120363000000000000@g.us',
			senderJid: '5511999999999@s.whatsapp.net',
			keyId: 'ABCDEF123',
			fromMe: false,
			originalProtobuf: Buffer.from([1, 2, 3]),
			serializedStanza: Buffer.from([9, 8, 7]),
			failureReason: 'Bad MAC'
		})

		const backend = new MessageQuarantineBackend(store.handle('msgstore.db'))
		const rows = backend.listSince(0)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.keyId).toBe('ABCDEF123')
		expect(rows[0]?.failureReason).toBe('Bad MAC')
		expect(rows[0]?.retryCount).toBe(1)
		// chat_row_id / sender_jid_row_id must be real jid-table ids, not 0
		expect(rows[0]?.chatRowId).toBeGreaterThan(0)
		expect(rows[0]?.senderJidRowId).toBeGreaterThan(0)
	})

	it('reuses the same jid row across calls and increments retry_count on repeat failures', () => {
		const recorder = createMessageQuarantineRecorder({ store })
		const record = {
			chatJid: '5511988887777@s.whatsapp.net',
			keyId: 'MSG-1',
			fromMe: false,
			failureReason: 'Bad MAC'
		}

		recorder(record)
		recorder({ ...record, failureReason: 'Bad MAC again' })

		const backend = new MessageQuarantineBackend(store.handle('msgstore.db'))
		const rows = backend.listByChat(backend.listSince(0)[0]!.chatRowId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.retryCount).toBe(2)
		expect(rows[0]?.failureReason).toBe('Bad MAC again')
	})

	it('omits sender_jid_row_id (defaults to 0) when no senderJid is given', () => {
		const recorder = createMessageQuarantineRecorder({ store })
		recorder({ chatJid: '5511977776666@s.whatsapp.net', keyId: 'MSG-2', fromMe: true })

		const backend = new MessageQuarantineBackend(store.handle('msgstore.db'))
		const rows = backend.listSince(0)
		expect(rows[0]?.senderJidRowId).toBe(0)
	})
})
