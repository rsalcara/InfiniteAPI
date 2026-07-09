/**
 * Pure parsing tests for signal-id-parsing.ts — no SQLite involved, just
 * verifying the id shapes reverse-parse exactly the way
 * Signal/libsignal.ts's jidToSignalProtocolAddress/jidToSignalSenderKeyName
 * construct them.
 */
import {
	domainTypeToAccountType,
	parseNonNegativeInt,
	parseProtocolAddressId,
	parseSenderKeyId,
	parseSignalUser
} from '../../Utils/multi-db-sqlite/signal-id-parsing'
import { WAJIDDomains } from '../../WABinary'

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
})

describe('domainTypeToAccountType', () => {
	it('maps LID to 1', () => {
		expect(domainTypeToAccountType(WAJIDDomains.LID)).toBe(1)
	})

	it('maps WHATSAPP/HOSTED/HOSTED_LID to 0', () => {
		expect(domainTypeToAccountType(WAJIDDomains.WHATSAPP)).toBe(0)
		expect(domainTypeToAccountType(WAJIDDomains.HOSTED)).toBe(0)
		expect(domainTypeToAccountType(WAJIDDomains.HOSTED_LID)).toBe(0)
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
