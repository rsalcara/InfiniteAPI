import { jest } from '@jest/globals'
import { SignalingBridge } from '../../Voip/signaling/bridge'

describe('SignalingBridge TcToken notification wait', () => {
	it('waits for the peer notification after an empty issuance ACK', async () => {
		const jid = '5511999999999@s.whatsapp.net'
		const token = Buffer.from([4, 1, 49])
		const originalSet = jest.fn(async () => undefined)
		const keys = {
			get: jest.fn(async () => ({})),
			set: originalSet
		}
		const issuePrivacyTokens = jest.fn(async () => ({ tag: 'iq', attrs: { type: 'result' } }))
		const sock = {
			authState: { keys },
			issuePrivacyTokens
		}
		const bridge = new SignalingBridge({ sock: sock as any })
		await bridge.init()

		const pending = bridge.ensureTcToken(jid)
		await new Promise(resolve => setTimeout(resolve, 10))
		await (keys.set as unknown as (data: unknown) => Promise<void>)({
			tctoken: { [jid]: { token, timestamp: '100' } }
		})

		await expect(pending).resolves.toEqual(token)
		expect(issuePrivacyTokens).toHaveBeenCalledWith([jid])
	})
})
