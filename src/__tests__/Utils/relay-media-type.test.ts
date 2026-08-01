import { getRelayMediaType } from '../../Utils/messages'

describe('getRelayMediaType', () => {
	it.each([
		['image', { viewOnceMessage: { message: { imageMessage: { viewOnce: true } } } }, 'image'],
		['video', { viewOnceMessageV2: { message: { videoMessage: { viewOnce: true } } } }, 'video'],
		['audio', { viewOnceMessageV2Extension: { message: { audioMessage: { viewOnce: true } } } }, 'audio'],
		['voice', { viewOnceMessageV2Extension: { message: { audioMessage: { viewOnce: true, ptt: true } } } }, 'ptt']
	])('classifies wrapped view-once %s media for the encrypted stanza', (_label, message, expected) => {
		expect(getRelayMediaType(message)).toBe(expected)
	})

	it('preserves regular media classification', () => {
		expect(getRelayMediaType({ imageMessage: {} })).toBe('image')
		expect(getRelayMediaType({ videoMessage: { gifPlayback: true } })).toBe('gif')
		expect(getRelayMediaType({ audioMessage: {} })).toBe('audio')
	})

	it.each([
		['direct', { ptvMessage: {} }],
		['view-once wrapped', { viewOnceMessage: { message: { ptvMessage: {} } } }]
	])('classifies %s PTV as media', (_label, message) => {
		expect(getRelayMediaType(message)).toBe('ptv')
	})

	it.each([
		['ephemeral image', { ephemeralMessage: { message: { imageMessage: {} } } }, 'image'],
		['document with caption', { documentWithCaptionMessage: { message: { documentMessage: {} } } }, 'document'],
		['edited video', { editedMessage: { message: { videoMessage: {} } } }, 'video']
	])('classifies %s media after unwrapping', (_label, message, expected) => {
		expect(getRelayMediaType(message)).toBe(expected)
	})

	it('does not classify non-media content', () => {
		expect(getRelayMediaType({ conversation: 'hello' })).toBe('')
	})
})
