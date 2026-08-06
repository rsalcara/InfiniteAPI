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
			signalRepository: { lidMapping: {} },
			issuePrivacyTokens
		}
		const bridge = new SignalingBridge({ sock: sock as any })
		await bridge.init()

		const pending = bridge.ensureTcToken(jid)
		await new Promise(resolve => setTimeout(resolve, 10))
		await (keys.set as unknown as (data: unknown) => Promise<void>)({
			tctoken: { [jid]: { token, timestamp: String(Math.floor(Date.now() / 1000)) } }
		})

		await expect(pending).resolves.toEqual(token)
		expect(issuePrivacyTokens).toHaveBeenCalledWith([jid])
	})

	it('uses the durable socket lifecycle once and resolves a LID notification for a PN request', async () => {
		const pn = '5511888888888@s.whatsapp.net'
		const lid = '123456789@lid'
		const token = Buffer.from([7, 8, 9])
		const keys = { get: jest.fn(async () => ({})), set: jest.fn(async () => undefined) }
		const issuePrivacyTokens = jest.fn(async () => ({ tag: 'iq', attrs: { type: 'result' } }))
		const bridge = new SignalingBridge({
			sock: {
				authState: { keys },
				signalRepository: { lidMapping: { getLIDForPN: jest.fn(async () => lid) } },
				issuePrivacyTokens
			} as any
		})
		await bridge.init()

		const pending = bridge.ensureTcToken(pn)
		await new Promise(resolve => setTimeout(resolve, 10))
		await (keys.set as unknown as (data: unknown) => Promise<void>)({
			tctoken: { [lid]: { token, timestamp: String(Math.floor(Date.now() / 1000)) } }
		})

		await expect(pending).resolves.toEqual(token)
		expect(issuePrivacyTokens).toHaveBeenCalledTimes(1)
		expect(issuePrivacyTokens).toHaveBeenCalledWith([lid])
		bridge.dispose()
	})

	it('returns immediately when the embedded socket has no token lifecycle', async () => {
		const keys = { get: jest.fn(async () => ({})), set: jest.fn(async () => undefined) }
		const bridge = new SignalingBridge({
			sock: { authState: { keys }, signalRepository: { lidMapping: {} } } as any
		})
		await bridge.init()

		await expect(bridge.ensureTcToken('5511777777777@s.whatsapp.net')).resolves.toBeUndefined()
		bridge.dispose()
	})

	it('settles pending waits and restores the key-store hook on teardown', async () => {
		const jid = '5511666666666@s.whatsapp.net'
		const originalSet = jest.fn(async () => undefined)
		const keys = { get: jest.fn(async () => ({})), set: originalSet }
		const bridge = new SignalingBridge({
			sock: {
				authState: { keys },
				signalRepository: { lidMapping: {} },
				issuePrivacyTokens: jest.fn(async () => undefined)
			} as any
		})
		await bridge.init()
		const wrappedSet = keys.set
		const pending = bridge.ensureTcToken(jid)
		bridge.dispose()

		await expect(pending).resolves.toBeUndefined()
		expect(keys.set).not.toBe(wrappedSet)
	})
})
