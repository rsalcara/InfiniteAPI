import { getRelayMediaType } from '../../Socket/messages-send'

describe('getRelayMediaType', () => {
	it.each([
		['image', { viewOnceMessage: { message: { imageMessage: { viewOnce: true } } } }, 'image'],
		['video', { viewOnceMessageV2: { message: { videoMessage: { viewOnce: true } } } }, 'video'],
		['voice', { viewOnceMessageV2Extension: { message: { audioMessage: { viewOnce: true, ptt: true } } } }, 'ptt']
	])('classifies wrapped view-once %s media for the encrypted stanza', (_label, message, expected) => {
		expect(getRelayMediaType(message)).toBe(expected)
	})

	it('preserves regular media classification', () => {
		expect(getRelayMediaType({ imageMessage: {} })).toBe('image')
		expect(getRelayMediaType({ videoMessage: { gifPlayback: true } })).toBe('gif')
		expect(getRelayMediaType({ audioMessage: {} })).toBe('audio')
	})

	it('does not classify non-media content', () => {
		expect(getRelayMediaType({ conversation: 'hello' })).toBe('')
	})
})
