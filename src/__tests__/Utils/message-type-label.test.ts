import { describe, expect, it } from '@jest/globals'
import { getMessageTypeLabel } from '../../Utils/messages'

describe('getMessageTypeLabel', () => {
	it.each([
		['text', { conversation: 'hello' }],
		['text', { extendedTextMessage: { text: 'hello' } }],
		['image', { imageMessage: {} }],
		['video', { videoMessage: {} }],
		['gif', { videoMessage: { gifPlayback: true } }],
		['audio', { audioMessage: {} }],
		['voice', { audioMessage: { ptt: true } }],
		['document', { documentMessage: {} }],
		['sticker', { stickerMessage: {} }],
		['reaction', { reactionMessage: {} }],
		['location', { locationMessage: {} }],
		['live_location', { liveLocationMessage: {} }],
		['contact', { contactMessage: {} }],
		['contacts', { contactsArrayMessage: {} }],
		['poll', { pollCreationMessageV3: {} }],
		['poll_vote', { pollUpdateMessage: {} }],
		['interactive_response', { buttonsResponseMessage: {} }]
	])('classifies %s', (expected, content) => {
		expect(getMessageTypeLabel(content as any)).toBe(expected)
	})

	it('unwraps view-once and ephemeral media before classification', () => {
		expect(
			getMessageTypeLabel({
				ephemeralMessage: {
					message: {
						viewOnceMessageV2: {
							message: { imageMessage: { caption: 'photo' } }
						}
					}
				}
			} as any)
		).toBe('image')
	})

	it('uses a deterministic label for future protobuf message types', () => {
		expect(getMessageTypeLabel({ scheduledCallCreationMessage: {} } as any)).toBe('scheduled_call_creation')
	})
})
