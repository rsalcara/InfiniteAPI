/**
 * `ChatSettingsBackend` smoke tests — the per-chat mute/pin mirror in
 * `chatsettings.db`. Only mute_end and pinned/pinned_time are stored (the only
 * per-chat settings WhatsApp syncs across devices). Exercises lazy creation,
 * ON CONFLICT(jid) merge (mute + pin land on one row), unmute/unpin, and read.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ChatSettingsBackend, MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

const CHAT = '5515991426667@s.whatsapp.net'
const GROUP = '120363044055005321@g.us'

describe('ChatSettingsBackend', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let backend: ChatSettingsBackend

	const countRows = () =>
		(store.handle('chatsettings.db').prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'chatsettings-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		backend = new ChatSettingsBackend(store.handle('chatsettings.db'))
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('lazily creates a row on first mute and reads it back', () => {
		expect(countRows()).toBe(0)
		backend.setMuteEnd(CHAT, 1_800_000_000)
		expect(countRows()).toBe(1)

		const row = backend.getSettings(CHAT)
		expect(row).not.toBeNull()
		expect(row!.muteEnd).toBe(1_800_000_000)
		expect(row!.pinned).toBeNull()
		expect(backend.getSettings('nobody@s.whatsapp.net')).toBeNull()
	})

	it('mute + pin on the same jid land on ONE row (ON CONFLICT merge)', () => {
		backend.setMuteEnd(CHAT, 1_800_000_000)
		backend.setPinned(CHAT, true, 1_700_000_000)
		expect(countRows()).toBe(1)

		const row = backend.getSettings(CHAT)!
		expect(row.muteEnd).toBe(1_800_000_000)
		expect(row.pinned).toBe(1)
		expect(row.pinnedTime).toBe(1_700_000_000)
	})

	it('unmute (mute_end=0) and unpin (pinned=false) update the row without clobbering the other', () => {
		backend.setMuteEnd(CHAT, 1_800_000_000)
		backend.setPinned(CHAT, true, 1_700_000_000)

		backend.setMuteEnd(CHAT, 0) // unmute
		let row = backend.getSettings(CHAT)!
		expect(row.muteEnd).toBe(0)
		expect(row.pinned).toBe(1) // pin untouched

		backend.setPinned(CHAT, false, null) // unpin
		row = backend.getSettings(CHAT)!
		expect(row.pinned).toBe(0)
		expect(row.pinnedTime).toBeNull()
		expect(row.muteEnd).toBe(0) // mute untouched
		expect(countRows()).toBe(1)
	})

	it('keys a group chat by its @g.us jid independently', () => {
		backend.setPinned(GROUP, true, 1_700_000_000)
		backend.setMuteEnd(CHAT, 1_800_000_000)
		expect(countRows()).toBe(2)
		expect(backend.getSettings(GROUP)!.pinned).toBe(1)
		expect(backend.getSettings(CHAT)!.muteEnd).toBe(1_800_000_000)
	})
})
