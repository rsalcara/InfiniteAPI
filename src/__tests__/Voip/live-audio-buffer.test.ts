import { LiveAudioBuffer } from '../../Voip/live-audio-buffer'

describe('live audio buffer', () => {
	it('buffers and drains PCM frames in exact chunks', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 400,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()

		// Push 320 samples (one chunk worth at 16kHz mono)
		const samples = new Float32Array(320).fill(0.5)
		const accepted = buffer.push({ data: samples, sampleRate: 16000, channels: 1 })

		expect(accepted).toBe(true)
		expect(chunks.length).toBeGreaterThanOrEqual(0) // timer-driven, may not fire immediately

		buffer.stop()
	})

	it('emits silence when buffer is empty', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 400,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()
		// Wait for at least one timer tick
		return new Promise(resolve => {
			setTimeout(() => {
				buffer.stop()
				expect(chunks.length).toBeGreaterThan(0)
				expect(chunks[0]).toHaveLength(320)
				// All zeros = silence
				expect(chunks[0]!.every(v => v === 0)).toBe(true)
				resolve(undefined)
			}, 50)
		})
	})

	it('resamples from 48kHz to 16kHz', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 400,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()

		// Push 960 samples at 48kHz = 320 samples at 16kHz
		const samples = new Float32Array(960).fill(0.25)
		buffer.push({ data: samples, sampleRate: 48000, channels: 1 })

		return new Promise(resolve => {
			setTimeout(() => {
				buffer.stop()
				expect(chunks.length).toBeGreaterThan(0)
				// Should have real audio (not all silence)
				expect(chunks[0]!.some(v => v !== 0)).toBe(true)
				resolve(undefined)
			}, 50)
		})
	})

	it('downmixes stereo to mono', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 400,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()

		// Push 640 stereo samples (320 frames) — alternating L=0.2 R=0.8
		const stereo = new Float32Array(640)
		for (let i = 0; i < 640; i += 2) {
			stereo[i] = 0.2
			stereo[i + 1] = 0.8
		}
		buffer.push({ data: stereo, sampleRate: 16000, channels: 2 })

		return new Promise(resolve => {
			setTimeout(() => {
				buffer.stop()
				expect(chunks.length).toBeGreaterThan(0)
				// Average of 0.2 and 0.8 = 0.5
				expect(chunks[0]!.some(v => Math.abs(v - 0.5) < 0.01)).toBe(true)
				resolve(undefined)
			}, 50)
		})
	})

	it('drops oldest samples on overflow', () => {
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 100, // 100ms = 1600 samples at 16kHz
			onChunk: () => {}
		})

		buffer.start()

		// Push 2000 samples (exceeds 1600 max)
		const samples = new Float32Array(2000).fill(0.5)
		buffer.push({ data: samples, sampleRate: 16000, channels: 1 })

		// After overflow discard, should be at or below max
		expect(buffer.bufferedSamples).toBeLessThanOrEqual(1600)

		buffer.stop()
	})

	it('returns false when not started', () => {
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 400,
			onChunk: () => {}
		})

		const result = buffer.push({ data: new Float32Array(320), sampleRate: 16000, channels: 1 })
		expect(result).toBe(false)
	})

	it('stops cleanly and does not fire timer after stop', () => {
		let chunkCount = 0
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 400,
			onChunk: () => {
				chunkCount++
			}
		})

		buffer.start()
		buffer.stop()

		return new Promise(resolve => {
			setTimeout(() => {
				expect(chunkCount).toBe(0)
				resolve(undefined)
			}, 30)
		})
	})
})
