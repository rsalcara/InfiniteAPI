import { jest } from '@jest/globals'
import { EventEmitter } from 'events'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, BaileysEventEmitter, WAMessage } from '../../Types'
import { initAuthCreds } from '../../Utils/auth-utils'
import { UI_ELEMENT_TYPE } from '../../Utils/multi-db-sqlite'
import processMessage from '../../Utils/process-message'

const silent = P({ level: 'silent' })

const credsWithMe = (): AuthenticationCreds => ({
	...initAuthCreds(),
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	me: { id: 'me@s.whatsapp.net' } as any
})

const inbound = (id: string, message: proto.IMessage): WAMessage => ({
	key: { remoteJid: 'chat@s.whatsapp.net', fromMe: false, id, participant: 'sender@s.whatsapp.net' },
	message,
	messageTimestamp: 1770000000
})

const makeContext = () => {
	const addOnBackend = { recordUiElements: jest.fn() }
	const messageStoreBackend = { recordMessage: jest.fn(() => 42) }
	const ev = new EventEmitter() as unknown as BaileysEventEmitter
	const ctx = {
		shouldProcessHistoryMsg: false,
		placeholderResendCache: undefined,
		ev,
		creds: credsWithMe(),
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		keyStore: {} as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		signalRepository: { lidMapping: { getPNForLID: async (jid: string) => jid } } as any,
		logger: silent,
		options: {},
		getMessage: async () => undefined,
		messageStoreBackend,
		addOnBackend
	}

	return { addOnBackend, ctx }
}

describe('processMessage — message_ui_elements extraction', () => {
	it.each([
		{
			name: 'buttonsMessage',
			message: {
				buttonsMessage: {
					contentText: 'Choose',
					footerText: 'Footer',
					buttons: [{ buttonId: 'yes', buttonText: { displayText: 'Yes' } }]
				}
			},
			expected: {
				elementType: UI_ELEMENT_TYPE.QUICK_REPLY,
				buttonText: 'Yes',
				elementContent: 'yes',
				description: 'Choose',
				footerText: 'Footer'
			}
		},
		{
			name: 'listMessage',
			message: {
				listMessage: {
					buttonText: 'Open',
					footerText: 'Footer',
					sections: [{ rows: [{ rowId: 'row-1', title: 'First', description: 'First row' }] }]
				}
			},
			expected: {
				elementType: UI_ELEMENT_TYPE.LIST,
				buttonText: 'First',
				elementContent: 'row-1',
				description: 'First row',
				footerText: 'Footer'
			}
		},
		{
			name: 'templateMessage',
			message: {
				templateMessage: {
					templateId: 'template-1',
					hydratedTemplate: {
						hydratedContentText: 'Choose',
						hydratedFooterText: 'Footer',
						hydratedButtons: [{ quickReplyButton: { id: 'quick-1', displayText: 'Quick' } }]
					}
				}
			},
			expected: {
				elementType: UI_ELEMENT_TYPE.TEMPLATE,
				templateId: 'template-1',
				buttonText: 'Quick',
				elementContent: 'quick-1',
				description: 'Choose',
				footerText: 'Footer'
			}
		},
		{
			name: 'interactiveMessage native flow',
			message: {
				interactiveMessage: {
					body: { text: 'Choose' },
					footer: { text: 'Footer' },
					nativeFlowMessage: {
						buttons: [{ name: 'single_select', buttonParamsJson: '{"title":"Choose one","sections":[]}' }]
					}
				}
			},
			expected: {
				elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
				buttonText: 'Choose one',
				elementContent: '{"title":"Choose one","sections":[]}',
				nativeFlowName: 'single_select',
				description: 'Choose',
				footerText: 'Footer'
			}
		},
		{
			name: 'interactiveMessage nested in a template',
			message: {
				templateMessage: {
					interactiveMessageTemplate: {
						body: { text: 'Nested' },
						footer: { text: 'Template footer' },
						nativeFlowMessage: {
							buttons: [{ name: 'cta_url', buttonParamsJson: '{"display_text":"Open","url":"/nested"}' }]
						}
					}
				}
			},
			expected: {
				elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
				buttonText: 'Open',
				elementContent: '{"display_text":"Open","url":"/nested"}',
				nativeFlowName: 'cta_url',
				description: 'Nested',
				footerText: 'Template footer'
			}
		}
	])('wires $name through the real processMessage path', async ({ message, expected }) => {
		const { addOnBackend, ctx } = makeContext()

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await processMessage(inbound('interactive-1', message as proto.IMessage), ctx as any)

		expect(addOnBackend.recordUiElements).toHaveBeenCalledWith(42, [expect.objectContaining(expected)])
		const recorded = addOnBackend.recordUiElements.mock.calls[0]?.[1] as Array<Record<string, unknown>>
		expect(recorded[0]).not.toHaveProperty('context')
	})

	it('preserves carousel card and button order without changing button payloads', async () => {
		const { addOnBackend, ctx } = makeContext()
		const message: proto.IMessage = {
			interactiveMessage: {
				body: { text: 'Carousel' },
				carouselMessage: {
					cards: [
						{
							body: { text: 'Card 1' },
							nativeFlowMessage: {
								buttons: [
									{
										name: 'cta_url',
										buttonParamsJson: '{"display_text":"Visit","url":"https://example.com/1"}'
									},
									{
										name: 'quick_reply',
										buttonParamsJson: '{"display_text":"First","id":"first"}'
									}
								]
							}
						},
						{
							body: { text: 'Card 2' },
							nativeFlowMessage: {
								buttons: [
									{
										name: 'quick_reply',
										buttonParamsJson: '{"display_text":"Second","id":"second"}'
									}
								]
							}
						}
					]
				}
			}
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await processMessage(inbound('carousel-1', message), ctx as any)

		expect(addOnBackend.recordUiElements).toHaveBeenCalledWith(42, [
			expect.objectContaining({
				buttonText: 'Visit',
				nativeFlowName: 'cta_url',
				elementContent: '{"display_text":"Visit","url":"https://example.com/1"}',
				description: 'Card 1',
				context: { containerType: 'carousel', cardIndex: 0, buttonIndex: 0 }
			}),
			expect.objectContaining({
				buttonText: 'First',
				nativeFlowName: 'quick_reply',
				elementContent: '{"display_text":"First","id":"first"}',
				context: { containerType: 'carousel', cardIndex: 0, buttonIndex: 1 }
			}),
			expect.objectContaining({
				buttonText: 'Second',
				nativeFlowName: 'quick_reply',
				elementContent: '{"display_text":"Second","id":"second"}',
				description: 'Card 2',
				context: { containerType: 'carousel', cardIndex: 1, buttonIndex: 0 }
			})
		])
	})

	it('clears stale rows when an interactive container has no extractable controls', async () => {
		const { addOnBackend, ctx } = makeContext()

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await processMessage(inbound('empty-1', { interactiveMessage: { nativeFlowMessage: { buttons: [] } } }), ctx as any)

		expect(addOnBackend.recordUiElements).toHaveBeenCalledWith(42, [])
	})

	it('keeps legacy processing alive and logs an exact schema failure reason', async () => {
		const { addOnBackend, ctx } = makeContext()
		const dbError = Object.assign(new Error('no such table: message_ui_element_context'), {
			code: 'SQLITE_ERROR'
		})
		addOnBackend.recordUiElements.mockImplementation(() => {
			throw dbError
		})
		const warn = jest.spyOn(silent, 'warn')
		try {
			await expect(
				processMessage(
					inbound('fallback-1', {
						interactiveMessage: {
							nativeFlowMessage: {
								buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"X","id":"x"}' }]
							}
						}
					}),
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					ctx as any
				)
			).resolves.not.toThrow()

			expect(warn).toHaveBeenCalledWith(
				expect.objectContaining({
					reason: 'MESSAGE_MIRROR_UI_ELEMENTS_REPLACE_SCHEMA_MISMATCH',
					sqliteCode: 'SQLITE_ERROR',
					errorMessage: 'no such table: message_ui_element_context',
					operation: 'ui_elements_replace',
					table: 'message_ui_elements,message_ui_element_context',
					messageId: 'fallback-1',
					primary: 'multi_db_sqlite',
					fallback: 'legacy_message_proto'
				}),
				'multi-db-sqlite: message mirror fallback'
			)
		} finally {
			warn.mockRestore()
		}
	})
})
