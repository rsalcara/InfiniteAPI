/**
 * Backend smoke tests for the msgstore.db message-store mirror:
 *
 *   - `MessageStoreBackend` — message + chat + message_details/_secret/_revoked
 *   - `ReceiptBackend` — receipt_user + receipt_device + receipt_orphaned
 *   - `MessageMediaBackend` — message_media + message_thumbnail + audio_data
 *   - `MessageAddOnBackend` — reactions, polls + poll votes, location, vcard
 *
 * One file covers all four since they share setup/teardown (a single
 * MultiDbSqliteStore handle + JidMapBackend against msgstore.db).
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
	JidMapBackend,
	LidChatStateBackend,
	MessageAddOnBackend,
	MessageMediaBackend,
	MessageStoreBackend,
	MultiDbSqliteStore,
	ReceiptBackend,
	UI_ELEMENT_TYPE
} from '../../Utils/multi-db-sqlite'

describe('msgstore.db message-store backends', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let jidMap: JidMapBackend

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'message-store-backends-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		jidMap = new JidMapBackend(store.handle('msgstore.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	describe('MessageStoreBackend', () => {
		it('records a message and its chat aggregate, upserting on retry', () => {
			const backend = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const chatJid = '5515991426667@s.whatsapp.net'

			const rowId = backend.recordMessage({
				chatJid,
				fromMe: false,
				keyId: 'MSG-1',
				senderJid: chatJid,
				status: 4,
				timestamp: 1_000,
				receivedTimestamp: 1_001,
				messageType: 0,
				textData: 'oi',
				incrementUnread: true
			})
			expect(typeof rowId).toBe('number')

			// Retry with the same natural key must upsert, not duplicate.
			const rowId2 = backend.recordMessage({
				chatJid,
				fromMe: false,
				keyId: 'MSG-1',
				senderJid: chatJid,
				status: 5,
				timestamp: 1_000,
				receivedTimestamp: 1_050,
				messageType: 0,
				textData: 'oi',
				incrementUnread: false // must NOT double-count unread on retry
			})
			expect(rowId2).toBe(rowId)

			const row = backend.getMessageByKeyId(chatJid, false, 'MSG-1')
			expect(row).toMatchObject({ status: 5, text_data: 'oi' })

			const chat = store
				.handle('msgstore.db')
				.prepare(
					'SELECT unseen_message_count, last_message_row_id FROM chat WHERE _id = (SELECT chat_row_id FROM message WHERE _id = ?)'
				)
				.get(rowId) as any
			expect(chat.unseen_message_count).toBe(1)
			expect(chat.last_message_row_id).toBe(rowId)
		})

		it('does not move the chat last-message pointer backwards for older history', () => {
			const backend = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const chatJid = '5515991426667@s.whatsapp.net'
			const newest = backend.recordMessage({
				chatJid,
				fromMe: false,
				keyId: 'NEWEST',
				timestamp: 2_000,
				incrementUnread: true
			})
			backend.recordMessage({
				chatJid,
				fromMe: false,
				keyId: 'OLDER-HISTORY',
				timestamp: 1_000,
				incrementUnread: true
			})

			const chat = store
				.handle('msgstore.db')
				.prepare('SELECT last_message_row_id, sort_timestamp, last_message_sort_id, unseen_message_count FROM chat')
				.get() as any
			expect(chat).toMatchObject({
				last_message_row_id: newest,
				sort_timestamp: 2_000,
				last_message_sort_id: 2_000,
				unseen_message_count: 2
			})
		})

		it('recordRevoke updates the target row to the tombstone type and links message_revoked', () => {
			const backend = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const chatJid = '5515991426667@s.whatsapp.net'
			backend.recordMessage({ chatJid, fromMe: true, keyId: 'MSG-REVOKE', timestamp: 1_000, textData: 'oops' })

			backend.recordRevoke({ chatJid, fromMe: true, revokedKeyId: 'MSG-REVOKE', revokeTimestamp: 2_000 })

			const row = backend.getMessageByKeyId(chatJid, true, 'MSG-REVOKE')
			expect(row?.message_type).toBe(15)
			expect(row?.text_data).toBeNull()

			const revoked = store
				.handle('msgstore.db')
				.prepare('SELECT * FROM message_revoked WHERE message_row_id = ?')
				.get(row!._id) as any
			expect(revoked).toMatchObject({ revoked_key_id: 'MSG-REVOKE', revoke_timestamp: 2_000 })
		})

		it('recordRevoke is a no-op (does not throw) when the target message is unknown', () => {
			const backend = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			expect(() =>
				backend.recordRevoke({
					chatJid: 'unknown@s.whatsapp.net',
					fromMe: true,
					revokedKeyId: 'NEVER-SEEN',
					revokeTimestamp: 1_000
				})
			).not.toThrow()
		})

		it('getMessageByKeyId is a pure read — never materializes a jid row for an unknown chat', () => {
			const backend = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const db = store.handle('msgstore.db')
			const before = (db.prepare('SELECT COUNT(*) AS n FROM jid').get() as { n: number }).n

			expect(backend.getMessageByKeyId('never-messaged@s.whatsapp.net', false, 'NO-MSG')).toBeNull()

			const after = (db.prepare('SELECT COUNT(*) AS n FROM jid').get() as { n: number }).n
			expect(after).toBe(before) // no phantom jid row created on a read miss
		})
	})

	describe('ReceiptBackend', () => {
		it('records a user receipt progression (delivery then read)', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const receipts = new ReceiptBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			messageStore.recordMessage({ chatJid, fromMe: true, keyId: 'MSG-R1', timestamp: 1_000 })

			receipts.recordUserReceipt({
				chatJid,
				fromMe: true,
				keyId: 'MSG-R1',
				receiptUserJid: chatJid,
				kind: 'delivery',
				timestamp: 1_100
			})
			receipts.recordUserReceipt({
				chatJid,
				fromMe: true,
				keyId: 'MSG-R1',
				receiptUserJid: chatJid,
				kind: 'read',
				timestamp: 1_200
			})

			const row = messageStore.getMessageByKeyId(chatJid, true, 'MSG-R1')
			const userReceipts = receipts.listUserReceipts(row!._id)
			expect(userReceipts).toHaveLength(1) // same (message, user) upserts, doesn't duplicate
			expect(userReceipts[0]).toMatchObject({ receipt_timestamp: 1_100, read_timestamp: 1_200 })
		})

		it('records a device receipt', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const receipts = new ReceiptBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			messageStore.recordMessage({ chatJid, fromMe: true, keyId: 'MSG-D1', timestamp: 1_000 })

			receipts.recordDeviceReceipt({
				chatJid,
				fromMe: true,
				keyId: 'MSG-D1',
				receiptDeviceJid: `${chatJid.split('@')[0]}.0:5@s.whatsapp.net`,
				timestamp: 1_100
			})

			const row = messageStore.getMessageByKeyId(chatJid, true, 'MSG-D1')
			expect(receipts.listDeviceReceipts(row!._id)).toHaveLength(1)
		})

		it('falls back to receipt_orphaned when the target message is unknown', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const receipts = new ReceiptBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = 'unknown@s.whatsapp.net'

			expect(() =>
				receipts.recordUserReceipt({
					chatJid,
					fromMe: true,
					keyId: 'NEVER-SEEN',
					receiptUserJid: chatJid,
					kind: 'delivery',
					timestamp: 1_000
				})
			).not.toThrow()

			const orphaned = store.handle('msgstore.db').prepare('SELECT * FROM receipt_orphaned').all() as any[]
			expect(orphaned).toHaveLength(1)
			expect(orphaned[0]).toMatchObject({ key_id: 'NEVER-SEEN' })
		})

		it('replays an orphaned receipt with its original kind after the message arrives', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const receipts = new ReceiptBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			receipts.recordUserReceipt({
				chatJid,
				fromMe: true,
				keyId: 'LATE-MESSAGE',
				receiptUserJid: chatJid,
				kind: 'read',
				timestamp: 1_200
			})
			const messageRowId = messageStore.recordMessage({
				chatJid,
				fromMe: true,
				keyId: 'LATE-MESSAGE',
				timestamp: 1_000
			})

			expect(receipts.replayOrphaned(chatJid, true, 'LATE-MESSAGE')).toBe(1)
			expect(receipts.listUserReceipts(messageRowId)[0]).toMatchObject({ read_timestamp: 1_200 })
			expect(store.handle('msgstore.db').prepare('SELECT COUNT(*) AS n FROM receipt_orphaned').get()).toMatchObject({
				n: 0
			})
		})

		it('routes a device receipt for an add-on (reaction) to message_add_on_receipt_device', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const receipts = new ReceiptBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const parentRowId = messageStore.recordMessage({
				chatJid,
				fromMe: true,
				keyId: 'MSG-PARENT-AR',
				timestamp: 1_000
			})

			// A reaction we sent, addressed by its OWN key id (a message_add_on row,
			// not a message row).
			addOns.recordReaction({
				chatJid,
				fromMe: true,
				keyId: 'REACT-1',
				parentMessageRowId: parentRowId,
				timestamp: 1_050,
				reaction: '👍',
				senderTimestamp: 1_050
			})

			// A device receipt whose target is the reaction — must land in the
			// add-on receipt table, NOT receipt_orphaned.
			receipts.recordDeviceReceipt({
				chatJid,
				fromMe: true,
				keyId: 'REACT-1',
				receiptDeviceJid: `${chatJid.split('@')[0]}:5@s.whatsapp.net`,
				timestamp: 1_100
			})

			const db = store.handle('msgstore.db')
			expect(db.prepare('SELECT COUNT(*) AS n FROM message_add_on_receipt_device').get()).toMatchObject({ n: 1 })
			expect(db.prepare('SELECT COUNT(*) AS n FROM receipt_orphaned').get()).toMatchObject({ n: 0 })

			// Idempotent per device (upsert, not a duplicate row).
			receipts.recordDeviceReceipt({
				chatJid,
				fromMe: true,
				keyId: 'REACT-1',
				receiptDeviceJid: `${chatJid.split('@')[0]}:5@s.whatsapp.net`,
				timestamp: 1_200
			})
			expect(db.prepare('SELECT COUNT(*) AS n FROM message_add_on_receipt_device').get()).toMatchObject({ n: 1 })
		})
	})

	describe('MessageMediaBackend', () => {
		it('records media metadata, thumbnail, and audio waveform', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const media = new MessageMediaBackend(store.handle('msgstore.db'))
			const chatJid = '5515991426667@s.whatsapp.net'
			const rowId = messageStore.recordMessage({ chatJid, fromMe: false, keyId: 'MSG-MEDIA', timestamp: 1_000 })

			media.recordMedia({
				messageRowId: rowId,
				mimeType: 'image/jpeg',
				fileLength: 12_345,
				mediaKey: Buffer.from([1, 2, 3]),
				fileSha256: Buffer.from([4, 5, 6]),
				width: 1280,
				height: 720,
				caption: 'a photo'
			})
			media.recordThumbnail({ messageRowId: rowId, thumbnail: Buffer.from([9, 9, 9]) })
			media.recordAudioData({ messageRowId: rowId, waveform: Buffer.from([1, 1, 1]) })

			const mediaRow = store
				.handle('msgstore.db')
				.prepare('SELECT * FROM message_media WHERE message_row_id = ?')
				.get(rowId) as any
			expect(mediaRow).toMatchObject({ mime_type: 'image/jpeg', width: 1280, height: 720, media_caption: 'a photo' })

			const thumb = store
				.handle('msgstore.db')
				.prepare('SELECT thumbnail FROM message_thumbnail WHERE message_row_id = ?')
				.get(rowId) as any
			expect(Buffer.from(thumb.thumbnail)).toEqual(Buffer.from([9, 9, 9]))
		})

		it('recordAudioData is a no-op when no waveform is provided', () => {
			const media = new MessageMediaBackend(store.handle('msgstore.db'))
			media.recordAudioData({ messageRowId: 1, waveform: null })
			const rows = store.handle('msgstore.db').prepare('SELECT * FROM audio_data').all()
			expect(rows).toHaveLength(0)
		})
	})

	describe('MessageAddOnBackend', () => {
		it('records a reaction linked to its parent message', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const parentRowId = messageStore.recordMessage({ chatJid, fromMe: false, keyId: 'MSG-PARENT', timestamp: 1_000 })

			addOns.recordReaction({
				chatJid,
				fromMe: false,
				keyId: 'REACTION-1',
				senderJid: chatJid,
				parentMessageRowId: parentRowId,
				timestamp: 1_100,
				reaction: '❤️',
				senderTimestamp: 1_100
			})

			const addOnRow = store
				.handle('msgstore.db')
				.prepare('SELECT * FROM message_add_on WHERE key_id = ?')
				.get('REACTION-1') as any
			expect(addOnRow).toMatchObject({ parent_message_row_id: parentRowId })

			const reactionRow = store
				.handle('msgstore.db')
				.prepare('SELECT * FROM message_add_on_reaction WHERE message_add_on_row_id = ?')
				.get(addOnRow._id) as any
			expect(reactionRow.reaction).toBe('❤️')
		})

		it('records a poll, its options, and a vote that updates vote_total', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const pollRowId = messageStore.recordMessage({ chatJid, fromMe: true, keyId: 'MSG-POLL', timestamp: 1_000 })

			addOns.recordPoll({ messageRowId: pollRowId, selectableOptionsCount: 1 })
			const optA = addOns.recordPollOption({ messageRowId: pollRowId, optionSha256: 'hashA', optionName: 'Option A' })
			const optB = addOns.recordPollOption({ messageRowId: pollRowId, optionSha256: 'hashB', optionName: 'Option B' })

			addOns.recordPollVote({
				chatJid,
				fromMe: false,
				keyId: 'VOTE-1',
				senderJid: chatJid,
				parentMessageRowId: pollRowId,
				timestamp: 1_100,
				senderTimestamp: 1_100,
				selectedOptionRowIds: [optA]
			})

			let optionRows = store
				.handle('msgstore.db')
				.prepare('SELECT _id, vote_total FROM message_poll_option WHERE message_row_id = ?')
				.all(pollRowId) as any[]
			expect(optionRows.find(r => r._id === optA)?.vote_total).toBe(1)
			expect(optionRows.find(r => r._id === optB)?.vote_total).toBe(0)

			// Vote update — voter changes their mind to option B. Must replace, not add.
			addOns.recordPollVote({
				chatJid,
				fromMe: false,
				keyId: 'VOTE-1',
				senderJid: chatJid,
				parentMessageRowId: pollRowId,
				timestamp: 1_200,
				senderTimestamp: 1_200,
				selectedOptionRowIds: [optB]
			})

			optionRows = store
				.handle('msgstore.db')
				.prepare('SELECT _id, vote_total FROM message_poll_option WHERE message_row_id = ?')
				.all(pollRowId) as any[]
			expect(optionRows.find(r => r._id === optA)?.vote_total).toBe(0) // decremented — voter moved away from A
			expect(optionRows.find(r => r._id === optB)?.vote_total).toBe(1)
		})

		it('deduplicates poll selections and rejects an option from another poll', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const pollA = messageStore.recordMessage({ chatJid, fromMe: true, keyId: 'POLL-A', timestamp: 1_000 })
			const pollB = messageStore.recordMessage({ chatJid, fromMe: true, keyId: 'POLL-B', timestamp: 1_001 })
			const optionA = addOns.recordPollOption({ messageRowId: pollA, optionSha256: 'a', optionName: 'A' })
			const optionB = addOns.recordPollOption({ messageRowId: pollB, optionSha256: 'b', optionName: 'B' })

			addOns.recordPollVote({
				chatJid,
				fromMe: false,
				keyId: 'VOTE-DEDUP',
				senderJid: chatJid,
				parentMessageRowId: pollA,
				timestamp: 1_100,
				senderTimestamp: 1_100,
				selectedOptionRowIds: [optionA, optionA]
			})
			expect(
				store.handle('msgstore.db').prepare('SELECT vote_total FROM message_poll_option WHERE _id = ?').get(optionA)
			).toMatchObject({ vote_total: 1 })

			expect(() =>
				addOns.recordPollVote({
					chatJid,
					fromMe: false,
					keyId: 'VOTE-CROSS-POLL',
					senderJid: chatJid,
					parentMessageRowId: pollA,
					timestamp: 1_200,
					senderTimestamp: 1_200,
					selectedOptionRowIds: [optionB]
				})
			).toThrow('does not belong to parent message')
		})

		it('records a location and a vcard attached to a message', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const locRowId = messageStore.recordMessage({ chatJid, fromMe: false, keyId: 'MSG-LOC', timestamp: 1_000 })
			const vcardRowId = messageStore.recordMessage({ chatJid, fromMe: false, keyId: 'MSG-VCARD', timestamp: 1_001 })

			addOns.recordLocation({ messageRowId: locRowId, chatJid, latitude: -23.5, longitude: -46.6, placeName: 'SP' })
			addOns.recordVcard({ messageRowId: vcardRowId, vcard: 'BEGIN:VCARD\nEND:VCARD' })

			const locRow = store
				.handle('msgstore.db')
				.prepare('SELECT * FROM message_location WHERE message_row_id = ?')
				.get(locRowId) as any
			expect(locRow).toMatchObject({ latitude: -23.5, longitude: -46.6, place_name: 'SP' })

			const vcardRow = store
				.handle('msgstore.db')
				.prepare('SELECT * FROM message_vcard WHERE message_row_id = ?')
				.get(vcardRowId) as any
			expect(vcardRow.vcard).toContain('BEGIN:VCARD')
		})

		it('materializes the vCard embedded WA jids into message_vcard_jid', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const rowId = messageStore.recordMessage({ chatJid, fromMe: false, keyId: 'MSG-VCARD-JIDS', timestamp: 2_000 })

			// A vCard carrying two contactable numbers (two `waid=` params).
			const vcard =
				'BEGIN:VCARD\nVERSION:3.0\nFN:Ana\n' +
				'TEL;type=CELL;waid=5511999999999:+55 11 99999-9999\n' +
				'TEL;type=CELL;waid=5511888888888:+55 11 88888-8888\nEND:VCARD'
			addOns.recordVcard({ messageRowId: rowId, vcard })

			const db = store.handle('msgstore.db')
			const jidRows = db
				.prepare(
					'SELECT j.raw_string AS raw FROM message_vcard_jid mvj ' +
						'JOIN jid j ON j._id = mvj.vcard_jid_row_id WHERE mvj.message_row_id = ? ORDER BY mvj._id'
				)
				.all(rowId) as Array<{ raw: string }>
			expect(jidRows.map(r => r.raw)).toEqual(['5511999999999@s.whatsapp.net', '5511888888888@s.whatsapp.net'])

			// Idempotent: re-recording the same vcard must not duplicate jids.
			addOns.recordVcard({ messageRowId: rowId, vcard })
			const count = db.prepare('SELECT COUNT(*) AS n FROM message_vcard_jid WHERE message_row_id = ?').get(rowId) as {
				n: number
			}
			expect(count.n).toBe(2)
		})

		it('backfills message_vcard_jid for a card that exists without jids', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const rowId = messageStore.recordMessage({ chatJid, fromMe: false, keyId: 'MSG-VCARD-BF', timestamp: 2_500 })
			const vcard = 'BEGIN:VCARD\nTEL;type=CELL;waid=5511777777777:+55 11 77777-7777\nEND:VCARD'

			// Simulate a card recorded before jid extraction existed: insert the
			// message_vcard row directly, with NO jids.
			store
				.handle('msgstore.db')
				.prepare('INSERT INTO message_vcard (message_row_id, vcard) VALUES (?, ?)')
				.run(rowId, vcard)

			// A later reprocess must backfill the jids (not early-return).
			addOns.recordVcard({ messageRowId: rowId, vcard })
			const count = store
				.handle('msgstore.db')
				.prepare('SELECT COUNT(*) AS n FROM message_vcard_jid WHERE message_row_id = ?')
				.get(rowId) as { n: number }
			expect(count.n).toBe(1)
		})

		it('records interactive UI elements and reads them back (replace-on-redecode)', () => {
			const messageStore = new MessageStoreBackend(store.handle('msgstore.db'), jidMap)
			const addOns = new MessageAddOnBackend(store.handle('msgstore.db'), jidMap, messageStore)
			const chatJid = '5515991426667@s.whatsapp.net'
			const rowId = messageStore.recordMessage({ chatJid, fromMe: false, keyId: 'MSG-UI', timestamp: 3_000 })

			addOns.recordUiElements(rowId, [
				{ elementType: UI_ELEMENT_TYPE.QUICK_REPLY, buttonText: 'Yes', elementContent: 'id-yes', footerText: 'ft' },
				{ elementType: UI_ELEMENT_TYPE.QUICK_REPLY, buttonText: 'No', elementContent: 'id-no', footerText: 'ft' }
			])

			const read = addOns.getUiElements(rowId)
			expect(read.map(e => e.buttonText)).toEqual(['Yes', 'No'])
			expect(read[0]).toMatchObject({
				elementType: UI_ELEMENT_TYPE.QUICK_REPLY,
				elementContent: 'id-yes',
				footerText: 'ft'
			})

			addOns.recordUiElements(rowId, [
				{
					elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
					buttonText: 'First',
					elementContent: '{"id":"first"}',
					nativeFlowName: 'quick_reply',
					context: { containerType: 'carousel', cardIndex: 0, buttonIndex: 0 }
				},
				{
					elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
					buttonText: 'Second',
					elementContent: '{"id":"second"}',
					nativeFlowName: 'quick_reply',
					context: { containerType: 'carousel', cardIndex: 1, buttonIndex: 0 }
				}
			])
			expect(addOns.getUiElementsWithContext(rowId).map(e => e.context)).toEqual([
				{ containerType: 'carousel', cardIndex: 0, buttonIndex: 0 },
				{ containerType: 'carousel', cardIndex: 1, buttonIndex: 0 }
			])
			expect(addOns.getUiElementsWithContext(rowId).map(e => e.nativeFlowName)).toEqual(['quick_reply', 'quick_reply'])
			// The compatibility reader retains its original row shape.
			expect(addOns.getUiElements(rowId)[0]).not.toHaveProperty('context')

			// A context failure rolls the entire replacement back. Existing buttons
			// remain available to both readers instead of exposing a partial layout.
			expect(() =>
				addOns.recordUiElements(rowId, [
					{
						elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
						buttonText: 'Invalid',
						context: { containerType: 'carousel', cardIndex: -1, buttonIndex: 0 }
					}
				])
			).toThrow()
			expect(addOns.getUiElements(rowId).map(e => e.buttonText)).toEqual(['First', 'Second'])
			expect(addOns.getUiElementsWithContext(rowId).map(e => e.context)).toEqual([
				{ containerType: 'carousel', cardIndex: 0, buttonIndex: 0 },
				{ containerType: 'carousel', cardIndex: 1, buttonIndex: 0 }
			])

			// Replace-on-redecode: re-recording swaps the set, never duplicates.
			addOns.recordUiElements(rowId, [{ elementType: UI_ELEMENT_TYPE.LIST, buttonText: 'Open' }])
			expect(addOns.getUiElements(rowId).map(e => e.buttonText)).toEqual(['Open'])
			const contextCount = store
				.handle('msgstore.db')
				.prepare('SELECT COUNT(*) AS n FROM message_ui_element_context')
				.get() as { n: number }
			expect(contextCount.n).toBe(0)

			// Root native-flow buttons preserve their internal action key without
			// pretending it is the user-visible label or carousel context.
			addOns.recordUiElements(rowId, [
				{
					elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
					buttonText: 'Visit',
					elementContent: '{"display_text":"Visit","url":"https://example.com"}',
					nativeFlowName: 'cta_url'
				}
			])
			const rootNative = addOns.getUiElementsWithContext(rowId)[0]
			expect(rootNative).toMatchObject({ buttonText: 'Visit', nativeFlowName: 'cta_url' })
			expect(rootNative).not.toHaveProperty('context')

			// An empty set CLEARS — a re-decode that yields no UI must not leave
			// stale rows behind.
			addOns.recordUiElements(rowId, [])
			expect(addOns.getUiElements(rowId)).toHaveLength(0)
		})
	})

	describe('LidChatStateBackend', () => {
		it('marks is_pn_shared idempotently (one row per LID) sharing the jid table', () => {
			const backend = new LidChatStateBackend(store.handle('msgstore.db'), jidMap)
			const lidUser = '123456789'

			backend.markPnShared(lidUser)
			backend.markPnShared(lidUser) // idempotent

			const db = store.handle('msgstore.db')
			const count = db.prepare('SELECT COUNT(*) AS n FROM lid_chat_state').get() as { n: number }
			expect(count.n).toBe(1)
			// The row hangs off the SAME jid row storeMapping would resolve for this LID.
			const jidRowId = jidMap.resolveJidRowId(lidUser)
			const row = db.prepare('SELECT is_pn_shared FROM lid_chat_state WHERE jid_row_id = ?').get(jidRowId) as {
				is_pn_shared: number
			}
			expect(row.is_pn_shared).toBe(1)
		})
	})
})
