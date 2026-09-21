import { describe, expect, it } from '@jest/globals'
import { resolveMetaAiBotAliasJid, resolveMetaAiBotSignalAddressId } from '../../Utils/meta-ai-addressing'

describe('Meta AI bot addressing', () => {
	it('converts the official FBID bot and its devices to phone-form session aliases', () => {
		expect(resolveMetaAiBotAliasJid('718584497008509@bot')).toBe('13135550202@s.whatsapp.net')
		expect(resolveMetaAiBotAliasJid('718584497008509:2@bot')).toBe('13135550202:2@s.whatsapp.net')
		expect(resolveMetaAiBotAliasJid('5511000000001@s.whatsapp.net')).toBeUndefined()
	})

	it('converts Signal addresses without changing unrelated contacts or devices', () => {
		expect(resolveMetaAiBotSignalAddressId('718584497008509')).toBe('13135550202')
		expect(resolveMetaAiBotSignalAddressId('718584497008509.2')).toBe('13135550202.2')
		expect(resolveMetaAiBotSignalAddressId('5511000000001.2')).toBe('5511000000001.2')
		expect(resolveMetaAiBotSignalAddressId('100000000000001_1.2')).toBe('100000000000001_1.2')
	})
})
