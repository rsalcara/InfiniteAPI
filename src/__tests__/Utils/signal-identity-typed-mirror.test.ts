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
import { BufferJSON } from '../../Utils/generics'
import { MultiDbSqliteStore, SignalTypedBackend } from '../../Utils/multi-db-sqlite'
import { SignalTypedSourceStore } from '../../Utils/multi-db-sqlite/signal-typed-source'
import { WAJIDDomains } from '../../WABinary'

describe('SignalTypedSourceStore identity typed-mirror (protocol-address ids)', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let source: SignalTypedSourceStore
	let identityCount: () => number
	const encoded = (value: string) => JSON.stringify(Buffer.from(value), BufferJSON.replacer)
	const decoded = (value: string | null) =>
		value === null ? null : Buffer.from(JSON.parse(value, BufferJSON.reviver)).toString()
	const setIdentity = (id: string, value: string) => source.set('identity-key', id, encoded(value))
	const getIdentity = (id: string) => decoded(source.get('identity-key', id))

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'signal-identity-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		source = new SignalTypedSourceStore(backend, undefined)
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

		setIdentity(`46802258641027_${WAJIDDomains.LID}.0`, 'PUBKEY-LID')
		expect(identityCount()).toBe(1)

		setIdentity('5511999999999.3', 'PUBKEY-PN')
		expect(identityCount()).toBe(2)

		// A re-store of the same id upserts (no duplicate row).
		setIdentity(`46802258641027_${WAJIDDomains.LID}.0`, 'PUBKEY-LID-v2')
		expect(identityCount()).toBe(2)
	})

	it('round-trips through get() for LID + PN protocol-address ids', () => {
		const lid = `46802258641027_${WAJIDDomains.LID}.0`
		setIdentity(lid, 'PUBKEY-LID')
		setIdentity('5511999999999.3', 'PUBKEY-PN')

		expect(getIdentity(lid)).toBe('PUBKEY-LID')
		expect(getIdentity('5511999999999.3')).toBe('PUBKEY-PN')
		expect(source.get('identity-key', '5500000000000.0')).toBeNull() // never stored
	})

	it('getMany equals the per-id get loop (hits, miss, unparseable)', () => {
		const lid = `46802258641027_${WAJIDDomains.LID}.0`
		setIdentity(lid, 'PUBKEY-LID')
		setIdentity('5511999999999.3', 'PUBKEY-PN')

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
		setIdentity('46802258641027@lid', 'PUBKEY-JID')
		expect(identityCount()).toBe(1)
		expect(getIdentity('46802258641027@lid')).toBe('PUBKEY-JID')
	})

	it('an unparseable id writes no typed row', () => {
		setIdentity('totally-unparseable', 'X')
		expect(identityCount()).toBe(0)
		expect(source.get('identity-key', 'totally-unparseable')).toBeNull()
	})

	it('an unsupported jid server cannot overwrite the typed PN identity', () => {
		const user = '123456789'
		setIdentity(`${user}@s.whatsapp.net`, 'PN-KEY')
		setIdentity(`${user}@g.us`, 'UNSUPPORTED-SERVER-KEY')

		expect(identityCount()).toBe(1)
		expect(getIdentity(`${user}@s.whatsapp.net`)).toBe('PN-KEY')
		expect(source.get('identity-key', `${user}@g.us`)).toBeNull()
	})

	// P1 (audit): HOSTED / HOSTED_LID must NOT be reconstructed onto a shared
	// server (`s.whatsapp.net`) — that would collide with a real PN identity on
	// the (recipient_id, recipient_type, device_id) key and let the hosted upsert
	// overwrite the PN public key. They are left to the signal_kv fallback (null).
	it('HOSTED / HOSTED_LID do not collide with a PN identity for the same user+device', () => {
		const user = '123456789'
		setIdentity(`${user}.0`, 'PN-KEY')
		setIdentity(`${user}_${WAJIDDomains.HOSTED}.0`, 'HOSTED-KEY')
		setIdentity(`${user}_${WAJIDDomains.HOSTED_LID}.0`, 'HOSTED-LID-KEY')

		// Only the PN identity is typed — hosted variants fall back to signal_kv.
		expect(identityCount()).toBe(1)
		// The PN key was NOT overwritten by a colliding hosted write.
		expect(getIdentity(`${user}.0`)).toBe('PN-KEY')
		expect(source.get('identity-key', `${user}_${WAJIDDomains.HOSTED}.0`)).toBeNull()
		expect(source.get('identity-key', `${user}_${WAJIDDomains.HOSTED_LID}.0`)).toBeNull()
	})

	// PN and LID for the same user+device are DISTINCT namespaces and must both
	// be stored (different reconstructed servers → different jid rows).
	it('PN and LID for the same user+device are stored as distinct identities', () => {
		setIdentity('555.0', 'PN-KEY')
		setIdentity(`555_${WAJIDDomains.LID}.0`, 'LID-KEY')
		expect(identityCount()).toBe(2)
		expect(getIdentity('555.0')).toBe('PN-KEY')
		expect(getIdentity(`555_${WAJIDDomains.LID}.0`)).toBe('LID-KEY')
	})

	// P2 (audit): reads hit the typed table first, so a delete that failed to
	// remove the typed row would shadow the signal_kv delete. del() must remove
	// the typed identity for a protocol-address id.
	it('del() removes the typed identity for a protocol-address id', () => {
		const lid = `46802258641027_${WAJIDDomains.LID}.0`
		setIdentity(lid, 'PUBKEY-LID')
		expect(identityCount()).toBe(1)

		source.del('identity-key', lid)
		expect(identityCount()).toBe(0)
		expect(source.get('identity-key', lid)).toBeNull()
	})
})
