/**
 * Identity-key ids arrive as libsignal PROTOCOL ADDRESSES (`user_domainType.
 * device`, e.g. `46802258641027_1.0`), not jids. The typed store used to parse
 * them with `jidDecode` — which fails on that shape — so the `identities` table
 * was NEVER populated and every identity read silently fell back to `signal_kv`.
 * These tests pin the fix: a protocol-address id must materialize a typed row and
 * round-trip through get / getMany.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { JidMapBackend, MultiDbSqliteStore, SignalTypedBackend } from '../../Utils/multi-db-sqlite'
import { SignalTypedSourceStore } from '../../Utils/multi-db-sqlite/signal-typed-source'
import { WAJIDDomains } from '../../WABinary'

describe('SignalTypedSourceStore identity typed-mirror (protocol-address ids)', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let source: SignalTypedSourceStore
	let identityCount: () => number

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'signal-identity-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const jidMap = new JidMapBackend(store.handle('msgstore.db'))
		source = new SignalTypedSourceStore(backend, jidMap, undefined)
		identityCount = () =>
			(store.handle('axolotl.db').prepare('SELECT COUNT(*) AS n FROM identities').get() as { n: number }).n
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	// The core of the fix: the typed `identities` table actually gets rows.
	it('populates the typed identities table from a protocol-address id (was 0 before)', () => {
		expect(identityCount()).toBe(0)

		source.set('identity-key', `46802258641027_${WAJIDDomains.LID}.0`, 'PUBKEY-LID') // own LID identity
		expect(identityCount()).toBe(1)

		source.set('identity-key', '5511999999999.3', 'PUBKEY-PN') // PN, device 3
		expect(identityCount()).toBe(2)

		// A re-store of the same id upserts (no duplicate row).
		source.set('identity-key', `46802258641027_${WAJIDDomains.LID}.0`, 'PUBKEY-LID-v2')
		expect(identityCount()).toBe(2)
	})

	it('round-trips through get() for LID + PN protocol-address ids', () => {
		const lid = `46802258641027_${WAJIDDomains.LID}.0`
		source.set('identity-key', lid, 'PUBKEY-LID')
		source.set('identity-key', '5511999999999.3', 'PUBKEY-PN')

		expect(source.get('identity-key', lid)).toBe('PUBKEY-LID')
		expect(source.get('identity-key', '5511999999999.3')).toBe('PUBKEY-PN')
		expect(source.get('identity-key', '5500000000000.0')).toBeNull() // never stored
	})

	it('getMany equals the per-id get loop (hits, miss, unparseable)', () => {
		const lid = `46802258641027_${WAJIDDomains.LID}.0`
		source.set('identity-key', lid, 'PUBKEY-LID')
		source.set('identity-key', '5511999999999.3', 'PUBKEY-PN')

		const ids = [lid, '5511999999999.3', '5500000000000.0', 'no-device-separator']
		const expected: { [id: string]: string } = {}
		for (const id of ids) {
			const v = source.get('identity-key', id)
			if (v !== null) expected[id] = v
		}

		expect(source.getMany('identity-key', ids)).toEqual(expected)
		expect(Object.keys(expected)).toEqual([lid, '5511999999999.3']) // only the two hits
	})

	it('a jid-shaped id still resolves via the fallback (belt-and-suspenders)', () => {
		// A plain jid (no device separator) is handled by the jidDecode fallback.
		source.set('identity-key', '46802258641027@lid', 'PUBKEY-JID')
		expect(identityCount()).toBe(1)
		expect(source.get('identity-key', '46802258641027@lid')).toBe('PUBKEY-JID')
	})

	it('an unparseable id writes no typed row (caller still writes signal_kv)', () => {
		source.set('identity-key', 'totally-unparseable', 'X')
		expect(identityCount()).toBe(0)
		expect(source.get('identity-key', 'totally-unparseable')).toBeNull()
	})
})
