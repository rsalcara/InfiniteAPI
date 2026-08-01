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
		['sticker_pack', { stickerPackMessage: {} }],
		['reaction', { reactionMessage: {} }],
		['location', { locationMessage: {} }],
		['live_location', { liveLocationMessage: {} }],
		['contact', { contactMessage: {} }],
		['contacts', { contactsArrayMessage: {} }],
		['poll', { pollCreationMessageV3: {} }],
		['poll_vote', { pollUpdateMessage: {} }],
		['interactive', { interactiveMessage: {} }],
		['interactive_response', { buttonsResponseMessage: {} }]
	])('classifies %s', (expected, content) => {
		expect(getMessageTypeLabel(content as any)).toBe(expected)
	})

	it('classifies view-once media after unwrapping nested containers', () => {
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
		).toBe('view_once_image')
		expect(getMessageTypeLabel({ viewOnceMessage: { message: { videoMessage: {} } } } as any)).toBe('view_once_video')
		expect(
			getMessageTypeLabel({ viewOnceMessageV2Extension: { message: { audioMessage: { ptt: true } } } } as any)
		).toBe('view_once_audio')
	})

	it('classifies an unavailable placeholder without inventing its media kind', () => {
		expect(getMessageTypeLabel(undefined, { isViewOnce: true })).toBe('view_once')
	})

	it('uses a deterministic label for future protobuf message types', () => {
		expect(getMessageTypeLabel({ scheduledCallCreationMessage: {} } as any)).toBe('scheduled_call_creation')
	})

	it('ignores explicit null protobuf fields before the real content', () => {
		expect(getMessageTypeLabel({ imageMessage: null, conversation: 'hello' } as any)).toBe('text')
	})
})
