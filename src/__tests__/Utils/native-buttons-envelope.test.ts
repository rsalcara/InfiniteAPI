import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { AnyMessageContent, MessageContentGenerationOptions } from '../../Types'
import { generateWAMessageContent } from '../../Utils/messages'

const options = {
	upload: jest.fn()
} as unknown as MessageContentGenerationOptions

const roundTrip = (message: proto.IMessage) =>
	proto.Message.decode(proto.Message.encode(proto.Message.create(message)).finish())

describe('native button protobuf envelope', () => {
	it('encodes quick replies as a direct interactiveMessage', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Confirm the order?',
				footer: 'Order #12345',
				nativeButtons: [
					{ type: 'reply', id: 'confirm', text: 'Confirm' },
					{ type: 'reply', id: 'cancel', text: 'Cancel' }
				]
			} as AnyMessageContent,
			options
		)

		const decoded = roundTrip(content)

		expect(decoded.buttonsMessage).toBeNull()
		expect(decoded.viewOnceMessage).toBeNull()
		expect(decoded.interactiveMessage?.body?.text).toBe('Confirm the order?')
		expect(decoded.interactiveMessage?.nativeFlowMessage?.buttons).toEqual([
			{
				name: 'quick_reply',
				buttonParamsJson: JSON.stringify({ display_text: 'Confirm', id: 'confirm' })
			},
			{
				name: 'quick_reply',
				buttonParamsJson: JSON.stringify({ display_text: 'Cancel', id: 'cancel' })
			}
		])
	})

	it('encodes CTA buttons as a direct interactiveMessage', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Store channels',
				nativeButtons: [
					{ type: 'url', text: 'Website', url: 'https://example.com' },
					{ type: 'copy', text: 'Copy code', copyText: 'ABC123' },
					{ type: 'call', text: 'Call', phoneNumber: '+5511999999999' }
				]
			} as AnyMessageContent,
			options
		)

		const decoded = roundTrip(content)

		expect(decoded.buttonsMessage).toBeNull()
		expect(decoded.viewOnceMessage).toBeNull()
		expect(decoded.interactiveMessage?.nativeFlowMessage?.buttons?.map(button => button.name)).toEqual([
			'cta_url',
			'cta_copy',
			'cta_call'
		])
	})
})
