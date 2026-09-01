/**
 * Circular PCM buffer for live audio uplink.
 *
 * The consumer pushes arbitrary-sized Float32 PCM frames. This buffer
 * resamples to the WASM engine's format, splits into exact chunks,
 * drops oldest samples on overflow, and returns silence when empty.
 */

const MIN_BUFFERED_MS = 100
const MAX_BUFFERED_MS = 2000
const DEFAULT_BUFFERED_MS = 400

export class LiveAudioBuffer {
	#pcm: Float32Array
	#writeIndex = 0
	#readIndex = 0
	#sampleRate: number
	#channels: number
	#framesPerChunk: number
	#maxSamples: number
	#timer: NodeJS.Timeout | null = null
	#onChunk: (chunk: Float32Array) => void
	#started = false

	constructor(config: {
		targetSampleRate: number
		targetChannels: number
		framesPerChunk: number
		maxBufferedMs: number
		onChunk: (chunk: Float32Array) => void
	}) {
		this.#sampleRate = config.targetSampleRate
		this.#channels = config.targetChannels
		this.#framesPerChunk = config.framesPerChunk
		this.#onChunk = config.onChunk

		const clampedMs = Math.min(Math.max(config.maxBufferedMs || DEFAULT_BUFFERED_MS, MIN_BUFFERED_MS), MAX_BUFFERED_MS)
		const samplesPerMs = (this.#sampleRate * this.#channels) / 1000
		this.#maxSamples = Math.ceil(clampedMs * samplesPerMs)

		const capacity = this.#maxSamples + this.#framesPerChunk * this.#channels
		this.#pcm = new Float32Array(capacity)
	}

	get bufferedSamples(): number {
		if (this.#writeIndex >= this.#readIndex) return this.#writeIndex - this.#readIndex
		return this.#pcm.length - this.#readIndex + this.#writeIndex
	}

	get bufferedMs(): number {
		return (this.bufferedSamples / (this.#sampleRate * this.#channels)) * 1000
	}

	push(frame: { data: Float32Array; sampleRate: number; channels: number }): boolean {
		if (!this.#started) return false

		// Reject unsupported channel counts — passing raw 6-channel audio into
		// a mono/stereo buffer would produce garbage, not intelligible speech.
		if (frame.channels !== 1 && frame.channels !== 2) return false

		// Reject empty frames — nothing to buffer.
		if (frame.data.length === 0) return false

		let samples = frame.data

		if (frame.channels === 2 && this.#channels === 1) {
			const mono = new Float32Array(Math.floor(samples.length / 2))
			for (let i = 0, j = 0; i < samples.length - 1; i += 2, j++) {
				mono[j] = (samples[i]! + samples[i + 1]!) / 2
			}

			samples = mono
		}

		if (frame.sampleRate !== this.#sampleRate) {
			const ratio = this.#sampleRate / frame.sampleRate
			const outLength = Math.floor(samples.length * ratio)
			const resampled = new Float32Array(outLength)
			for (let i = 0; i < outLength; i++) {
				const srcIdx = i / ratio
				const idx0 = Math.floor(srcIdx)
				const idx1 = Math.min(idx0 + 1, samples.length - 1)
				const frac = srcIdx - idx0
				resampled[i] = samples[idx0]! * (1 - frac) + samples[idx1]! * frac
			}

			samples = resampled
		}

		const incoming = samples.length

		// Backpressure: when the buffer is full and incoming data would
		// overflow, signal the consumer to discard the frame rather than
		// silently dropping it. This allows the platform layer to react
		// (e.g. skip encoding, reduce source bitrate, or log a warning).
		if (this.bufferedSamples + incoming > this.#maxSamples && this.bufferedSamples >= this.#maxSamples) {
			return false
		}

		// Truncate frames larger than the logical buffer limit to the most
		// recent samples. Without this, a 16k-sample push into a 1.6k-slot
		// ring wraps and corrupts the read pointer.
		if (incoming > this.#maxSamples) {
			samples = samples.slice(incoming - this.#maxSamples)
		}

		const truncated = samples.length
		if (this.bufferedSamples + truncated > this.#maxSamples) {
			const overflow = this.bufferedSamples + truncated - this.#maxSamples
			this.#discardOldest(overflow)
		}

		for (let i = 0; i < truncated; i++) {
			this.#pcm[this.#writeIndex] = samples[i]!
			this.#writeIndex = (this.#writeIndex + 1) % this.#pcm.length
		}

		return true
	}

	start(): void {
		if (this.#started) return
		this.#started = true

		const chunkMs = (this.#framesPerChunk / this.#sampleRate) * 1000
		// Drain at the exact chunk duration. A faster drain creates a
		// structural deficit (silence injection); the safety margin lives
		// in the buffer capacity, not in the drain rate.
		const intervalMs = Math.max(1, Math.round(chunkMs))

		this.#timer = setInterval(() => {
			this.#drainChunk()
		}, intervalMs)

		this.#timer.unref()
	}

	stop(): void {
		this.#started = false
		if (this.#timer) {
			clearInterval(this.#timer)
			this.#timer = null
		}
	}

	#drainChunk(): void {
		if (!this.#started) return

		const chunkSamples = this.#framesPerChunk * this.#channels
		const chunk = new Float32Array(chunkSamples)

		if (this.bufferedSamples >= chunkSamples) {
			for (let i = 0; i < chunkSamples; i++) {
				chunk[i] = this.#pcm[this.#readIndex]!
				this.#readIndex = (this.#readIndex + 1) % this.#pcm.length
			}
		} else {
			chunk.fill(0)
		}

		this.#onChunk(chunk)
	}

	#discardOldest(count: number): void {
		const toDiscard = Math.min(count, this.bufferedSamples)
		this.#readIndex = (this.#readIndex + toDiscard) % this.#pcm.length
	}
}
