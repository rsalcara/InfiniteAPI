import { Boom } from '@hapi/boom'
import { execFile } from 'child_process'
import * as Crypto from 'crypto'
import { once } from 'events'
import { createReadStream, createWriteStream, promises as fs, WriteStream } from 'fs'
import type { Agent } from 'https'
import type { IAudioMetadata } from 'music-metadata'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { URL } from 'url'
import { proto } from '../../WAProto/index.js'
import {
	DEFAULT_ORIGIN,
	MEDIA_HKDF_KEY_MAPPING,
	MEDIA_PATH_MAP,
	type MediaType,
	NEWSLETTER_MEDIA_PATH_MAP
} from '../Defaults'
import type {
	BaileysEventMap,
	DownloadableMessage,
	MediaConnInfo,
	MediaDecryptionKeyInfo,
	MessageType,
	SocketConfig,
	WAGenericMediaMessage,
	WAMediaUpload,
	WAMediaUploadFunction,
	WAMessageContent,
	WAMessageKey
} from '../Types'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildBuffer, jidNormalizedUser } from '../WABinary'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto'
import { generateMessageIDV2 } from './generics'
import type { ILogger } from './logger'

const getTmpFilesDirectory = () => tmpdir()

/**
 * Get available image processing library (Sharp or Jimp)
 * Exported for use in sticker pack processing
 * @returns Object with sharp or jimp property, or throws if neither available
 */
export const getImageProcessingLibrary = async () => {
	//@ts-ignore
	const [jimp, sharp] = await Promise.all([import('jimp').catch(() => {}), import('sharp').catch(() => {})])

	if (sharp) {
		return { sharp }
	}

	if (jimp) {
		return { jimp }
	}

	throw new Boom('No image processing library available')
}

export const hkdfInfoKey = (type: MediaType) => {
	const hkdfInfo = MEDIA_HKDF_KEY_MAPPING[type]
	return `WhatsApp ${hkdfInfo} Keys`
}

export const getRawMediaUploadData = async (media: WAMediaUpload, mediaType: MediaType, logger?: ILogger) => {
	const { stream } = await getStream(media)
	logger?.debug('got stream for raw upload')

	const hasher = Crypto.createHash('sha256')
	const filePath = join(tmpdir(), mediaType + generateMessageIDV2())
	const fileWriteStream = createWriteStream(filePath)

	let fileLength = 0
	try {
		for await (const data of stream) {
			fileLength += data.length
			hasher.update(data)
			if (!fileWriteStream.write(data)) {
				await once(fileWriteStream, 'drain')
			}
		}

		fileWriteStream.end()
		await once(fileWriteStream, 'finish')
		stream.destroy()
		const fileSha256 = hasher.digest()
		logger?.debug('hashed data for raw upload')
		return {
			filePath: filePath,
			fileSha256,
			fileLength
		}
	} catch (error) {
		fileWriteStream.destroy()
		stream.destroy()
		try {
			await fs.unlink(filePath)
		} catch {
			//
		}

		throw error
	}
}

/** generates all the keys required to encrypt/decrypt & sign a media message */
export function getMediaKeys(
	buffer: Uint8Array | string | null | undefined,
	mediaType: MediaType
): MediaDecryptionKeyInfo {
	if (!buffer) {
		throw new Boom('Cannot derive from empty media key')
	}

	if (typeof buffer === 'string') {
		buffer = Buffer.from(buffer.replace('data:;base64,', ''), 'base64')
	}

	// expand using HKDF to 112 bytes, also pass in the relevant app info
	const expandedMediaKey = hkdf(buffer, 112, { info: hkdfInfoKey(mediaType) })
	return {
		iv: expandedMediaKey.slice(0, 16),
		cipherKey: expandedMediaKey.slice(16, 48),
		macKey: expandedMediaKey.slice(48, 80)
	}
}

/** Extracts video thumb using FFMPEG */
const extractVideoThumb = async (
	path: string,
	destPath: string,
	time: string,
	size: { width: number; height: number }
) =>
	new Promise<void>((resolve, reject) => {
		execFile(
			'ffmpeg',
			['-ss', time, '-i', path, '-y', '-vf', `scale=${size.width}:-1`, '-vframes', '1', '-f', 'image2', destPath],
			err => {
				if (err) {
					reject(err)
				} else {
					resolve()
				}
			}
		)
	})

export const extractImageThumb = async (bufferOrFilePath: Readable | Buffer | string, width = 32) => {
	// TODO: Move entirely to sharp, removing jimp as it supports readable streams
	// This will have positive speed and performance impacts as well as minimizing RAM usage.
	if (bufferOrFilePath instanceof Readable) {
		bufferOrFilePath = await toBuffer(bufferOrFilePath)
	}

	const lib = await getImageProcessingLibrary()
	if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
		const img = lib.sharp.default(bufferOrFilePath)
		const dimensions = await img.metadata()

		const buffer = await img.resize(width).jpeg({ quality: 50 }).toBuffer()
		return {
			buffer,
			original: {
				width: dimensions.width,
				height: dimensions.height
			}
		}
	} else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'function') {
		const jimp = await (lib.jimp.Jimp as any).read(bufferOrFilePath)
		const dimensions = {
			width: jimp.width,
			height: jimp.height
		}
		const buffer = await jimp
			.resize({ w: width, mode: lib.jimp.ResizeStrategy.BILINEAR })
			.getBuffer('image/jpeg', { quality: 50 })
		return {
			buffer,
			original: dimensions
		}
	} else {
		throw new Boom('No image processing library available')
	}
}

export const encodeBase64EncodedStringForUpload = (b64: string) =>
	encodeURIComponent(b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/\=+$/, ''))

export const generateProfilePicture = async (
	mediaUpload: WAMediaUpload,
	dimensions?: { width: number; height: number }
) => {
	let buffer: Buffer

	const { width: w = 640, height: h = 640 } = dimensions || {}

	if (Buffer.isBuffer(mediaUpload)) {
		buffer = mediaUpload
	} else {
		// Use getStream to handle all WAMediaUpload types (Buffer, Stream, URL)
		const { stream } = await getStream(mediaUpload)
		// Convert the resulting stream to a buffer
		buffer = await toBuffer(stream)
	}

	const lib = await getImageProcessingLibrary()
	let img: Promise<Buffer>
	if ('sharp' in lib && typeof lib.sharp?.default === 'function') {
		img = lib.sharp
			.default(buffer)
			.resize(w, h)
			.jpeg({
				quality: 50
			})
			.toBuffer()
	} else if ('jimp' in lib && typeof lib.jimp?.Jimp === 'function') {
		const jimp = await (lib.jimp.Jimp as any).read(buffer)
		const min = Math.min(jimp.width, jimp.height)
		const cropped = jimp.crop({ x: 0, y: 0, w: min, h: min })

		img = cropped.resize({ w, h, mode: lib.jimp.ResizeStrategy.BILINEAR }).getBuffer('image/jpeg', { quality: 50 })
	} else {
		throw new Boom('No image processing library available')
	}

	return {
		img: await img
	}
}

/** gets the SHA256 of the given media message */
export const mediaMessageSHA256B64 = (message: WAMessageContent) => {
	const media = Object.values(message)[0] as WAGenericMediaMessage
	return media?.fileSha256 && Buffer.from(media.fileSha256).toString('base64')
}

export async function getAudioDuration(buffer: Buffer | string | Readable) {
	const musicMetadata = await import('music-metadata')
	let metadata: IAudioMetadata
	const options = {
		duration: true
	}
	if (Buffer.isBuffer(buffer)) {
		metadata = await musicMetadata.parseBuffer(buffer, undefined, options)
	} else if (typeof buffer === 'string') {
		metadata = await musicMetadata.parseFile(buffer, options)
	} else {
		metadata = await musicMetadata.parseStream(buffer, undefined, options)
	}

	return metadata.format.duration
}

/**
  referenced from and modifying https://github.com/wppconnect-team/wa-js/blob/main/src/chat/functions/prepareAudioWaveform.ts
 */
export async function getAudioWaveform(buffer: Buffer | string | Readable, logger?: ILogger) {
	try {
		// @ts-ignore
		const { default: decoder } = await import('audio-decode')
		let audioData: Buffer
		if (Buffer.isBuffer(buffer)) {
			audioData = buffer
		} else if (typeof buffer === 'string') {
			const rStream = createReadStream(buffer)
			audioData = await toBuffer(rStream)
		} else {
			audioData = await toBuffer(buffer)
		}

		const audioBuffer = await decoder(audioData)

		const rawData = audioBuffer.getChannelData(0) // We only need to work with one channel of data
		const samples = 64 // Number of samples we want to have in our final data set
		const blockSize = Math.floor(rawData.length / samples) // the number of samples in each subdivision
		const filteredData: number[] = []
		for (let i = 0; i < samples; i++) {
			const blockStart = blockSize * i // the location of the first sample in the block
			let sum = 0
			for (let j = 0; j < blockSize; j++) {
				sum = sum + Math.abs(rawData[blockStart + j]) // find the sum of all the samples in the block
			}

			filteredData.push(sum / blockSize) // divide the sum by the block size to get the average
		}

		// This guarantees that the largest data point will be set to 1, and the rest of the data will scale proportionally.
		const multiplier = Math.pow(Math.max(...filteredData), -1)
		const normalizedData = filteredData.map(n => n * multiplier)

		// Generate waveform like WhatsApp
		const waveform = new Uint8Array(normalizedData.map(n => Math.floor(100 * n)))

		return waveform
	} catch (e) {
		logger?.debug('Failed to generate waveform: ' + e)
	}
}

export const toReadable = (buffer: Buffer) => {
	const readable = new Readable({ read: () => {} })
	readable.push(buffer)
	readable.push(null)
	return readable
}

export const toBuffer = async (stream: Readable) => {
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}

	stream.destroy()
	return Buffer.concat(chunks)
}

export const getStream = async (item: WAMediaUpload, opts?: RequestInit & { maxContentLength?: number }) => {
	if (Buffer.isBuffer(item)) {
		return { stream: toReadable(item), type: 'buffer' } as const
	}

	if ('stream' in item) {
		return { stream: item.stream, type: 'readable' } as const
	}

	const urlStr = item.url.toString()

	if (urlStr.startsWith('data:')) {
		const buffer = Buffer.from(urlStr.split(',')[1]!, 'base64')
		return { stream: toReadable(buffer), type: 'buffer' } as const
	}

	if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
		return { stream: await getHttpStream(item.url, opts), type: 'remote' } as const
	}

	return { stream: createReadStream(item.url), type: 'file' } as const
}

/** generates a thumbnail for a given media, if required */
export async function generateThumbnail(
	file: string,
	mediaType: 'video' | 'image',
	options: {
		logger?: ILogger
	}
) {
	let thumbnail: string | undefined
	let originalImageDimensions: { width: number; height: number } | undefined
	if (mediaType === 'image') {
		const { buffer, original } = await extractImageThumb(file)
		thumbnail = buffer.toString('base64')
		if (original.width && original.height) {
			originalImageDimensions = {
				width: original.width,
				height: original.height
			}
		}
	} else if (mediaType === 'video') {
		const imgFilename = join(getTmpFilesDirectory(), generateMessageIDV2() + '.jpg')
		try {
			await extractVideoThumb(file, imgFilename, '00:00:00', { width: 32, height: 32 })
			const buff = await fs.readFile(imgFilename)
			thumbnail = buff.toString('base64')

			await fs.unlink(imgFilename)
		} catch (err) {
			options.logger?.debug('could not generate video thumb: ' + err)
		}
	}

	return {
		thumbnail,
		originalImageDimensions
	}
}

export const getHttpStream = async (url: string | URL, options: RequestInit & { isStream?: true } = {}) => {
	const response = await fetch(url.toString(), {
		dispatcher: options.dispatcher,
		method: 'GET',
		headers: options.headers as HeadersInit
	})
	if (!response.ok) {
		throw new Boom(`Failed to fetch stream from ${url}`, { statusCode: response.status, data: { url } })
	}

	// @ts-ignore Node18+ Readable.fromWeb exists
	return response.body instanceof Readable ? response.body : Readable.fromWeb(response.body as any)
}

type EncryptedStreamOptions = {
	saveOriginalFileIfRequired?: boolean
	logger?: ILogger
	opts?: RequestInit
	/** Optional mediaKey to reuse (required for sticker pack thumbnail to match ZIP encryption) */
	mediaKey?: Uint8Array
}

export const encryptedStream = async (
	media: WAMediaUpload,
	mediaType: MediaType,
	{ logger, saveOriginalFileIfRequired, opts, mediaKey: providedMediaKey }: EncryptedStreamOptions = {}
) => {
	const { stream, type } = await getStream(media, opts)

	logger?.debug('fetched media stream')

	// Use provided mediaKey or generate new one
	const mediaKey = providedMediaKey || Crypto.randomBytes(32)
	const { cipherKey, iv, macKey } = getMediaKeys(mediaKey, mediaType)

	const encFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-enc')
	const encFileWriteStream = createWriteStream(encFilePath)

	let originalFileStream: WriteStream | undefined
	let originalFilePath: string | undefined

	if (saveOriginalFileIfRequired) {
		originalFilePath = join(getTmpFilesDirectory(), mediaType + generateMessageIDV2() + '-original')
		originalFileStream = createWriteStream(originalFilePath)
	}

	let fileLength = 0
	const aes = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
	if (!macKey) {
		throw new Boom('Failed to derive media mac key')
	}

	const hmac = Crypto.createHmac('sha256', macKey).update(iv)
	const sha256Plain = Crypto.createHash('sha256')
	const sha256Enc = Crypto.createHash('sha256')

	const onChunk = async (buff: Buffer) => {
		sha256Enc.update(buff)
		hmac.update(buff)
		// Handle backpressure: if write returns false, wait for drain
		if (!encFileWriteStream.write(buff)) {
			await once(encFileWriteStream, 'drain')
		}
	}

	try {
		for await (const data of stream) {
			fileLength += data.length

			if (
				type === 'remote' &&
				(opts as any)?.maxContentLength &&
				fileLength + data.length > (opts as any).maxContentLength
			) {
				throw new Boom(`content length exceeded when encrypting "${type}"`, {
					data: { media, type }
				})
			}

			if (originalFileStream) {
				if (!originalFileStream.write(data)) {
					await once(originalFileStream, 'drain')
				}
			}

			sha256Plain.update(data)
			await onChunk(aes.update(data))
		}

		await onChunk(aes.final())

		const mac = hmac.digest().slice(0, 10)
		sha256Enc.update(mac)

		const fileSha256 = sha256Plain.digest()
		const fileEncSha256 = sha256Enc.digest()

		encFileWriteStream.write(mac)

		const encFinishPromise = once(encFileWriteStream, 'finish')
		const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve()

		encFileWriteStream.end()
		originalFileStream?.end?.()
		stream.destroy()

		// Wait for write streams to fully flush to disk
		// This helps reduce memory pressure by allowing OS to release buffers
		await encFinishPromise
		await originalFinishPromise

		logger?.debug('encrypted data successfully')

		return {
			mediaKey,
			originalFilePath,
			encFilePath,
			mac,
			fileEncSha256,
			fileSha256,
			fileLength
		}
	} catch (error) {
		// destroy all streams with error
		encFileWriteStream.destroy()
		originalFileStream?.destroy?.()
		aes.destroy()
		hmac.destroy()
		sha256Plain.destroy()
		sha256Enc.destroy()
		stream.destroy()

		try {
			await fs.unlink(encFilePath)
			if (originalFilePath) {
				await fs.unlink(originalFilePath)
			}
		} catch (err) {
			logger?.error({ err }, 'failed deleting tmp files')
		}

		throw error
	}
}

/**
 * Default WhatsApp media CDN host. Upstream #2432 renamed `DEF_HOST` to
 * `DEF_MEDIA_HOST` and exported it so per-socket callers can use it as a
 * baseline fallback when the server hasn't published an explicit host yet.
 */
export const DEF_MEDIA_HOST = 'mmg.whatsapp.net'

const AES_CHUNK_SIZE = 16

const toSmallestChunkSize = (num: number) => {
	return Math.floor(num / AES_CHUNK_SIZE) * AES_CHUNK_SIZE
}

export type MediaDownloadOptions = {
	startByte?: number
	endByte?: number
	options?: RequestInit
	/**
	 * Optional media host override (Upstream #2432). Falls back to
	 * `DEF_MEDIA_HOST` when the caller doesn't pass one — preserves the
	 * historical default behavior for every consumer that hasn't migrated
	 * to passing a per-socket host yet.
	 */
	host?: string
}

export const getUrlFromDirectPath = (directPath: string, host: string = DEF_MEDIA_HOST) =>
	`https://${host}${directPath}`

/**
 * SSRF allowlist (PR #490 review — Codex P1 / Copilot P1 / Cubic P2):
 *
 * The `url` field on a `DownloadableMessage` is the proto field populated by
 * the message SENDER. Treating an arbitrary host parsed from that field as
 * trusted enables a sender-controlled SSRF: send a message with
 * `url='https://attacker.example/track'` + `directPath='/v/t62...'`, and our
 * client would fetch `https://attacker.example/v/t62...`, leaking the
 * recipient's IP and the directPath (and exposing internal network reach
 * on any environment where ${ATTACKER} resolves to a private range).
 *
 * Restrict the host derived from `url` to the WhatsApp media CDN family —
 * any subdomain of `whatsapp.net`. CDN regional balancers (`mmg-fna.whatsapp.net`,
 * `media-gru1-1.cdn.whatsapp.net`, etc) still match; arbitrary attacker hosts
 * do not. Explicit `opts.host` from the caller bypasses this check because
 * callers are trusted (they decide what host to use).
 */
const WHATSAPP_HOST_SUFFIX = /(^|\.)whatsapp\.net$/i

/**
 * Best-effort parse of the hostname from a media URL. Used by
 * `downloadContentFromMessage` as a fallback when `opts.host` isn't
 * provided but the proto carried a full `url`. Silently returns undefined
 * for malformed inputs (the caller decides what to do).
 *
 * Returns `hostname` (not `host`) so URLs with explicit ports
 * (`https://mmg.whatsapp.net:443/...`) collapse to the bare hostname —
 * `getUrlFromDirectPath` re-applies the canonical `https://` scheme and an
 * embedded port would produce malformed URLs.
 */
const extractHost = (url: string | null | undefined): string | undefined => {
	if (!url) return undefined
	try {
		return new URL(url).hostname
	} catch {
		return undefined
	}
}

export const downloadContentFromMessage = async (
	{ mediaKey, directPath, url }: DownloadableMessage,
	type: MediaType,
	opts: MediaDownloadOptions = {}
) => {
	// PR #493 review P1-001 fix — restore the pre-port preference for the
	// proto's `url` when it is a WhatsApp CDN URL. Server-issued URLs for
	// `IExternalBlobReference` (app state) and `IHistorySyncNotification`
	// (history sync) carry SIGNED query params (`?ccb=&oh=&oe=&_nc_sid=`)
	// that `getUrlFromDirectPath` cannot reconstruct from `directPath`
	// alone — dropping them causes the CDN to return HTTP 403 on those
	// signed-URL paths.
	//
	// SSRF gate (PR #490): only trust `url` when its hostname matches the
	// `*.whatsapp.net` allowlist. Sender-controlled hostnames outside the
	// allowlist are still rejected (the old behavior `startsWith('https://mmg.whatsapp.net/')`
	// was stricter — this allowlist accepts regional balancers like
	// `mmg-fna.whatsapp.net` and `media-gru1-1.cdn.whatsapp.net` too).
	const urlHost = extractHost(url)
	const isTrustedWhatsappUrl = !!url && !!urlHost && WHATSAPP_HOST_SUFFIX.test(urlHost)

	let downloadUrl: string | undefined
	if (isTrustedWhatsappUrl) {
		// Preserve the server-signed URL verbatim — query params included.
		downloadUrl = url
	} else if (directPath) {
		// Fallback: build the URL from `directPath`. Honor `opts.host` if a
		// caller passed one (trusted); otherwise `getUrlFromDirectPath`
		// defaults to `DEF_MEDIA_HOST`. The sender-controlled host parsed
		// from `url` is NOT used here as a fallback — that was a separate
		// upstream #2432 path that we deliberately drop in favor of the
		// signed-URL preservation above (the two are mutually exclusive:
		// either we have a trusted full URL, or we build one from scratch).
		downloadUrl = getUrlFromDirectPath(directPath, opts.host)
	}

	if (!downloadUrl) {
		throw new Boom('No valid media URL or directPath present in message', { statusCode: 400 })
	}

	const keys = getMediaKeys(mediaKey, type)

	return downloadEncryptedContent(downloadUrl, keys, opts)
}

/**
 * Decrypts and downloads an AES256-CBC encrypted file given the keys.
 * Assumes the SHA256 of the plaintext is appended to the end of the ciphertext
 * */
// HMAC verification (audit UTL-01) — IMPLEMENTED below as of this PR.
// The WhatsApp media protocol appends a 10-byte
// HMAC-SHA256(macKey, iv || ciphertext)[:10] trailer to every encrypted
// blob (see `messageVerificationMacInfo` in `getMediaKeys`). The Transform
// below reserves the trailing 10 bytes of the stream, recomputes the HMAC
// across the ciphertext, and rejects with Boom 401 on mismatch.
//
// Verification is gated on `macKey && !range-request && !firstBlockIsIV`
// because the trailer is only present at the end of a full download —
// range fetches and IV-prefixed chunked downloads don't include it.
export const downloadEncryptedContent = async (
	downloadUrl: string,
	{ cipherKey, iv, macKey }: MediaDecryptionKeyInfo,
	{ startByte, endByte, options }: MediaDownloadOptions = {}
) => {
	let bytesFetched = 0
	let startChunk = 0
	let firstBlockIsIV = false
	// if a start byte is specified -- then we need to fetch the previous chunk as that will form the IV
	if (startByte) {
		const chunk = toSmallestChunkSize(startByte || 0)
		if (chunk) {
			startChunk = chunk - AES_CHUNK_SIZE
			bytesFetched = chunk

			firstBlockIsIV = true
		}
	}

	const endChunk = endByte ? toSmallestChunkSize(endByte || 0) + AES_CHUNK_SIZE : undefined

	const headersInit = options?.headers ? options.headers : undefined
	const headers: Record<string, string> = {
		...(headersInit
			? Array.isArray(headersInit)
				? Object.fromEntries(headersInit)
				: (headersInit as Record<string, string>)
			: {}),
		Origin: DEFAULT_ORIGIN
	}
	if (startChunk || endChunk) {
		headers.Range = `bytes=${startChunk}-`
		if (endChunk) {
			headers.Range += endChunk
		}
	}

	// download the message
	const fetched = await getHttpStream(downloadUrl, {
		...(options || {}),
		headers
	})

	let remainingBytes = Buffer.from([])

	let aes: Crypto.Decipher

	const pushBytes = (bytes: Buffer, push: (bytes: Buffer) => void) => {
		if (startByte || endByte) {
			const start = bytesFetched >= (startByte ?? 0) ? undefined : Math.max((startByte ?? 0) - bytesFetched, 0)
			const end = bytesFetched + bytes.length < (endByte ?? 0) ? undefined : Math.max((endByte ?? 0) - bytesFetched, 0)

			push(bytes.slice(start, end))

			bytesFetched += bytes.length
		} else {
			push(bytes)
		}
	}

	// audit UTL-01 — HMAC verification:
	//   spec: trailer = HMAC-SHA256(macKey, iv || ciphertext)[:10]
	//
	// Verified only on FULL downloads. Range requests (`startByte`/`endByte`)
	// don't include the trailer, and `firstBlockIsIV` replaces the IV in-
	// stream so we can't deterministically reconstruct what was HMAC'd
	// without buffering the whole thing. Skipping there keeps the
	// streaming/range fast path intact while closing the gap for the
	// common full-download case the audit was concerned about.
	const isRangeRequest = !!startByte || !!endByte
	const verifyMac = !!macKey && !isRangeRequest && !firstBlockIsIV
	const HMAC_TRAILER_LEN = 10
	const hmac = verifyMac ? Crypto.createHmac('sha256', macKey!).update(iv) : null
	let trailerBuf = Buffer.alloc(0)

	const output = new Transform({
		transform(chunk, _, callback) {
			// Reserve the trailing 10 bytes of the entire stream as the
			// HMAC trailer. Anything before that is real ciphertext.
			let chunkAfterTrailer: Buffer = chunk
			if (verifyMac) {
				const combined = trailerBuf.length ? Buffer.concat([trailerBuf, chunk]) : chunk
				if (combined.length <= HMAC_TRAILER_LEN) {
					trailerBuf = combined
					callback()
					return
				}

				chunkAfterTrailer = combined.subarray(0, combined.length - HMAC_TRAILER_LEN)
				trailerBuf = combined.subarray(combined.length - HMAC_TRAILER_LEN)
			}

			let data = remainingBytes.length ? Buffer.concat([remainingBytes, chunkAfterTrailer]) : chunkAfterTrailer

			const decryptLength = toSmallestChunkSize(data.length)
			remainingBytes = data.slice(decryptLength)
			data = data.slice(0, decryptLength)

			if (!aes) {
				let ivValue = iv
				if (firstBlockIsIV) {
					ivValue = data.slice(0, AES_CHUNK_SIZE)
					data = data.slice(AES_CHUNK_SIZE)
				}

				aes = Crypto.createDecipheriv('aes-256-cbc', cipherKey, ivValue)
				// if an end byte that is not EOF is specified
				// stop auto padding (PKCS7) -- otherwise throws an error for decryption
				if (endByte) {
					aes.setAutoPadding(false)
				}
			}

			try {
				hmac?.update(data)
				pushBytes(aes.update(data), b => this.push(b))
				callback()
			} catch (error: any) {
				callback(error)
			}
		},
		final(callback) {
			try {
				if (verifyMac && hmac) {
					// Feed the tail bytes (the 0–15 bytes left in
					// `remainingBytes` from the very last chunk after the
					// AES-block-size alignment) into the HMAC before we
					// digest. Without this, the trailing bytes that
					// `aes.final()` will decrypt are NOT covered by the MAC,
					// leaving a small but real window for an attacker who
					// can flip those bytes without us noticing.
					// (audit thread 13)
					if (remainingBytes.length) {
						hmac.update(remainingBytes)
					}

					const expected = hmac.digest().subarray(0, HMAC_TRAILER_LEN)
					if (trailerBuf.length !== HMAC_TRAILER_LEN || !Crypto.timingSafeEqual(expected, trailerBuf)) {
						return callback(
							new Boom('media HMAC verification failed', {
								statusCode: 401,
								data: { gotLen: trailerBuf.length, want: HMAC_TRAILER_LEN }
							})
						)
					}
				}

				// audit UTL-P0 — if the entire stream was ≤ HMAC_TRAILER_LEN
				// bytes, `transform` never reached the `aes` initialiser
				// (all incoming bytes were held back as trailer candidates).
				// `aes.final()` would then throw `TypeError: Cannot read
				// properties of undefined` and crash the consumer. Surface
				// it as a typed Boom 400 so the caller can handle it.
				if (!aes) {
					return callback(
						new Boom('media stream too short — no ciphertext bytes received', {
							statusCode: 400
						})
					)
				}

				pushBytes(aes.final(), b => this.push(b))
				callback()
			} catch (error: any) {
				callback(error)
			}
		}
	})
	return fetched.pipe(output, { end: true })
}

export function extensionForMediaMessage(message: WAMessageContent) {
	const getExtension = (mimetype: string) => mimetype.split(';')[0]?.split('/')[1]
	const type = Object.keys(message)[0] as Exclude<MessageType, 'toJSON'>
	let extension: string
	if (type === 'locationMessage' || type === 'liveLocationMessage' || type === 'productMessage') {
		extension = '.jpeg'
	} else {
		const messageContent = message[type] as WAGenericMediaMessage
		extension = getExtension(messageContent.mimetype!)!
	}

	return extension
}

const isNodeRuntime = (): boolean => {
	return (
		typeof process !== 'undefined' &&
		process.versions?.node !== null &&
		typeof process.versions.bun === 'undefined' &&
		typeof (globalThis as any).Deno === 'undefined'
	)
}

type MediaUploadResult = {
	url?: string
	direct_path?: string
	meta_hmac?: string
	ts?: number
	fbid?: number
}

export type UploadParams = {
	url: string
	filePath: string
	headers: Record<string, string>
	timeoutMs?: number
	agent?: Agent
}

export const uploadWithNodeHttp = async (
	{ url, filePath, headers, timeoutMs, agent }: UploadParams,
	redirectCount = 0
): Promise<MediaUploadResult | undefined> => {
	if (redirectCount > 5) {
		throw new Error('Too many redirects')
	}

	const parsedUrl = new URL(url)
	const httpModule = parsedUrl.protocol === 'https:' ? await import('https') : await import('http')

	// Get file size for Content-Length header (required for Node.js streaming)
	const fileStats = await fs.stat(filePath)
	const fileSize = fileStats.size

	return new Promise((resolve, reject) => {
		const req = httpModule.request(
			{
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
				path: parsedUrl.pathname + parsedUrl.search,
				method: 'POST',
				headers: {
					...headers,
					'Content-Length': fileSize
				},
				agent,
				timeout: timeoutMs
			},
			res => {
				// Handle redirects (3xx)
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume() // Consume response to free resources
					const newUrl = new URL(res.headers.location, url).toString()
					resolve(
						uploadWithNodeHttp(
							{
								url: newUrl,
								filePath,
								headers,
								timeoutMs,
								agent
							},
							redirectCount + 1
						)
					)
					return
				}

				let body = ''
				res.on('data', chunk => (body += chunk))
				res.on('end', () => {
					try {
						resolve(JSON.parse(body))
					} catch {
						resolve(undefined)
					}
				})
			}
		)

		req.on('error', reject)
		req.on('timeout', () => {
			req.destroy()
			reject(new Error('Upload timeout'))
		})

		const stream = createReadStream(filePath)
		stream.pipe(req)
		stream.on('error', err => {
			req.destroy()
			reject(err)
		})
	})
}

const uploadWithFetch = async ({
	url,
	filePath,
	headers,
	timeoutMs,
	agent
}: UploadParams): Promise<MediaUploadResult | undefined> => {
	// Convert Node.js Readable to Web ReadableStream
	const nodeStream = createReadStream(filePath)
	const webStream = Readable.toWeb(nodeStream) as ReadableStream
	// Native fetch only accepts Undici-style dispatchers, not generic https Agents.
	const dispatcher = typeof (agent as { dispatch?: unknown } | undefined)?.dispatch === 'function' ? agent : undefined

	const response = await fetch(url, {
		...(dispatcher ? { dispatcher } : {}),
		method: 'POST',
		body: webStream,
		headers,
		duplex: 'half',
		signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
	})

	try {
		return (await response.json()) as MediaUploadResult
	} catch {
		return undefined
	}
}

/**
 * Uploads media to WhatsApp servers.
 *
 * ## Why we have two upload implementations:
 *
 * Node.js's native `fetch` (powered by undici) has a known bug where it buffers
 * the entire request body in memory before sending, even when using streams.
 * This causes memory issues with large files (e.g., 1GB file = 1GB+ memory usage).
 * See: https://github.com/nodejs/undici/issues/4058
 *
 * Other runtimes (Bun, Deno, browsers) correctly stream the request body without
 * buffering, so we can use the web-standard Fetch API there.
 *
 * ## Future considerations:
 * Once the undici bug is fixed, we can simplify this to use only the Fetch API
 * across all runtimes. Monitor the GitHub issue for updates.
 */
const uploadMedia = async (params: UploadParams, logger?: ILogger): Promise<MediaUploadResult | undefined> => {
	if (isNodeRuntime()) {
		logger?.debug('Using Node.js https module for upload (avoids undici buffering bug)')
		return uploadWithNodeHttp(params)
	} else {
		logger?.debug('Using web-standard Fetch API for upload')
		return uploadWithFetch(params)
	}
}

export const getWAUploadToServer = (
	{ customUploadHosts, fetchAgent, logger, options }: SocketConfig,
	refreshMediaConn: (force: boolean) => Promise<MediaConnInfo>
): WAMediaUploadFunction => {
	return async (filePath, { mediaType, fileEncSha256B64, timeoutMs, newsletter }) => {
		// send a query JSON to obtain the url & auth token to upload our media
		let uploadInfo = await refreshMediaConn(false)

		let urls: { mediaUrl: string; directPath: string; meta_hmac?: string; ts?: number; fbid?: number } | undefined
		const hosts = [...customUploadHosts, ...uploadInfo.hosts]

		fileEncSha256B64 = encodeBase64EncodedStringForUpload(fileEncSha256B64)

		// Prepare common headers
		const customHeaders = (() => {
			const hdrs = options?.headers
			if (!hdrs) return {}
			return Array.isArray(hdrs) ? Object.fromEntries(hdrs) : (hdrs as Record<string, string>)
		})()

		const headers = {
			...customHeaders,
			'Content-Type': 'application/octet-stream',
			Origin: DEFAULT_ORIGIN
		}

		const pathMap = newsletter ? NEWSLETTER_MEDIA_PATH_MAP : MEDIA_PATH_MAP
		const pathSegment = pathMap[mediaType]
		// Use explicit `=== undefined` rather than falsy check: some valid map
		// entries are empty strings (e.g. `md-app-state: ''`). Treating those
		// as "missing path" would throw an unintended error for callers that
		// hit those flows.
		if (pathSegment === undefined) {
			throw new Error(
				`No upload path configured for mediaType=${mediaType}` +
					(newsletter ? ' in NEWSLETTER_MEDIA_PATH_MAP' : ' in MEDIA_PATH_MAP')
			)
		}

		for (const { hostname } of hosts) {
			logger.debug(`uploading to "${hostname}"`)

			const auth = encodeURIComponent(uploadInfo.auth)
			let url = `https://${hostname}${pathSegment}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`

			// Newsletter upload hints, mirroring upstream PR #2434.
			//
			// Empirically grounded against WA Web 2.3000.x JS source on
			// 2026-06-05 — both literals are present in chunk MEhTUFr43MH.js:
			//
			//   server_thumb_gen: (c?.server_thumb_gen) != null ? "1" : void 0
			//   server_transcode: m === "newsletter-video" &&
			//                     o("WAWebABProps").getABPropConfigVa(...)
			//
			// In the official client, `server_thumb_gen=1` is gated on a per-
			// upload config and `server_transcode=1` is gated on an A/B test
			// firing only for `newsletter-video`. In our 5-minute CDP capture
			// neither toggle was set, so the official traffic did not include
			// either param — and the upload still succeeded. The server treats
			// both as hints, so always sending them is the safe default and
			// matches the behavior @alesdi documented on PR #2434.
			//
			// We send `server_transcode=1` for video / gif / ptv (slightly
			// broader than the JS literal, which only mentions newsletter-video)
			// to preserve parity with the upstream PR.
			if (newsletter) {
				url += '&server_thumb_gen=1'
				if (mediaType === 'video' || mediaType === 'gif' || mediaType === 'ptv') {
					url += '&server_transcode=1'
				}
			}

			let result: MediaUploadResult | undefined
			try {
				result = await uploadMedia(
					{
						url,
						filePath,
						headers,
						timeoutMs,
						agent: fetchAgent
					},
					logger
				)

				if (result?.url || result?.direct_path) {
					urls = {
						mediaUrl: result.url!,
						directPath: result.direct_path!,
						meta_hmac: result.meta_hmac,
						fbid: result.fbid,
						ts: result.ts
					}
					break
				} else {
					uploadInfo = await refreshMediaConn(true)
					throw new Error(`upload failed, reason: ${JSON.stringify(result)}`)
				}
			} catch (error: any) {
				const isLast = hostname === hosts[uploadInfo.hosts.length - 1]?.hostname
				logger.warn(
					{ trace: error?.stack, uploadResult: result },
					`Error in uploading to ${hostname} ${isLast ? '' : ', retrying...'}`
				)
			}
		}

		if (!urls) {
			throw new Boom('Media upload failed on all hosts', { statusCode: 500 })
		}

		return urls
	}
}

const getMediaRetryKey = (mediaKey: Buffer | Uint8Array) => {
	return hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
}

/**
 * Generate a binary node that will request the phone to re-upload the media & return the newly uploaded URL
 */
export const encryptMediaRetryRequest = (key: WAMessageKey, mediaKey: Buffer | Uint8Array, meId: string) => {
	if (!key.id) {
		throw new Boom('Missing message ID for media retry request')
	}

	if (!key.remoteJid) {
		throw new Boom('Missing remote JID for media retry request')
	}

	const recp: proto.IServerErrorReceipt = { stanzaId: key.id }
	const recpBuffer = proto.ServerErrorReceipt.encode(recp).finish()

	const iv = Crypto.randomBytes(12)
	const retryKey = getMediaRetryKey(mediaKey)
	const ciphertext = aesEncryptGCM(recpBuffer, retryKey, iv, Buffer.from(key.id))

	const req: BinaryNode = {
		tag: 'receipt',
		attrs: {
			id: key.id,
			to: jidNormalizedUser(meId),
			type: 'server-error'
		},
		content: [
			// this encrypt node is actually pretty useless
			// the media is returned even without this node
			// keeping it here to maintain parity with WA Web
			{
				tag: 'encrypt',
				attrs: {},
				content: [
					{ tag: 'enc_p', attrs: {}, content: ciphertext },
					{ tag: 'enc_iv', attrs: {}, content: iv }
				]
			},
			{
				tag: 'rmr',
				attrs: {
					jid: key.remoteJid,
					from_me: (!!key.fromMe).toString(),
					// @ts-ignore
					participant: key.participant || undefined
				}
			}
		]
	}

	return req
}

export const decodeMediaRetryNode = (node: BinaryNode) => {
	const rmrNode = getBinaryNodeChild(node, 'rmr')
	if (!rmrNode) {
		throw new Boom('Missing rmr node in media retry response')
	}

	const event: BaileysEventMap['messages.media-update'][number] = {
		key: {
			id: node.attrs.id,
			remoteJid: rmrNode.attrs.jid,
			fromMe: rmrNode.attrs.from_me === 'true',
			participant: rmrNode.attrs.participant
		}
	}

	const errorNode = getBinaryNodeChild(node, 'error')
	if (errorNode) {
		const errorCode = +(errorNode.attrs.code ?? '0')
		event.error = new Boom(`Failed to re-upload media (${errorCode})`, {
			data: errorNode.attrs,
			statusCode: getStatusCodeForMediaRetry(errorCode)
		})
	} else {
		const encryptedInfoNode = getBinaryNodeChild(node, 'encrypt')
		const ciphertext = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_p')
		const iv = getBinaryNodeChildBuffer(encryptedInfoNode, 'enc_iv')
		if (ciphertext && iv) {
			event.media = { ciphertext, iv }
		} else {
			event.error = new Boom('Failed to re-upload media (missing ciphertext)', { statusCode: 404 })
		}
	}

	return event
}

export const decryptMediaRetryData = (
	{ ciphertext, iv }: { ciphertext: Uint8Array; iv: Uint8Array },
	mediaKey: Uint8Array,
	msgId: string
) => {
	const retryKey = getMediaRetryKey(mediaKey)
	const plaintext = aesDecryptGCM(ciphertext, retryKey, iv, Buffer.from(msgId))
	return proto.MediaRetryNotification.decode(plaintext)
}

export const getStatusCodeForMediaRetry = (code: number) =>
	MEDIA_RETRY_STATUS_MAP[code as proto.MediaRetryNotification.ResultType]

const MEDIA_RETRY_STATUS_MAP = {
	[proto.MediaRetryNotification.ResultType.SUCCESS]: 200,
	[proto.MediaRetryNotification.ResultType.DECRYPTION_ERROR]: 412,
	[proto.MediaRetryNotification.ResultType.NOT_FOUND]: 404,
	[proto.MediaRetryNotification.ResultType.GENERAL_ERROR]: 418
} as const
