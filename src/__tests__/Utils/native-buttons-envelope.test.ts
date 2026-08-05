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
		expect(decoded.interactiveMessage?.nativeFlowMessage?.messageVersion).toBe(1)
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

	it('converts oversized quick-reply sets to one Web-compatible list', async () => {
		const buttons = Array.from({ length: 16 }, (_, index) => ({
			type: 'reply' as const,
			id: `option-${index + 1}`,
			text: index === 13 ? '🔧 Tecnologia da Informação' : `Option ${index + 1}`
		}))
		const content = await generateWAMessageContent(
			{
				text: 'Choose a department',
				footer: 'Available all day',
				nativeButtons: buttons
			} as AnyMessageContent,
			options
		)

		const decoded = roundTrip(content)

		expect(decoded.interactiveMessage).toBeNull()
		expect(decoded.viewOnceMessage).toBeNull()
		expect(decoded.buttonsMessage).toBeNull()
		expect(decoded.listMessage?.description).toBe('Choose a department')
		expect(decoded.listMessage?.footerText).toBe('Available all day')
		expect(decoded.listMessage?.buttonText).toBe('View options')
		expect(decoded.listMessage?.sections?.map(section => section.rows?.length)).toEqual([10, 6])
		expect(decoded.listMessage?.sections?.[1]?.rows?.[3]).toMatchObject({
			rowId: 'option-14',
			title: '🔧 Tecnologia da Informa',
			description: '🔧 Tecnologia da Informação'
		})
	})

	it('keeps ten quick replies in one Native Flow message', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Choose an option',
				nativeButtons: Array.from({ length: 10 }, (_, index) => ({
					type: 'reply' as const,
					id: `option-${index + 1}`,
					text: `Option ${index + 1}`
				}))
			} as AnyMessageContent,
			options
		)

		const decoded = roundTrip(content)

		expect(decoded.listMessage).toBeNull()
		expect(decoded.buttonsMessage).toBeNull()
		expect(decoded.interactiveMessage?.nativeFlowMessage?.buttons).toHaveLength(10)
		expect(decoded.interactiveMessage?.nativeFlowMessage?.messageVersion).toBe(1)
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
		expect(decoded.interactiveMessage?.nativeFlowMessage?.messageVersion).toBe(1)
		expect(decoded.interactiveMessage?.nativeFlowMessage?.buttons?.map(button => button.name)).toEqual([
			'cta_url',
			'cta_copy',
			'cta_call'
		])
	})
})
