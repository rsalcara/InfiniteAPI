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

	it.each([
		['id', { type: 'reply', id: '', text: 'Missing id' }],
		['text', { type: 'reply', id: 'missing-text', text: '' }]
	] as const)('rejects an empty reply %s before oversized list conversion', async (_field, invalidButton) => {
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

	it('bounds oversized reply descriptions without splitting surrogate pairs', async () => {
		const longText = `${'X'.repeat(71)}😀tail`
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
		const firstRow = decoded.listMessage?.sections?.[0]?.rows?.[0]

		expect(firstRow?.title).toBe('X'.repeat(24))
		expect(firstRow?.description).toBe('X'.repeat(71))
		expect(firstRow?.description).toHaveLength(71)
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
		'rejects %s when oversized replies require list conversion',
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
			).rejects.toThrow('Header media is not supported when more than 10 reply buttons are converted to a list')
		}
	)

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
		).rejects.toThrow('Maximum 30 total rows allowed, got 31')
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
