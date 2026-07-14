/**
 * Pure parsing tests for signal-id-parsing.ts — no SQLite involved, just
 * verifying the id shapes reverse-parse exactly the way
 * Signal/libsignal.ts's jidToSignalProtocolAddress/jidToSignalSenderKeyName
 * construct them.
 */
import {
	classifyIdentityKey,
	domainTypeToAccountType,
	parseIdentityKey,
	parseNonNegativeInt,
	parseProtocolAddressId,
	parseSenderKeyId,
	parseSignalUser
} from '../../Utils/multi-db-sqlite/signal-id-parsing'
import { WAJIDDomains } from '../../WABinary/jid-utils'

describe('parseNonNegativeInt', () => {
	it('parses plain decimal non-negative integers', () => {
		expect(parseNonNegativeInt('0')).toBe(0)
		expect(parseNonNegativeInt('42')).toBe(42)
		expect(parseNonNegativeInt('1000000')).toBe(1000000)
	})

	it('returns null for empty / whitespace strings (Number() would coerce these to 0)', () => {
		expect(parseNonNegativeInt('')).toBeNull()
		expect(parseNonNegativeInt('   ')).toBeNull()
		expect(parseNonNegativeInt('\t')).toBeNull()
	})

	it('returns null for non-decimal numeric forms Number() would otherwise accept', () => {
		expect(parseNonNegativeInt('0x1f')).toBeNull()
		expect(parseNonNegativeInt('1e3')).toBeNull()
		expect(parseNonNegativeInt('-1')).toBeNull()
		expect(parseNonNegativeInt('1.5')).toBeNull()
		expect(parseNonNegativeInt('12abc')).toBeNull()
	})
})

describe('parseSignalUser', () => {
	it('parses a plain PN user with no domain suffix', () => {
		expect(parseSignalUser('5511999999999')).toEqual({ user: '5511999999999', domainType: WAJIDDomains.WHATSAPP })
	})

	it('parses a user with a domainType suffix (e.g. LID)', () => {
		expect(parseSignalUser(`123456789_${WAJIDDomains.LID}`)).toEqual({
			user: '123456789',
			domainType: WAJIDDomains.LID
		})
	})

	it('returns null for a non-numeric domainType suffix', () => {
		expect(parseSignalUser('123456789_notanumber')).toBeNull()
	})

	it('returns null for an empty / negative / exponential / hex domainType suffix (no fabricated 0)', () => {
		expect(parseSignalUser('123456789_')).toBeNull()
		expect(parseSignalUser('123456789_-5')).toBeNull()
		expect(parseSignalUser('123456789_1e2')).toBeNull()
		expect(parseSignalUser('123456789_0x1')).toBeNull()
	})
})

describe('domainTypeToAccountType', () => {
	it('maps LID to 1', () => {
		expect(domainTypeToAccountType(WAJIDDomains.LID)).toBe(1)
	})

	it('maps WhatsApp to PN and leaves hosted domains to signal_kv', () => {
		expect(domainTypeToAccountType(WAJIDDomains.WHATSAPP)).toBe(0)
		expect(domainTypeToAccountType(WAJIDDomains.HOSTED)).toBeNull()
		expect(domainTypeToAccountType(WAJIDDomains.HOSTED_LID)).toBeNull()
		expect(domainTypeToAccountType(999)).toBeNull()
	})
})

describe('parseProtocolAddressId', () => {
	it('parses a plain PN session id ("user.deviceId")', () => {
		expect(parseProtocolAddressId('5511999999999.0')).toEqual({
			user: '5511999999999',
			domainType: WAJIDDomains.WHATSAPP,
			deviceId: 0
		})
	})

	it('parses a LID session id ("user_domainType.deviceId")', () => {
		expect(parseProtocolAddressId(`123456789_${WAJIDDomains.LID}.5`)).toEqual({
			user: '123456789',
			domainType: WAJIDDomains.LID,
			deviceId: 5
		})
	})

	it('returns null when there is no device separator', () => {
		expect(parseProtocolAddressId('5511999999999')).toBeNull()
	})

	it('returns null when the device id is not an integer', () => {
		expect(parseProtocolAddressId('5511999999999.abc')).toBeNull()
	})
})

describe('parseSenderKeyId', () => {
	it('parses a plain PN sender-key id ("groupId::user::deviceId")', () => {
		expect(parseSenderKeyId('123456-789@g.us::5511999999999::0')).toEqual({
			groupId: '123456-789@g.us',
			sender: { user: '5511999999999', domainType: WAJIDDomains.WHATSAPP, deviceId: 0 }
		})
	})

	it('parses a LID sender-key id', () => {
		expect(parseSenderKeyId(`123456-789@g.us::987654321_${WAJIDDomains.LID}::2`)).toEqual({
			groupId: '123456-789@g.us',
			sender: { user: '987654321', domainType: WAJIDDomains.LID, deviceId: 2 }
		})
	})

	it('returns null when the id does not have exactly 3 "::"-separated parts', () => {
		expect(parseSenderKeyId('only-one-part')).toBeNull()
		expect(parseSenderKeyId('a::b::c::d')).toBeNull()
	})

	it('returns null when the device id is not an integer', () => {
		expect(parseSenderKeyId('group::user::notanumber')).toBeNull()
	})
})

describe('parseIdentityKey', () => {
	it('parses a PN protocol-address to a s.whatsapp.net jid, recipient_type 0', () => {
		expect(parseIdentityKey('5511999999999.0')).toEqual({
			jid: '5511999999999@s.whatsapp.net',
			recipientType: 0,
			deviceId: 0
		})
		// device is kept separate from the jid
		expect(parseIdentityKey('5511999999999.3')).toEqual({
			jid: '5511999999999@s.whatsapp.net',
			recipientType: 0,
			deviceId: 3
		})
	})

	it('parses a LID protocol-address to a lid jid, recipient_type 1', () => {
		expect(parseIdentityKey(`46802258641027_${WAJIDDomains.LID}.0`)).toEqual({
			jid: '46802258641027@lid',
			recipientType: 1,
			deviceId: 0
		})
	})

	// The load-bearing case (audit P1): HOSTED / HOSTED_LID must NOT be
	// reconstructed onto a shared server — returning null sends them to the
	// signal_kv fallback instead of colliding with a real PN identity.
	it('returns null for HOSTED, HOSTED_LID, and unknown domains', () => {
		expect(parseIdentityKey(`123_${WAJIDDomains.HOSTED}.0`)).toBeNull()
		expect(parseIdentityKey(`123_${WAJIDDomains.HOSTED_LID}.0`)).toBeNull()
		expect(parseIdentityKey('123_9999.0')).toBeNull() // unknown domainType
	})

	it('classifies each fallback with an exact observable reason', () => {
		expect(classifyIdentityKey('totally-unparseable')).toEqual({ kind: 'fallback', reason: 'unparseable' })
		expect(classifyIdentityKey(`123_${WAJIDDomains.HOSTED}.0`)).toEqual({
			kind: 'fallback',
			reason: 'hosted-domain',
			domainType: WAJIDDomains.HOSTED
		})
		expect(classifyIdentityKey('123_9999.0')).toEqual({
			kind: 'fallback',
			reason: 'unknown-domain',
			domainType: 9999
		})
		expect(classifyIdentityKey('123@g.us')).toEqual({
			kind: 'fallback',
			reason: 'unsupported-jid-server',
			domainType: WAJIDDomains.WHATSAPP,
			server: 'g.us'
		})
	})

	it('a PN and a LID for the same user never reconstruct to the same jid', () => {
		const pn = parseIdentityKey('777.0')
		const lid = parseIdentityKey(`777_${WAJIDDomains.LID}.0`)
		expect(pn?.jid).not.toBe(lid?.jid) // s.whatsapp.net vs lid → no collision
	})

	it('falls back to jidDecode for a jid-shaped id (no device separator)', () => {
		expect(parseIdentityKey('46802258641027@lid')).toEqual({
			jid: '46802258641027@lid',
			recipientType: 1,
			deviceId: null
		})
		expect(parseIdentityKey('5511999999999@s.whatsapp.net')).toMatchObject({
			jid: '5511999999999@s.whatsapp.net',
			recipientType: 0
		})
	})

	it('does not canonicalize an unsupported jid server onto s.whatsapp.net', () => {
		expect(parseIdentityKey('5511999999999@g.us')).toBeNull()
		expect(parseIdentityKey('5511999999999@newsletter')).toBeNull()
		expect(parseIdentityKey('5511999999999@bot')).toBeNull()
		expect(parseIdentityKey('5511999999999@c.us')).toBeNull()
	})

	it('returns null for an unparseable id', () => {
		expect(parseIdentityKey('totally-unparseable')).toBeNull()
		expect(parseIdentityKey('')).toBeNull()
	})
})
