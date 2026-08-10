import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { AnyMessageContent, MessageContentGenerationOptions } from '../../Types'
import { generateWAMessageContent } from '../../Utils/messages'

const options = {
	upload: jest.fn()
} as unknown as MessageContentGenerationOptions

const cachedMediaOptions = (message: proto.IMessage) =>
	({
		upload: jest.fn(),
		mediaCache: {
			get: jest.fn(async () => proto.Message.encode(proto.Message.create(message)).finish()),
			set: jest.fn()
		}
	}) as unknown as MessageContentGenerationOptions

const roundTrip = (message: proto.IMessage) =>
	proto.Message.decode(proto.Message.encode(proto.Message.create(message)).finish())

describe('native button protobuf envelope', () => {
	it.each([
		['a non-array value', {}],
		['a null element', [null]],
		['a non-string label', [{ type: 'reply', id: 'option-1', text: 1 }]],
		['a non-string reply id', [{ type: 'reply', id: 1, text: 'Option 1' }]]
	])('rejects %s with a client error before button classification', async (_label, nativeButtons) => {
		await expect(
			generateWAMessageContent({ text: 'Choose an option', nativeButtons } as AnyMessageContent, options)
		).rejects.toMatchObject({ output: { statusCode: 400 } })
	})

	it('encodes quick replies in the legacy reply envelope', async () => {
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

		expect(decoded.buttonsMessage?.contentText).toBe('Confirm the order?')
		expect(decoded.buttonsMessage?.footerText).toBe('Order #12345')
		expect(decoded.buttonsMessage?.buttons).toEqual([
			expect.objectContaining({ buttonId: 'confirm', buttonText: { displayText: 'Confirm' } }),
			expect.objectContaining({ buttonId: 'cancel', buttonText: { displayText: 'Cancel' } })
		])
		expect(decoded.viewOnceMessage).toBeNull()
		expect(decoded.interactiveMessage).toBeNull()
		expect(decoded.listMessage).toBeNull()
	})

	it('preserves sixteen quick replies in the legacy reply envelope', async () => {
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
		expect(decoded.listMessage).toBeNull()
		expect(decoded.buttonsMessage?.contentText).toBe('Choose a department')
		expect(decoded.buttonsMessage?.footerText).toBe('Available all day')
		expect(decoded.buttonsMessage?.buttons).toHaveLength(16)
		expect(decoded.buttonsMessage?.buttons?.[13]).toMatchObject({
			buttonId: 'option-14',
			buttonText: { displayText: '🔧 Tecnologia da Informação' }
		})
	})

	it('keeps ten quick replies in the legacy reply envelope', async () => {
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
		expect(decoded.interactiveMessage).toBeNull()
		expect(decoded.buttonsMessage?.buttons).toHaveLength(10)
	})

	it.each([
		['id', { type: 'reply', id: '', text: 'Missing id' }],
		['text', { type: 'reply', id: 'missing-text', text: '' }]
	] as const)('rejects an empty reply %s before selecting an envelope', async (_field, invalidButton) => {
		const buttons = Array.from({ length: 11 }, (_, index) => ({
			type: 'reply' as const,
			id: `option-${index + 1}`,
			text: `Option ${index + 1}`
		}))
		buttons[0] = invalidButton

		await expect(
			generateWAMessageContent({ text: 'Choose an option', nativeButtons: buttons } as AnyMessageContent, options)
		).rejects.toThrow(`Button ${_field} is required and cannot be empty`)
	})

	it('does not rewrite labels when replies use the legacy envelope', async () => {
		const longText = `${'X'.repeat(32)}😀tail`
		const content = await generateWAMessageContent(
			{
				text: 'Choose an option',
				nativeButtons: Array.from({ length: 11 }, (_, index) => ({
					type: 'reply' as const,
					id: `option-${index + 1}`,
					text: index === 0 ? longText : `Option ${index + 1}`
				}))
			} as AnyMessageContent,
			options
		)
		const decoded = roundTrip(content)
		const firstButton = decoded.buttonsMessage?.buttons?.[0]

		expect(firstButton?.buttonId).toBe('option-1')
		expect(firstButton?.buttonText?.displayText).toBe(longText)
	})

	it.each([
		[
			'headerImage',
			{ url: 'https://example.com/header.jpg' },
			{ imageMessage: { url: 'https://cdn.example.com/header.enc', directPath: '/mms/image/header' } },
			'imageMessage'
		],
		[
			'headerVideo',
			{ url: 'https://example.com/header.mp4' },
			{ videoMessage: { url: 'https://cdn.example.com/header.enc', directPath: '/mms/video/header' } },
			'videoMessage'
		]
	] as const)('preserves %s for quick replies', async (field, media, cachedMessage, expectedField) => {
		const content = await generateWAMessageContent(
			{
				text: 'Choose an option',
				nativeButtons: [
					{ type: 'reply', id: 'first', text: 'First' },
					{ type: 'reply', id: 'second', text: 'Second' }
				],
				[field]: media
			} as AnyMessageContent,
			cachedMediaOptions(cachedMessage)
		)
		const header = roundTrip(content).interactiveMessage?.header

		expect(header?.hasMediaAttachment).toBe(true)
		expect(header?.[expectedField]).toBeTruthy()
	})

	it.each(['headerImage', 'headerVideo'] as const)(
		'rejects %s when more than ten replies cannot retain media',
		async field => {
			await expect(
				generateWAMessageContent(
					{
						text: 'Choose an option',
						nativeButtons: Array.from({ length: 11 }, (_, index) => ({
							type: 'reply' as const,
							id: `option-${index + 1}`,
							text: `Option ${index + 1}`
						})),
						[field]: { url: 'https://example.com/header' }
					} as AnyMessageContent,
					options
				)
			).rejects.toThrow('Header media is supported for up to 10 reply buttons')
		}
	)

	it('converts seventeen reply options to a single-select list', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Choose an option',
				footer: 'Available all day',
				nativeButtons: Array.from({ length: 17 }, (_, index) => ({
					type: 'reply' as const,
					id: `option-${index + 1}`,
					text: index === 13 ? '🔧 Tecnologia da Informação' : `Option ${index + 1}`
				}))
			} as AnyMessageContent,
			options
		)
		const decoded = roundTrip(content)

		expect(decoded.buttonsMessage).toBeNull()
		expect(decoded.interactiveMessage).toBeNull()
		expect(decoded.listMessage?.description).toBe('Choose an option')
		expect(decoded.listMessage?.footerText).toBe('Available all day')
		expect(decoded.listMessage?.buttonText).toBe('View options')
		expect(decoded.listMessage?.sections?.map(section => section.rows?.length)).toEqual([10, 7])
		expect(decoded.listMessage?.sections?.map(section => section.title)).toEqual(['Options 1-10', 'Options 11-17'])
		expect(decoded.listMessage?.sections?.[1]?.rows?.[3]).toMatchObject({
			rowId: 'option-14',
			title: '🔧 Tecnologia da Informa',
			description: '🔧 Tecnologia da Informação'
		})
	})

	it('supports the 30-option list limit', async () => {
		const content = await generateWAMessageContent(
			{
				text: 'Choose an option',
				nativeButtons: Array.from({ length: 30 }, (_, index) => ({
					type: 'reply' as const,
					id: `option-${index + 1}`,
					text: `Option ${index + 1}`
				}))
			} as AnyMessageContent,
			options
		)

		const sections = roundTrip(content).listMessage?.sections
		expect(sections?.map(section => section.rows?.length)).toEqual([10, 10, 10])
		expect(sections?.map(section => section.title)).toEqual(['Options 1-10', 'Options 11-20', 'Options 21-30'])
	})

	it('rejects reply-only sets above the 30-option list limit', async () => {
		await expect(
			generateWAMessageContent(
				{
					text: 'Choose an option',
					nativeButtons: Array.from({ length: 31 }, (_, index) => ({
						type: 'reply' as const,
						id: `option-${index + 1}`,
						text: `Option ${index + 1}`
					}))
				} as AnyMessageContent,
				options
			)
		).rejects.toThrow('Maximum 30 reply options allowed')
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
