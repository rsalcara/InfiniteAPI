/**
 * Typed per-chat preference storage backed by `chatsettings.db`.
 *
 * Real Android capture confirms the schema below AND a "lazy creation"
 * write pattern: the `settings` row for a jid is only created the first
 * time a NON-default preference is set (mute/pin/wallpaper/etc — plain
 * chat-open activity was captured going through an UPDATE-then-INSERT
 * sequence: `UPDATE ... WHERE jid=?` affects 0 rows, THEN
 * `INSERTWITHONCONFLICT settings (jid, ...)` creates it). `ON CONFLICT(jid)
 * DO UPDATE SET <only the touched columns>` reproduces that same net effect
 * in one statement without needing the two-step dance.
 *
 * Only `mute_end` and `pinned`/`pinned_time` are wired (from
 * `processSyncAction`'s muteAction/pinAction branches) — those are the only
 * two chat-level app-state actions Baileys currently decodes that map onto
 * confirmed columns of this table. Notably, **`archived` has no column
 * here** — real Android's chat-list archive state is NOT part of
 * chatsettings.db at all (it lives in msgstore.db's `chat` table, out of
 * this multi-db-sqlite system's scope), so `archiveChatAction` is
 * intentionally not wired to this backend. `last_chat_entry_timestamp_millis`
 * (chat-opened-in-UI activity) has no Baileys equivalent — a headless
 * library has no concept of "the user opened this chat" — so it's schema-only.
 *
 * The remaining ~34 columns (wallpaper_*, theme_id, transcription_locale,
 * message_tone/vibrate/popup/light, call_*, snooze_end_time, etc.) are
 * PERMANENTLY unreachable by any companion device, not just unimplemented —
 * confirmed by live investigation (2026-07-08/09): CDP on WhatsApp
 * Desktop/Web (JS-level IndexedDB + WebSocket hooks) and Frida on a real
 * Android primary device (SQLiteDatabase.insert/update hooks + direct
 * chatsettings.db read) both show these fields are written ONLY on the
 * Android primary device's local storage — they never appear as an
 * app-state sync action, never touch IndexedDB/localStorage on a linked
 * device, and generate no correlated network traffic. mute/pin are the
 * ONLY per-chat settings WhatsApp actually syncs across devices; wallpaper/
 * theme/notification-tone/transcription are device-local by protocol
 * design. Do not treat the sparse population here as a gap to fill in —
 * there is no wire-level source to fill it from.
 *
 * Column names match the canonical schema verbatim.
 */
import type { SqliteDbLike, SqliteStatementLike } from './types'

export type ChatSettingsRow = {
	jid: string
	muteEnd: number | null
	pinned: number | null
	pinnedTime: number | null
}

export class ChatSettingsBackend {
	private readonly stmts: {
		upsertMuteEnd: SqliteStatementLike
		upsertPinned: SqliteStatementLike
		getSettings: SqliteStatementLike
	}

	private readonly db: SqliteDbLike

	constructor(db: SqliteDbLike) {
		this.db = db
		this.stmts = {
			upsertMuteEnd: this.db.prepare(
				'INSERT INTO settings (jid, mute_end) VALUES (?, ?) ' +
					'ON CONFLICT(jid) DO UPDATE SET mute_end = excluded.mute_end'
			),
			upsertPinned: this.db.prepare(
				'INSERT INTO settings (jid, pinned, pinned_time) VALUES (?, ?, ?) ' +
					'ON CONFLICT(jid) DO UPDATE SET pinned = excluded.pinned, pinned_time = excluded.pinned_time'
			),
			getSettings: this.db.prepare('SELECT jid, mute_end, pinned, pinned_time FROM settings WHERE jid = ?')
		}
	}

	setMuteEnd(jid: string, muteEnd: number | null): void {
		this.stmts.upsertMuteEnd.run(jid, muteEnd)
	}

	setPinned(jid: string, pinned: boolean, pinnedTime: number | null): void {
		this.stmts.upsertPinned.run(jid, pinned ? 1 : 0, pinnedTime)
	}

	getSettings(jid: string): ChatSettingsRow | null {
		const r = this.stmts.getSettings.get(jid) as
			| { jid: string; mute_end: number | null; pinned: number | null; pinned_time: number | null }
			| undefined
		if (!r) return null
		return { jid: r.jid, muteEnd: r.mute_end, pinned: r.pinned, pinnedTime: r.pinned_time }
	}
}
