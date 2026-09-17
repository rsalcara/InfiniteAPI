import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { migrateAuthState } from '../../Utils/migrate-auth-state'
import { TrustedContactsBackend, useMultiDbSqliteAuthState } from '../../Utils/multi-db-sqlite'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const firstRecord = {
	jid: '46802258641027@lid',
	isSenderNewAccount: true,
	isSenderSuspicious: false,
	observedAt: 1_000
}

const secondRecord = {
	jid: '5511999999999@s.whatsapp.net',
	isSenderNewAccount: false,
	observedAt: 2_000
}

describe('start-chat trust-signal auth adapters', () => {
	let dir: string

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'start-chat-trust-auth-'))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it('round-trips and resets observations in the multi-file JSON adapter', async () => {
		const jsonDir = join(dir, 'json')
		const auth = await useMultiFileAuthState(jsonDir)

		await auth.state.startChatTrustSignals!.save(firstRecord)
		await auth.state.startChatTrustSignals!.save(secondRecord)
		await expect(auth.state.startChatTrustSignals!.get!(firstRecord.jid)).resolves.toEqual(firstRecord)
		await expect(auth.state.startChatTrustSignals!.exportState!()).resolves.toEqual({
			records: [firstRecord, secondRecord]
		})

		if (!auth.state.keys.clear) throw new Error('clear not implemented')
		await auth.state.keys.clear()
		await expect(auth.state.startChatTrustSignals!.exportState!()).resolves.toEqual({ records: [] })
	})

	it('round-trips and resets observations in mono SQLite', async () => {
		const auth = await useSqliteAuthState({ dbPath: ':memory:' })

		await auth.state.startChatTrustSignals!.save(firstRecord)
		await auth.state.startChatTrustSignals!.save(secondRecord)
		expect(auth.state.startChatTrustSignals!.get!(secondRecord.jid)).toEqual(secondRecord)
		await expect(auth.state.startChatTrustSignals!.exportState!()).resolves.toEqual({
			records: [firstRecord, secondRecord]
		})

		if (!auth.state.keys.clear) throw new Error('clear not implemented')
		await auth.state.keys.clear()
		await expect(auth.state.startChatTrustSignals!.exportState!()).resolves.toEqual({ records: [] })
		auth.close()
	})

	it('round-trips, resets, and persists observations in multi-DB SQLite', async () => {
		const multiDir = join(dir, 'multi')
		const auth = await useMultiDbSqliteAuthState({ sessionDir: multiDir })

		await auth.state.startChatTrustSignals!.save(firstRecord)
		await auth.state.startChatTrustSignals!.save(secondRecord)
		await expect(auth.state.startChatTrustSignals!.get!(secondRecord.jid)).resolves.toEqual(secondRecord)
		await expect(auth.state.startChatTrustSignals!.exportState!()).resolves.toEqual({
			records: [firstRecord, secondRecord]
		})

		if (!auth.state.keys.clear) throw new Error('clear not implemented')
		await auth.state.keys.clear()
		await expect(auth.state.startChatTrustSignals!.exportState!()).resolves.toEqual({ records: [] })
		expect(auth.store.handle('wa.db').prepare('SELECT COUNT(*) AS count FROM start_chat_trust_signals').get()).toEqual({
			count: 0
		})
		auth.close()
	})

	it('migrates built-in observations from multi-file JSON to multi-DB SQLite', async () => {
		const source = await useMultiFileAuthState(join(dir, 'source'))
		const target = await useMultiDbSqliteAuthState({ sessionDir: join(dir, 'target') })

		await source.state.startChatTrustSignals!.save(firstRecord)
		await source.state.startChatTrustSignals!.save(secondRecord)
		const result = await migrateAuthState({ from: source.state, to: target.state })

		expect(result.startChatTrustSignals).toEqual({ records: 2, copied: true })
		expect(result.warnings).toEqual([])
		await expect(target.state.startChatTrustSignals!.exportState!()).resolves.toEqual({
			records: [firstRecord, secondRecord]
		})
		target.close()
	})

	it('preserves a newer destination observation when migration skips existing records', async () => {
		const source = await useMultiFileAuthState(join(dir, 'skip-source'))
		const target = await useMultiDbSqliteAuthState({ sessionDir: join(dir, 'skip-target') })
		const newer = { ...firstRecord, observedAt: 5_000 }

		await source.state.startChatTrustSignals!.save(firstRecord)
		await target.state.startChatTrustSignals!.save(newer)

		const result = await migrateAuthState({ from: source.state, to: target.state, skipExisting: true })

		expect(result.startChatTrustSignals).toEqual({ records: 0, copied: false })
		expect(result.verified).toBe(true)
		expect(result.warnings).toEqual([])
		await expect(target.state.startChatTrustSignals!.get!(firstRecord.jid)).resolves.toEqual(newer)
		target.close()
	})

	it('does not import observations when skipExisting cannot enumerate the destination', async () => {
		const source = await useMultiFileAuthState(join(dir, 'opaque-source'))
		const target = await useMultiDbSqliteAuthState({ sessionDir: join(dir, 'opaque-target') })

		await source.state.startChatTrustSignals!.save(firstRecord)
		const durableStore = target.state.startChatTrustSignals!
		target.state.startChatTrustSignals = {
			save: record => durableStore.save(record),
			importState: snapshot => durableStore.importState!(snapshot)
		}

		const result = await migrateAuthState({ from: source.state, to: target.state, skipExisting: true })

		expect(result.startChatTrustSignals).toEqual({ records: 0, copied: false })
		expect(result.warnings).toContain(
			'destination cannot honor skipExisting for start-chat trust observations without exportState'
		)
		expect(result.verified).toBe(false)
		expect(result.warnings).toContain('destination does not support start-chat trust observation verification')
		target.close()
	})

	it('does not verify an empty start-chat source as clean when stale destination records exist', async () => {
		const source = await useMultiFileAuthState(join(dir, 'empty-source'))
		const target = await useMultiDbSqliteAuthState({ sessionDir: join(dir, 'stale-target') })

		await target.state.startChatTrustSignals!.save(firstRecord)
		const result = await migrateAuthState({ from: source.state, to: target.state, skipExisting: false })

		expect(result.startChatTrustSignals).toEqual({ records: 0, copied: false })
		expect(result.verified).toBe(false)
		expect(result.warnings).toContain(`destination has unexpected start-chat trust observation:${firstRecord.jid}`)
		target.close()
	})

	it('verifies newly copied observations even when other existing records are skipped', async () => {
		const source = await useMultiFileAuthState(join(dir, 'partial-source'))
		const target = await useMultiDbSqliteAuthState({ sessionDir: join(dir, 'partial-target') })
		const newer = { ...firstRecord, observedAt: 5_000 }

		await source.state.startChatTrustSignals!.save(firstRecord)
		await source.state.startChatTrustSignals!.save(secondRecord)
		await target.state.startChatTrustSignals!.save(newer)

		// Simulate a destination adapter that accepts a new record but corrupts
		// it. `skipExisting` must not turn this into an unverified success.
		const originalImport = target.state.startChatTrustSignals!.importState!.bind(target.state.startChatTrustSignals)
		target.state.startChatTrustSignals!.importState = async snapshot => {
			const imported = await originalImport(snapshot)
			if (snapshot.records.some(record => record.jid === secondRecord.jid)) {
				await target.state.startChatTrustSignals!.save({ ...secondRecord, observedAt: 9_999 })
			}

			return imported
		}

		const result = await migrateAuthState({ from: source.state, to: target.state, skipExisting: true })

		expect(result.startChatTrustSignals).toEqual({ records: 1, copied: true })
		expect(result.verified).toBe(false)
		expect(result.warnings).toContain(
			'destination has conflicting start-chat trust observation:5511999999999@s.whatsapp.net'
		)
		await expect(target.state.startChatTrustSignals!.get!(firstRecord.jid)).resolves.toEqual(newer)
		target.close()
	})

	it('recovers a start-chat observation left behind by an interrupted multi-DB clear', async () => {
		const interruptedDir = join(dir, 'interrupted')
		const first = await useMultiDbSqliteAuthState({ sessionDir: interruptedDir })
		await first.state.startChatTrustSignals!.save(firstRecord)

		// Simulate the durable marker committing before the process died. The
		// start-chat table is intentionally left populated to prove recovery.
		new TrustedContactsBackend(first.store.handle('wa.db')).beginClear()
		first.close()

		const second = await useMultiDbSqliteAuthState({ sessionDir: interruptedDir })
		await expect(second.state.startChatTrustSignals!.get!(firstRecord.jid)).resolves.toBeNull()
		expect(
			second.store
				.handle('wa.db')
				.prepare("SELECT value FROM infiniteapi_metadata WHERE key = 'auth_keys_clear_in_progress'")
				.get()
		).toBeUndefined()
		second.close()
	})
})
