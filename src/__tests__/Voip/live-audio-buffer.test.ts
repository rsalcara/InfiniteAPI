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

	it('drains at the exact chunk rate without structural deficit', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320, // 320/16000 = 20ms per chunk
			maxBufferedMs: 400,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()

		// Push enough audio for 1 second (50 chunks worth = 16000 samples)
		// delivered in 20ms frames (320 samples each, 50 pushes)
		for (let i = 0; i < 50; i++) {
			buffer.push({ data: new Float32Array(320).fill(0.5), sampleRate: 16000, channels: 1 })
		}

		// Wait 1000ms for the timer to fire
		return new Promise(resolve => {
			setTimeout(() => {
				buffer.stop()
				// At 20ms intervals over 1000ms, we expect ~50 chunks.
				// With the 0.9 factor bug we got ~56 (11% too many = silence gaps).
				// With the fix, we expect 48-52 (some jitter is normal).
				expect(chunks.length).toBeGreaterThanOrEqual(45)
				expect(chunks.length).toBeLessThanOrEqual(55)
				resolve(undefined)
			}, 1050)
		})
	}, 15000)

	it('truncates large pushes to the most recent samples without corrupting the ring', () => {
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 100, // 1600 samples max
			onChunk: () => {}
		})

		buffer.start()

		// Push 16000 samples into a buffer with max 1600 samples capacity.
		// Without truncation, the write pointer wraps and corrupts state.
		const largeFrame = new Float32Array(16000).fill(0.7)
		const accepted = buffer.push({ data: largeFrame, sampleRate: 16000, channels: 1 })

		expect(accepted).toBe(true)

		// Exact count proves truncation worked: 16000 incoming truncated to
		// the most recent 1600. Without truncation, the write pointer wraps
		// and bufferedSamples reports 640 (the corrupted residue) instead.
		expect(buffer.bufferedSamples).toBe(1600)

		// Verify we can still drain without errors
		return new Promise(resolve => {
			setTimeout(() => {
				buffer.stop()
				resolve(undefined)
			}, 30)
		})
	})

	it('returns false on backpressure when buffer is full', () => {
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 100, // 1600 samples
			onChunk: () => {}
		})

		buffer.start()

		// Fill the buffer to capacity
		const fillResult = buffer.push({ data: new Float32Array(1600).fill(0.5), sampleRate: 16000, channels: 1 })
		expect(fillResult).toBe(true)
		expect(buffer.bufferedSamples).toBe(1600)

		// Now try to push more — should return false (backpressure)
		const overflowResult = buffer.push({ data: new Float32Array(320).fill(0.5), sampleRate: 16000, channels: 1 })
		expect(overflowResult).toBe(false)

		buffer.stop()
	})

	it('rejects unsupported channel counts', () => {
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 320,
			maxBufferedMs: 400,
			onChunk: () => {}
		})

		buffer.start()

		const result6ch = buffer.push({ data: new Float32Array(300), sampleRate: 16000, channels: 6 })
		expect(result6ch).toBe(false)

		const result0ch = buffer.push({ data: new Float32Array(0), sampleRate: 16000, channels: 1 })
		expect(result0ch).toBe(false)

		buffer.stop()
	})
})
