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
	#resampleSourceRate = 0
	#resamplePosition = 0
	#resampleInput = new Float32Array(0)

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
		if (this.#channels !== 1 && this.#channels !== 2) return false
		if (!Number.isFinite(frame.sampleRate) || frame.sampleRate <= 0) return false

		// Reject empty frames — nothing to buffer.
		if (frame.data.length === 0) return false

		let samples = this.#convertChannels(frame.data, frame.channels)
		if (samples.length === 0) return false

		if (frame.sampleRate !== this.#sampleRate) {
			samples = this.#resample(samples, frame.sampleRate)
		} else {
			this.#resetResampler()
		}

		if (samples.length === 0) return false

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

		this.#resetResampler()
	}

	#drainChunk(): void {
		if (!this.#started) return

		const chunkSamples = this.#framesPerChunk * this.#channels
		const chunk = new Float32Array(chunkSamples)

		const samplesToCopy = Math.min(this.bufferedSamples, chunkSamples)
		if (samplesToCopy > 0) {
			for (let i = 0; i < samplesToCopy; i++) {
				chunk[i] = this.#pcm[this.#readIndex]!
				this.#readIndex = (this.#readIndex + 1) % this.#pcm.length
			}
		}

		this.#onChunk(chunk)
	}

	#discardOldest(count: number): void {
		const toDiscard = Math.min(count, this.bufferedSamples)
		this.#readIndex = (this.#readIndex + toDiscard) % this.#pcm.length
	}

	#convertChannels(samples: Float32Array, inputChannels: 1 | 2): Float32Array {
		if (inputChannels === this.#channels) return samples

		if (inputChannels === 2 && this.#channels === 1) {
			const frames = Math.floor(samples.length / 2)
			const mono = new Float32Array(frames)
			for (let i = 0, j = 0; j < frames; i += 2, j += 1) {
				mono[j] = (samples[i]! + samples[i + 1]!) / 2
			}

			return mono
		}

		if (inputChannels === 1 && this.#channels === 2) {
			const stereo = new Float32Array(samples.length * 2)
			for (let i = 0, j = 0; i < samples.length; i += 1, j += 2) {
				const sample = samples[i]!
				stereo[j] = sample
				stereo[j + 1] = sample
			}

			return stereo
		}

		return new Float32Array(0)
	}

	#resample(samples: Float32Array, sourceRate: number): Float32Array {
		if (this.#resampleSourceRate !== sourceRate) {
			this.#resampleSourceRate = sourceRate
			this.#resamplePosition = 0
			this.#resampleInput = new Float32Array(0)
		}

		const completeSamples = Math.floor(samples.length / this.#channels) * this.#channels
		if (completeSamples <= 0) return new Float32Array(0)

		const combined = new Float32Array(this.#resampleInput.length + completeSamples)
		combined.set(this.#resampleInput, 0)
		combined.set(samples.subarray(0, completeSamples), this.#resampleInput.length)

		const inputFrames = Math.floor(combined.length / this.#channels)
		if (inputFrames < 2) {
			this.#resampleInput = combined
			return new Float32Array(0)
		}

		const step = sourceRate / this.#sampleRate
		const output: number[] = []
		let position = this.#resamplePosition

		while (position < inputFrames - 1) {
			const frame0 = Math.floor(position)
			const frame1 = Math.min(frame0 + 1, inputFrames - 1)
			const frac = position - frame0

			for (let channel = 0; channel < this.#channels; channel += 1) {
				const sample0 = combined[frame0 * this.#channels + channel]!
				const sample1 = combined[frame1 * this.#channels + channel]!
				output.push(sample0 * (1 - frac) + sample1 * frac)
			}

			position += step
		}

		// Keep the interpolation base for the next push. Retaining one frame
		// too early shifts the phase and drops samples at every chunk boundary.
		// Keep at least the final interpolation frame. When the phase advances
		// past the current input window, retaining a frame beyond the window
		// would make `slice()` return an empty buffer and silently reset phase.
		const keepStartFrame = Math.min(Math.max(0, Math.floor(position)), inputFrames - 1)
		this.#resampleInput = combined.slice(keepStartFrame * this.#channels)
		this.#resamplePosition = position - keepStartFrame

		return Float32Array.from(output)
	}

	#resetResampler(): void {
		this.#resampleSourceRate = 0
		this.#resamplePosition = 0
		this.#resampleInput = new Float32Array(0)
	}
}
