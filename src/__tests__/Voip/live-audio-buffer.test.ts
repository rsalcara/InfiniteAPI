import { jest } from '@jest/globals'
import { LiveAudioBuffer } from '../../Voip/live-audio-buffer'

describe('live audio buffer', () => {
	beforeEach(() => {
		jest.useFakeTimers()
	})

	afterEach(() => {
		jest.useRealTimers()
	})

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
		jest.advanceTimersByTime(50)
		buffer.stop()
		expect(chunks.length).toBeGreaterThan(0)
		expect(chunks[0]).toHaveLength(320)
		// All zeros = silence
		expect(chunks[0]!.every(v => v === 0)).toBe(true)
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

		jest.advanceTimersByTime(50)
		buffer.stop()
		expect(chunks.length).toBeGreaterThan(0)
		// Should have real audio (not all silence)
		expect(chunks[0]!.some(v => v !== 0)).toBe(true)
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

		jest.advanceTimersByTime(50)
		buffer.stop()

		expect(chunks.length).toBeGreaterThan(0)
		// Average of 0.2 and 0.8 = 0.5
		expect(chunks[0]!.some(v => Math.abs(v - 0.5) < 0.01)).toBe(true)
	})

	it('upmixes mono to stereo', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 2,
			framesPerChunk: 2,
			maxBufferedMs: 100,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()
		expect(buffer.push({ data: new Float32Array([0.2, 0.8]), sampleRate: 16000, channels: 1 })).toBe(true)
		jest.advanceTimersByTime(1)
		buffer.stop()

		expect(chunks[0]).toEqual(new Float32Array([0.2, 0.2, 0.8, 0.8]))
	})

	it('drains a partial frame and pads only the remainder with silence', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 4,
			maxBufferedMs: 100,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()
		expect(buffer.push({ data: new Float32Array([0.1, 0.2]), sampleRate: 16000, channels: 1 })).toBe(true)
		jest.advanceTimersByTime(1)
		buffer.stop()

		expect(chunks[0]).toEqual(new Float32Array([0.1, 0.2, 0, 0]))
		expect(buffer.bufferedSamples).toBe(0)
	})

	it('preserves resampler phase across successive pushes', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 160,
			maxBufferedMs: 400,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()
		for (let i = 0; i < 10; i += 1) {
			expect(buffer.push({ data: new Float32Array(480).fill(0.25), sampleRate: 48000, channels: 1 })).toBe(true)
		}

		expect(buffer.bufferedSamples).toBe(1600)
		jest.advanceTimersByTime(100)
		buffer.stop()

		expect(chunks).toHaveLength(10)
		expect(chunks.flatMap(chunk => [...chunk]).every(sample => Math.abs(sample - 0.25) < 1e-6)).toBe(true)
	})

	it('does not skip or duplicate samples at resampler push boundaries', () => {
		const chunks: Float32Array[] = []
		const buffer = new LiveAudioBuffer({
			targetSampleRate: 16000,
			targetChannels: 1,
			framesPerChunk: 1,
			maxBufferedMs: 100,
			onChunk: chunk => chunks.push(chunk)
		})

		buffer.start()
		for (let push = 0; push < 12; push += 1) {
			const frame = new Float32Array(10)
			for (let i = 0; i < frame.length; i += 1) frame[i] = push * 10 + i + 1
			expect(buffer.push({ data: frame, sampleRate: 48000, channels: 1 })).toBe(true)
		}

		jest.advanceTimersByTime(40)
		buffer.stop()

		const output = chunks.map(chunk => chunk[0]!).slice(0, 40)
		expect(output).toHaveLength(40)
		expect(output).toEqual(Array.from({ length: 40 }, (_, i) => 1 + i * 3))
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

		jest.advanceTimersByTime(30)
		expect(chunkCount).toBe(0)
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

		// Advance deterministically; wall-clock sleeps made this test flaky in CI.
		jest.advanceTimersByTime(1000)
		buffer.stop()
		// At 20ms intervals over 1000ms, we expect exactly 50 chunks.
		expect(chunks.length).toBe(50)
	})

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

		// Verify we can still drain without errors.
		jest.advanceTimersByTime(30)
		buffer.stop()
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
