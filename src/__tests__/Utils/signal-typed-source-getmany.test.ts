/**
 * #618/#619 — `SignalTypedSourceStore.getMany` batches the typed Signal read
 * into one row-value IN query per type. This is crypto-critical code, so the
 * contract that matters is EQUIVALENCE: getMany(type, ids) must be byte-
 * identical to looping get(type, id) over the same ids — including hits, plain
 * misses, and unparseable ids. These tests assert exactly that against a real
 * axolotl.db, for all four mirrored types.
 */
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { BufferJSON } from '../../Utils/generics'
import { JidMapBackend, MultiDbSqliteStore, SignalTypedBackend } from '../../Utils/multi-db-sqlite'
import { SignalTypedSourceStore, type TypedSignalType } from '../../Utils/multi-db-sqlite/signal-typed-source'
import { WAJIDDomains } from '../../WABinary'

describe('SignalTypedSourceStore.getMany equivalence (#618/#619)', () => {
	let dir: string
	let store: MultiDbSqliteStore
	let source: SignalTypedSourceStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'signal-getmany-test-'))
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const backend = new SignalTypedBackend(store.handle('axolotl.db'))
		const jidMap = new JidMapBackend(store.handle('msgstore.db'))
		source = new SignalTypedSourceStore(backend, jidMap, undefined)
	})

	afterEach(async () => {
		store.close()
		await rm(dir, { recursive: true, force: true })
	})

	// getMany must equal the per-id loop of get (undefined entries omitted).
	const assertEquivalent = (type: TypedSignalType, ids: string[]) => {
		const expected: { [id: string]: string } = {}
		for (const id of ids) {
			const v = source.get(type, id)
			if (v !== null) expected[id] = v
		}

		expect(source.getMany(type, ids)).toEqual(expected)
	}

	it('sessions: hits, a plain miss, and an unparseable id', () => {
		source.set('session', '5511999999999.0', 'sess-A')
		source.set('session', `123456789_${WAJIDDomains.LID}.5`, 'sess-B')
		assertEquivalent('session', [
			'5511999999999.0',
			`123456789_${WAJIDDomains.LID}.5`,
			'5511000000000.0', // miss
			'no-device-separator' // unparseable
		])
	})

	it('pre-keys: hits, a miss, and an unparseable id', () => {
		source.set('pre-key', '5', 'pk-5')
		source.set('pre-key', '7', 'pk-7')
		assertEquivalent('pre-key', ['5', '7', '99', '1.5'])
	})

	it('sender-keys: hits, a miss, and an unparseable id', () => {
		source.set('sender-key', '123456-789@g.us::5511999999999::0', 'sk-A')
		source.set('sender-key', `123456-789@g.us::987654321_${WAJIDDomains.LID}::2`, 'sk-B')
		assertEquivalent('sender-key', [
			'123456-789@g.us::5511999999999::0',
			`123456-789@g.us::987654321_${WAJIDDomains.LID}::2`,
			'123456-789@g.us::5500000000000::0', // miss
			'only-one-part' // unparseable
		])
	})

	it('identity-keys: hits (PN + LID) and a miss', () => {
		source.set(
			'identity-key',
			'5511999999999@s.whatsapp.net',
			JSON.stringify(Buffer.from('id-PN'), BufferJSON.replacer)
		)
		source.set('identity-key', '123456789@lid', JSON.stringify(Buffer.from('id-LID'), BufferJSON.replacer))
		assertEquivalent('identity-key', [
			'5511999999999@s.whatsapp.net',
			'123456789@lid',
			'5511000000000@s.whatsapp.net' // miss (never stored → jid row absent)
		])
	})

	it('empty id list returns an empty object', () => {
		expect(source.getMany('session', [])).toEqual({})
	})

	it('preserves equivalent aliases and never exposes inherited object keys', () => {
		source.set('pre-key', '5', 'pk-5')
		const result = source.getMany('pre-key', ['5', '05', 'toString', 'constructor'])

		expect(Object.getPrototypeOf(result)).toBeNull()
		expect(result['5']).toBe('pk-5')
		expect(result['05']).toBe('pk-5')
		expect(Object.prototype.hasOwnProperty.call(result, 'toString')).toBe(false)
		expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false)
	})

	it('chunks every typed query below the SQLite variable limit', () => {
		const sessions = Array.from({ length: 205 }, (_, i) => `${6_000_000_000_000 + i}.0`)
		for (const [i, id] of sessions.entries()) source.set('session', id, `session-${i}`)

		const prekeys = Array.from({ length: 1_005 }, (_, i) => String(1_000 + i))
		for (const [i, id] of prekeys.entries()) source.set('pre-key', id, `prekey-${i}`)

		const senderKeys = Array.from({ length: 255 }, (_, i) => `123456-${i}@g.us::${7_000_000_000_000 + i}::0`)
		for (const [i, id] of senderKeys.entries()) source.set('sender-key', id, `sender-${i}`)

		const identities = Array.from({ length: 340 }, (_, i) => `${8_000_000_000_000 + i}@s.whatsapp.net`)
		for (const [i, id] of identities.entries()) {
			source.set('identity-key', id, JSON.stringify(Buffer.from(`identity-${i}`), BufferJSON.replacer))
		}

		const cases: Array<[TypedSignalType, string[], string, string]> = [
			['session', sessions, 'session-0', 'session-204'],
			['pre-key', prekeys, 'prekey-0', 'prekey-1004'],
			['sender-key', senderKeys, 'sender-0', 'sender-254'],
			[
				'identity-key',
				identities,
				JSON.stringify(Buffer.from('identity-0'), BufferJSON.replacer),
				JSON.stringify(Buffer.from('identity-339'), BufferJSON.replacer)
			]
		]
		for (const [type, ids, firstValue, lastValue] of cases) {
			const result = source.getMany(type, ids)
			expect(Object.keys(result)).toHaveLength(ids.length)
			expect(result[ids[0]!]).toBe(firstValue)
			expect(result[ids.at(-1)!]).toBe(lastValue)
		}
	})
})
