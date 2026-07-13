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
				buttonText: 'Open',
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
					nativeFlowMessage: { buttons: [{ name: 'single_select', buttonParamsJson: '{"id":"one"}' }] }
				}
			},
			expected: {
				elementType: UI_ELEMENT_TYPE.NATIVE_FLOW,
				buttonText: 'single_select',
				elementContent: '{"id":"one"}',
				description: 'Choose',
				footerText: 'Footer'
			}
		}
	])('wires $name through the real processMessage path', async ({ message, expected }) => {
		const { addOnBackend, ctx } = makeContext()

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await processMessage(inbound('interactive-1', message as proto.IMessage), ctx as any)

		expect(addOnBackend.recordUiElements).toHaveBeenCalledWith(42, [expect.objectContaining(expected)])
	})
})
