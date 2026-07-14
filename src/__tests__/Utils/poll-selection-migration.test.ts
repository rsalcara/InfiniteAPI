import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	JidMapBackend,
	MessageAddOnBackend,
	MessageStoreBackend,
	MultiDbSqliteStore
} from '../../Utils/multi-db-sqlite'

describe('msgstore.db migration v2 — poll selection repair', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'poll-selection-mig-'))
	})

	afterEach(async () => {
		store?.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('deduplicates legacy selections and recomputes vote_total before adding the unique index', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const db = store.handle('msgstore.db')
		const jidMap = new JidMapBackend(db)
		const messages = new MessageStoreBackend(db, jidMap)
		const addOns = new MessageAddOnBackend(db, jidMap, messages)
		const chatJid = '5515991426667@s.whatsapp.net'
		const parentMessageRowId = messages.recordMessage({ chatJid, fromMe: true, keyId: 'POLL-MIG', timestamp: 1_000 })
		addOns.recordPoll({ messageRowId: parentMessageRowId })
		const optionId = addOns.recordPollOption({
			messageRowId: parentMessageRowId,
			optionSha256: 'option-a',
			optionName: 'A'
		})
		addOns.recordPollVote({
			chatJid,
			fromMe: false,
			keyId: 'VOTE-MIG',
			parentMessageRowId,
			timestamp: 1_100,
			senderTimestamp: 1_100,
			selectedOptionRowIds: [optionId]
		})

		const vote = db.prepare('SELECT _id FROM message_add_on WHERE key_id = ?').get('VOTE-MIG') as { _id: number }
		db.exec('DROP INDEX message_add_on_poll_vote_selected_option_unique_idx')
		db.prepare(
			'INSERT INTO message_add_on_poll_vote_selected_option (message_add_on_row_id, message_poll_option_id) VALUES (?, ?)'
		).run(vote._id, optionId)
		db.prepare('UPDATE message_poll_option SET vote_total = 2 WHERE _id = ?').run(optionId)
		db.prepare('DELETE FROM schema_migrations WHERE version = 2').run()
		store.close()
		store = undefined

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const migrated = store.handle('msgstore.db')
		expect(
			migrated
				.prepare(
					'SELECT COUNT(*) AS selections, (SELECT vote_total FROM message_poll_option WHERE _id = ?) AS total ' +
						'FROM message_add_on_poll_vote_selected_option WHERE message_add_on_row_id = ? AND message_poll_option_id = ?'
				)
				.get(optionId, vote._id, optionId)
		).toMatchObject({ selections: 1, total: 1 })
		expect(() =>
			migrated
				.prepare(
					'INSERT INTO message_add_on_poll_vote_selected_option (message_add_on_row_id, message_poll_option_id) VALUES (?, ?)'
				)
				.run(vote._id, optionId)
		).toThrow()
	})
})
