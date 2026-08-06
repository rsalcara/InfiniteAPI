import { jest } from '@jest/globals'
import { captureProtocolWire, validateProtocolWireCapture } from '../../Utils/protocol-wire-capture'
import type { BinaryNode } from '../../WABinary'

const enc = (): BinaryNode => ({ tag: 'enc', attrs: { v: '2', type: 'msg' }, content: Buffer.from([1, 2]) })

describe('protocol wire capture', () => {
	it('captures a direct retry only with one top-level encrypted payload', async () => {
		const hook = jest.fn<(capture: any) => void>()
		const stanza: BinaryNode = {
			tag: 'message',
			attrs: { id: 'retry-1', to: '123:4@lid', type: 'text' },
			content: [enc()]
		}

		await captureProtocolWire(hook, 'direct_retry', stanza)

		expect(hook).toHaveBeenCalledTimes(1)
		expect(hook.mock.calls[0]![0]).toMatchObject({ kind: 'direct_retry', node: stanza })
		expect(hook.mock.calls[0]![0].encoded).toBeInstanceOf(Buffer)
	})

	it('rejects mixed retry participant fanout', () => {
		const stanza: BinaryNode = {
			tag: 'message',
			attrs: { id: 'retry-2', to: '123:4@lid' },
			content: [enc(), { tag: 'participants', attrs: {}, content: [] }]
		}

		expect(() => validateProtocolWireCapture('direct_retry', stanza)).toThrow('cannot contain participants')
	})

	it('captures the complete legacy group-create IQ before query', async () => {
		const hook = jest.fn<(capture: any) => void>()
		const stanza: BinaryNode = {
			tag: 'iq',
			attrs: { id: 'group-1', to: '@g.us', type: 'set', xmlns: 'w:g2' },
			content: [
				{
					tag: 'create',
					attrs: { subject: 'Audit', key: 'key-1' },
					content: [{ tag: 'participant', attrs: { jid: '5511999999999@s.whatsapp.net' } }]
				}
			]
		}

		await captureProtocolWire(hook, 'legacy_group_create', stanza)
		expect(hook).toHaveBeenCalledWith(expect.objectContaining({ kind: 'legacy_group_create', node: stanza }))
	})

	it('never blocks delivery when an opt-in capture sink fails', async () => {
		const hook = jest.fn(async () => {
			throw new Error('disk full')
		})
		const logger = { warn: jest.fn() }
		const stanza: BinaryNode = { tag: 'message', attrs: { id: 'retry-3', to: '123:4@lid' }, content: [enc()] }

		await expect(captureProtocolWire(hook, 'direct_retry', stanza, logger as any)).resolves.toBeUndefined()
		expect(logger.warn).toHaveBeenCalled()
	})
})
