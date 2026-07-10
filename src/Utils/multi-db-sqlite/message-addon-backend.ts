/**
 * Typed storage for msgstore.db's "add-on" family — reactions, poll votes,
 * polls, locations, and vcards attached to a message.
 *
 * Real Android capture (Frida, WhatsApp 2.26.22.8, 2026-07-09) confirms:
 *   - `message_add_on` is the parent row for BOTH reactions and poll
 *     votes — its own natural key is `(chat_row_id, from_me, key_id,
 *     sender_jid_row_id)`, same shape as `message`, because a reaction/
 *     vote is itself a distinct WhatsApp protocol message with its own
 *     key_id. `parent_message_row_id` links it back to the message being
 *     reacted to / voted on.
 *   - `message_add_on_reaction` / `message_add_on_poll_vote` are 1:1
 *     satellites on `message_add_on_row_id`.
 *   - `message_poll` / `message_poll_option` attach directly to the
 *     ORIGINAL poll-creation `message` row (not to `message_add_on`).
 *   - `message_location` attaches directly to the message row too.
 *   - `message_vcard`/`message_vcard_jid` likewise.
 *
 * `message_add_on_type` (Android's own enum distinguishing reaction vs.
 * poll-vote vs. other add-on kinds) has no value confirmed against the
 * capture with high confidence, so it's accepted as an optional caller-
 * supplied int rather than guessed here.
 */
import type { ChatRowResolver, JidResolver } from './message-store-backend'
import type { SqliteDbLike, SqliteStatementLike } from './types'

/** Same sentinel convention as message-store-backend.ts's NO_SENDER_SENTINEL — see that file's doc. */
const NO_SENDER_SENTINEL = 0

export type RecordAddOnInput = {
	chatJid: string
	fromMe: boolean
	keyId: string
	senderJid?: string | null
	parentMessageRowId: number
	timestamp: number
	addOnType?: number | null
}

export type RecordReactionInput = RecordAddOnInput & {
	reaction: string
	senderTimestamp: number
}

export type RecordPollVoteInput = RecordAddOnInput & {
	senderTimestamp: number
	/** row_id of each `message_poll_option` the voter selected. */
	selectedOptionRowIds: number[]
}

export type RecordPollInput = {
	messageRowId: number
	encKey?: Buffer | null
	selectableOptionsCount?: number | null
}

export type RecordPollOptionInput = {
	messageRowId: number
	optionSha256: string
	optionName: string
}

export type RecordLocationInput = {
	messageRowId: number
	chatJid: string
	latitude: number
	longitude: number
	placeName?: string | null
	placeAddress?: string | null
	url?: string | null
	liveLocationShareDurationSecs?: number | null
	liveLocationSequenceNumber?: number | null
}

export type RecordVcardInput = {
	messageRowId: number
	vcard: string
}

/**
 * One parsed interactive-UI element (a button / list / template row) attached
 * to a message, for rendering. Mirrors msgstore.db's `message_ui_elements`.
 * `elementType` is a best-effort classifier (not Frida-confirmed against the
 * mobile enum), same caveat as `message_add_on.message_add_on_type`.
 */
export type RecordUiElementInput = {
	messageRowId: number
	elementType?: number | null
	elementContent?: string | null
	description?: string | null
	templateId?: string | null
	hsmTag?: string | null
	footerText?: string | null
	buttonText?: string | null
	messageType?: number | null
}

/** Best-effort element_type classifier for message_ui_elements. */
export const UI_ELEMENT_TYPE = {
	QUICK_REPLY: 1,
	LIST: 2,
	TEMPLATE: 3,
	NATIVE_FLOW: 4
} as const

/**
 * Extracts the WhatsApp JIDs embedded in a vCard's TEL lines. WhatsApp tags
 * each contactable number with a `waid=<e164>` parameter, e.g.
 * `TEL;type=CELL;waid=5511999999999:+55 11 99999-9999`. Each `waid` is the
 * user part of an `@s.whatsapp.net` JID. Deduplicated, order-preserving.
 */
const parseVcardWaids = (vcard: string): string[] => {
	const jids: string[] = []
	const seen = new Set<string>()
	const re = /waid=(\d+)/g
	let m: RegExpExecArray | null
	while ((m = re.exec(vcard)) !== null) {
		const jid = `${m[1]}@s.whatsapp.net`
		if (!seen.has(jid)) {
			seen.add(jid)
			jids.push(jid)
		}
	}

	return jids
}

export class MessageAddOnBackend {
	private readonly stmts: {
		upsertAddOn: SqliteStatementLike
		getAddOnRowId: SqliteStatementLike
		upsertReaction: SqliteStatementLike
		upsertPollVote: SqliteStatementLike
		getPollVoteSelectedOptions: SqliteStatementLike
		insertPollVoteSelectedOption: SqliteStatementLike
		deletePollVoteSelectedOptions: SqliteStatementLike
		incrementPollOptionVoteTotal: SqliteStatementLike
		upsertPoll: SqliteStatementLike
		insertPollOption: SqliteStatementLike
		getPollOptionRowId: SqliteStatementLike
		upsertLocation: SqliteStatementLike
		insertVcard: SqliteStatementLike
		getVcardRowId: SqliteStatementLike
		insertVcardJid: SqliteStatementLike
		countVcardJids: SqliteStatementLike
		insertUiElement: SqliteStatementLike
		deleteUiElements: SqliteStatementLike
		getUiElements: SqliteStatementLike
	}

	private readonly db: SqliteDbLike
	private readonly jidMap: JidResolver
	private readonly chatResolver: ChatRowResolver

	constructor(db: SqliteDbLike, jidMap: JidResolver, chatResolver: ChatRowResolver) {
		this.db = db
		this.jidMap = jidMap
		this.chatResolver = chatResolver
		this.stmts = {
			upsertAddOn: this.db.prepare(
				'INSERT INTO message_add_on (chat_row_id, from_me, key_id, sender_jid_row_id, parent_message_row_id, ' +
					'timestamp, message_add_on_type) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
					'ON CONFLICT(chat_row_id, from_me, key_id, sender_jid_row_id) DO UPDATE SET timestamp = excluded.timestamp'
			),
			getAddOnRowId: this.db.prepare(
				'SELECT _id FROM message_add_on WHERE chat_row_id = ? AND from_me = ? AND key_id = ? AND sender_jid_row_id IS ?'
			),
			upsertReaction: this.db.prepare(
				'INSERT INTO message_add_on_reaction (message_add_on_row_id, reaction, sender_timestamp) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_add_on_row_id) DO UPDATE SET reaction = excluded.reaction, ' +
					'sender_timestamp = excluded.sender_timestamp'
			),
			upsertPollVote: this.db.prepare(
				'INSERT INTO message_add_on_poll_vote (message_add_on_row_id, sender_timestamp) VALUES (?, ?) ' +
					'ON CONFLICT(message_add_on_row_id) DO UPDATE SET sender_timestamp = excluded.sender_timestamp'
			),
			getPollVoteSelectedOptions: this.db.prepare(
				'SELECT message_poll_option_id FROM message_add_on_poll_vote_selected_option WHERE message_add_on_row_id = ?'
			),
			insertPollVoteSelectedOption: this.db.prepare(
				'INSERT INTO message_add_on_poll_vote_selected_option (message_add_on_row_id, message_poll_option_id) VALUES (?, ?)'
			),
			deletePollVoteSelectedOptions: this.db.prepare(
				'DELETE FROM message_add_on_poll_vote_selected_option WHERE message_add_on_row_id = ?'
			),
			incrementPollOptionVoteTotal: this.db.prepare(
				'UPDATE message_poll_option SET vote_total = vote_total + ? WHERE _id = ?'
			),
			upsertPoll: this.db.prepare(
				'INSERT INTO message_poll (message_row_id, enc_key, selectable_options_count) VALUES (?, ?, ?) ' +
					'ON CONFLICT(message_row_id) DO UPDATE SET enc_key = excluded.enc_key, ' +
					'selectable_options_count = excluded.selectable_options_count'
			),
			insertPollOption: this.db.prepare(
				'INSERT INTO message_poll_option (message_row_id, option_sha256, option_name, vote_total) VALUES (?, ?, ?, 0)'
			),
			getPollOptionRowId: this.db.prepare(
				'SELECT _id FROM message_poll_option WHERE message_row_id = ? AND option_sha256 = ?'
			),
			upsertLocation: this.db.prepare(
				'INSERT INTO message_location (message_row_id, chat_row_id, latitude, longitude, place_name, ' +
					'place_address, url, live_location_share_duration, live_location_sequence_number) ' +
					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_row_id) DO UPDATE SET ' +
					'latitude = excluded.latitude, longitude = excluded.longitude, ' +
					'live_location_sequence_number = excluded.live_location_sequence_number'
			),
			insertVcard: this.db.prepare('INSERT INTO message_vcard (message_row_id, vcard) VALUES (?, ?)'),
			getVcardRowId: this.db.prepare('SELECT _id FROM message_vcard WHERE message_row_id = ? AND vcard = ?'),
			insertVcardJid: this.db.prepare(
				'INSERT INTO message_vcard_jid (vcard_jid_row_id, vcard_row_id, message_row_id) VALUES (?, ?, ?)'
			),
			countVcardJids: this.db.prepare('SELECT COUNT(*) AS n FROM message_vcard_jid WHERE vcard_row_id = ?'),
			insertUiElement: this.db.prepare(
				'INSERT INTO message_ui_elements (message_row_id, element_type, element_content, description, ' +
					'template_id, hsm_tag, footer_text, button_text, message_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
			),
			deleteUiElements: this.db.prepare('DELETE FROM message_ui_elements WHERE message_row_id = ?'),
			getUiElements: this.db.prepare(
				'SELECT element_type, element_content, description, template_id, hsm_tag, footer_text, ' +
					'button_text, message_type FROM message_ui_elements WHERE message_row_id = ? ORDER BY _id'
			)
		}
	}

	private upsertAddOnRow(input: RecordAddOnInput): number {
		// NOT a bare jidMap.resolveJidRowId(chatJid) — that returns jid._id,
		// a different autoincrement sequence than message_add_on.chat_row_id
		// (which is chat._id). Confirmed real bug in an earlier revision: see
		// ChatRowResolver's doc in message-store-backend.ts.
		const chatRowId = this.chatResolver.resolveChatRowId(input.chatJid)
		const senderRowId = input.senderJid ? this.jidMap.resolveJidRowId(input.senderJid) : NO_SENDER_SENTINEL
		this.stmts.upsertAddOn.run(
			chatRowId,
			input.fromMe ? 1 : 0,
			input.keyId,
			senderRowId,
			input.parentMessageRowId,
			input.timestamp,
			input.addOnType ?? null
		)
		const row = this.stmts.getAddOnRowId.get(chatRowId, input.fromMe ? 1 : 0, input.keyId, senderRowId) as
			| { _id: number }
			| undefined
		if (!row) throw new Error(`MessageAddOnBackend: failed to materialize message_add_on row for key_id ${input.keyId}`)
		return row._id
	}

	/** Records a reaction (emoji) to a message. */
	recordReaction(input: RecordReactionInput): void {
		this.db.transaction(() => {
			const addOnRowId = this.upsertAddOnRow(input)
			this.stmts.upsertReaction.run(addOnRowId, input.reaction, input.senderTimestamp)
		})()
	}

	/**
	 * Records a poll vote, replacing its previously-selected options (a vote
	 * update always carries the voter's CURRENT full selection, not a delta —
	 * matches WhatsApp's own poll-vote semantics). Adjusts
	 * `message_poll_option.vote_total` by the net change in selection.
	 */
	recordPollVote(input: RecordPollVoteInput): void {
		this.db.transaction(() => {
			const addOnRowId = this.upsertAddOnRow(input)
			this.stmts.upsertPollVote.run(addOnRowId, input.senderTimestamp)

			// A vote update carries the voter's CURRENT full selection, not a
			// delta, so the previously-selected options (if any) must be
			// decremented before the new selection is applied — otherwise a
			// voter changing their mind leaves their old option's vote_total
			// permanently inflated.
			const previous = this.stmts.getPollVoteSelectedOptions.all(addOnRowId) as Array<{
				message_poll_option_id: number
			}>
			for (const { message_poll_option_id: optionRowId } of previous) {
				this.stmts.incrementPollOptionVoteTotal.run(-1, optionRowId)
			}

			this.stmts.deletePollVoteSelectedOptions.run(addOnRowId)
			for (const optionRowId of input.selectedOptionRowIds) {
				this.stmts.insertPollVoteSelectedOption.run(addOnRowId, optionRowId)
				this.stmts.incrementPollOptionVoteTotal.run(1, optionRowId)
			}
		})()
	}

	/** Records a poll creation message's metadata (call once per poll, alongside its options). */
	recordPoll(input: RecordPollInput): void {
		this.stmts.upsertPoll.run(input.messageRowId, input.encKey ?? null, input.selectableOptionsCount ?? null)
	}

	/**
	 * Resolves an existing poll option's row id by its option hash, or null if
	 * unknown. Lets the poll-vote mirror map a decrypted vote's selected-option
	 * hashes back to their `message_poll_option` rows without re-inserting.
	 */
	resolvePollOptionRowId(messageRowId: number, optionSha256: string): number | null {
		const row = this.stmts.getPollOptionRowId.get(messageRowId, optionSha256) as { _id: number } | undefined
		return row?._id ?? null
	}

	/** Records one poll option, returning its row id (needed by `recordPollVote`'s `selectedOptionRowIds`). */
	recordPollOption(input: RecordPollOptionInput): number {
		return this.db.transaction((): number => {
			const existing = this.stmts.getPollOptionRowId.get(input.messageRowId, input.optionSha256) as
				| { _id: number }
				| undefined
			if (existing) return existing._id

			this.stmts.insertPollOption.run(input.messageRowId, input.optionSha256, input.optionName)
			const row = this.stmts.getPollOptionRowId.get(input.messageRowId, input.optionSha256) as
				| { _id: number }
				| undefined
			if (!row) throw new Error('MessageAddOnBackend: failed to materialize message_poll_option row')
			return row._id
		})()
	}

	recordLocation(input: RecordLocationInput): void {
		// See upsertAddOnRow's comment — chatResolver, not jidMap, resolves chat_row_id.
		const chatRowId = this.chatResolver.resolveChatRowId(input.chatJid)
		this.stmts.upsertLocation.run(
			input.messageRowId,
			chatRowId,
			input.latitude,
			input.longitude,
			input.placeName ?? null,
			input.placeAddress ?? null,
			input.url ?? null,
			input.liveLocationShareDurationSecs ?? null,
			input.liveLocationSequenceNumber ?? null
		)
	}

	/**
	 * Records a vcard attached to a message. Deduplicates on the exact
	 * (message_row_id, vcard) pair — a retried decode must not duplicate the
	 * row (confirmed real bug), but a genuine `contactsArrayMessage` sending
	 * several DIFFERENT vcards for the same message_row_id is legitimate and
	 * must still insert each one, so this can't be a plain unique index on
	 * message_row_id alone.
	 *
	 * Also materializes the vCard's embedded WhatsApp JIDs into
	 * `message_vcard_jid` (one satellite row per `waid=` in the card), linked
	 * to both the vcard row and the parent message — the same shape the mobile
	 * client stores. The whole thing is one transaction so a card and its jids
	 * commit together.
	 */
	recordVcard(input: RecordVcardInput): void {
		this.db.transaction(() => {
			let row = this.stmts.getVcardRowId.get(input.messageRowId, input.vcard) as { _id: number } | undefined
			if (!row) {
				this.stmts.insertVcard.run(input.messageRowId, input.vcard)
				row = this.stmts.getVcardRowId.get(input.messageRowId, input.vcard) as { _id: number } | undefined
				if (!row) throw new Error('MessageAddOnBackend: failed to materialize message_vcard row')
			}

			// Backfill the jids when this card has none yet — covers both the
			// first insert AND a card recorded before jid extraction existed. The
			// count gate keeps it idempotent (a reprocess never duplicates), so
			// the early-return-on-existing card no longer strands its jids.
			const jidCount = (this.stmts.countVcardJids.get(row._id) as { n: number }).n
			if (jidCount === 0) {
				for (const jid of parseVcardWaids(input.vcard)) {
					this.stmts.insertVcardJid.run(this.jidMap.resolveJidRowId(jid), row._id, input.messageRowId)
				}
			}
		})()
	}

	/**
	 * Records the parsed interactive-UI elements (buttons / list rows /
	 * template) of a message. Replace-on-redecode: a re-processed stanza wipes
	 * the prior rows for this message and re-inserts, so a retry can't
	 * duplicate. An EMPTY `elements` still clears — a re-decode that yields no
	 * UI must not leave stale rows behind. The message proto stays the ultimate
	 * source; this is a derived render-mirror, safe to rebuild at any time.
	 */
	recordUiElements(messageRowId: number, elements: ReadonlyArray<Omit<RecordUiElementInput, 'messageRowId'>>): void {
		this.db.transaction(() => {
			this.stmts.deleteUiElements.run(messageRowId)
			for (const el of elements) {
				this.stmts.insertUiElement.run(
					messageRowId,
					el.elementType ?? null,
					el.elementContent ?? null,
					el.description ?? null,
					el.templateId ?? null,
					el.hsmTag ?? null,
					el.footerText ?? null,
					el.buttonText ?? null,
					el.messageType ?? null
				)
			}
		})()
	}

	/** Reads back the stored UI elements for a message (empty if none). */
	getUiElements(messageRowId: number): Array<Omit<RecordUiElementInput, 'messageRowId'>> {
		const rows = this.stmts.getUiElements.all(messageRowId) as Array<{
			element_type: number | null
			element_content: string | null
			description: string | null
			template_id: string | null
			hsm_tag: string | null
			footer_text: string | null
			button_text: string | null
			message_type: number | null
		}>
		return rows.map(r => ({
			elementType: r.element_type,
			elementContent: r.element_content,
			description: r.description,
			templateId: r.template_id,
			hsmTag: r.hsm_tag,
			footerText: r.footer_text,
			buttonText: r.button_text,
			messageType: r.message_type
		}))
	}
}
