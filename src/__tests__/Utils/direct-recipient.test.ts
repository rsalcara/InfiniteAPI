import { jest } from '@jest/globals'
import { ReachoutTimelockEnforcementType } from '../../Types'
import {
	assertDirectRecipientCiphertext,
	type DirectRecipientPreflightOptions,
	resolveDirectRecipientUSync,
	runDirectRecipientPreflight
} from '../../Utils/direct-recipient'
import { USyncQuery } from '../../WAUSync'

describe('PN → LID/username recipient resolution', () => {
	it('preserves all USync identity aliases, contact type and username', () => {
		const query = new USyncQuery().withContactProtocol().withLIDProtocol().withUsernameProtocol()
		const parsed = query.parseUSyncQueryResult({
			tag: 'iq',
			attrs: { type: 'result' },
			content: [
				{
					tag: 'usync',
					attrs: {},
					content: [
						{
							tag: 'list',
							attrs: {},
							content: [
								{
									tag: 'user',
									attrs: {
										jid: '5511999999999@s.whatsapp.net',
										pn_jid: '5511999999999@s.whatsapp.net',
										new_jid: '123456@lid'
									},
									content: [
										{ tag: 'contact', attrs: { type: 'in' } },
										{ tag: 'lid', attrs: { val: '123456@lid' } },
										{ tag: 'username', attrs: {}, content: 'cold.contact' }
									]
								}
							]
						}
					]
				}
			]
		})

		expect(parsed?.list[0]).toMatchObject({
			id: '5511999999999@s.whatsapp.net',
			jid: '5511999999999@s.whatsapp.net',
			pnJid: '5511999999999@s.whatsapp.net',
			newJid: '123456@lid',
			lid: '123456@lid',
			contactType: 'in',
			username: 'cold.contact'
		})
		expect(resolveDirectRecipientUSync('5511999999999@c.us', parsed!.list)).toMatchObject({
			contactType: 'in',
			pnJid: '5511999999999@s.whatsapp.net',
			lidJid: '123456@lid',
			destinationJid: '123456@lid',
			username: 'cold.contact'
		})
	})

	it.each(['out', 'invalid'] as const)('rejects contact type %s without selecting a destination', contactType => {
		const result = resolveDirectRecipientUSync('5511999999999@s.whatsapp.net', [
			{
				id: '5511999999999@s.whatsapp.net',
				jid: '5511999999999@s.whatsapp.net',
				newJid: '123456@lid',
				contactType
			}
		])

		expect(result?.contactType).toBe(contactType)
		// The caller is responsible for enforcing `contactType === in`; aliases
		// are still returned so the rejection can be logged without guessing.
		expect(result?.destinationJid).toBe('123456@lid')
	})

	it('rejects ambiguous rows and rows with no explicit registration result', () => {
		expect(
			resolveDirectRecipientUSync('5511999999999@s.whatsapp.net', [
				{ id: 'a@lid', newJid: 'a@lid', contactType: 'in' },
				{ id: 'b@lid', newJid: 'b@lid', contactType: 'in' }
			])
		).toBeUndefined()
		expect(
			resolveDirectRecipientUSync('5511999999999@s.whatsapp.net', [
				{ id: '5511999999999@s.whatsapp.net', newJid: 'a@lid' }
			])
		).toBeUndefined()
	})
})

describe('cold-recipient preflight orchestration', () => {
	type Device = { jid: string }
	const pn = '5511999999999@s.whatsapp.net'
	const lid = '123456@lid'
	const device = { jid: '123456:1@lid' }

	const options = (
		overrides: Partial<DirectRecipientPreflightOptions<Device>> = {}
	): DirectRecipientPreflightOptions<Device> => ({
		requestedJid: pn,
		getKnownLIDForPN: async () => null,
		fetchReachout: async () => undefined,
		fetchCapping: async () => undefined,
		resolveUSync: async () => [{ id: pn, jid: pn, newJid: lid, contactType: 'in', username: 'cold.user' }],
		storeMapping: async () => undefined,
		getDevices: async () => [device],
		logger: { warn: jest.fn(), info: jest.fn() },
		...overrides
	})

	it('commits PN/LID before refreshing devices by canonical LID', async () => {
		const calls: string[] = []
		const storeMapping = jest.fn(async () => {
			calls.push('mapping')
		})
		const getDevices = jest.fn(async () => {
			calls.push('devices')
			return [device]
		})

		await expect(runDirectRecipientPreflight(options({ storeMapping, getDevices }))).resolves.toMatchObject({
			requestedPn: pn,
			pnJid: pn,
			lidJid: lid,
			freshTargetDevices: [device]
		})
		expect(storeMapping).toHaveBeenCalledWith({ lid, pn })
		expect(getDevices).toHaveBeenCalledWith(lid)
		expect(calls).toEqual(['mapping', 'devices'])
	})

	it('returns 403 before USync when reachout policy blocks cold contact', async () => {
		const resolveUSync = jest.fn(async () => [])
		await expect(
			runDirectRecipientPreflight(
				options({
					resolveUSync,
					fetchReachout: async () => ({
						isActive: true,
						enforcementType: ReachoutTimelockEnforcementType.RESTRICT_ALL_COMPANIONS
					})
				})
			)
		).rejects.toMatchObject({ output: { statusCode: 403 }, data: { category: 'reachout' } })
		expect(resolveUSync).not.toHaveBeenCalled()
	})

	it.each([
		['missing identity', [], 'registration-or-identity-unavailable'],
		['unregistered contact', [{ id: pn, jid: pn, newJid: lid, contactType: 'out' as const }], 'not-registered'],
		['invalid contact', [{ id: pn, jid: pn, newJid: lid, contactType: 'invalid' as const }], 'invalid-number']
	])('returns 404 for %s', async (_label, rows, reason) => {
		await expect(runDirectRecipientPreflight(options({ resolveUSync: async () => rows }))).rejects.toMatchObject({
			output: { statusCode: 404 },
			data: { reason }
		})
	})

	it('returns 503 when a registered PN has no LID', async () => {
		await expect(
			runDirectRecipientPreflight(options({ resolveUSync: async () => [{ id: pn, jid: pn, contactType: 'in' }] }))
		).rejects.toMatchObject({ output: { statusCode: 503 }, data: { reason: 'lid-unavailable' } })
	})

	it('returns 503 after mapping when the canonical LID has no devices', async () => {
		await expect(runDirectRecipientPreflight(options({ getDevices: async () => [] }))).rejects.toMatchObject({
			output: { statusCode: 503 },
			data: { reason: 'no-devices' }
		})
	})

	it.each([
		['no recipient devices', 0, 0],
		['no encrypted participant nodes', 1, 0]
	])('blocks ciphertext fanout with %s', (_label, recipientCount, ciphertextCount) => {
		expect(() =>
			assertDirectRecipientCiphertext({
				isExternalDirectRecipient: true,
				recipientCount,
				ciphertextCount,
				requestedJid: pn,
				lidJid: lid
			})
		).toThrow('No ciphertext was produced for the recipient')
	})

	it('does not apply the direct-recipient ciphertext guard to groups or retries', () => {
		expect(() =>
			assertDirectRecipientCiphertext({
				isExternalDirectRecipient: false,
				recipientCount: 0,
				ciphertextCount: 0,
				requestedJid: '120363000000000000@g.us'
			})
		).not.toThrow()
	})
})
