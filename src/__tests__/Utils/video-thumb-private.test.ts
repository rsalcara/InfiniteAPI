import { jest } from '@jest/globals'
import { existsSync, statSync, writeFileSync } from 'fs'

/**
 * Audit G-03: the video thumbnail ffmpeg writes into the media temporary
 * directory must be 0600 like every other media temporary, and must not stay
 * behind. ffmpeg is simulated: like the real one with -y, it overwrites the
 * destination in place.
 */
const written: Array<{ path: string; mode: number }> = []
let ffmpegFails = false

jest.unstable_mockModule('child_process', () => ({
	execFile: (_cmd: string, args: string[], callback: (err: Error | null) => void) => {
		const dest = args[args.length - 1]!
		if (ffmpegFails) return callback(new Error('ffmpeg failed'))
		writeFileSync(dest, Buffer.from([0xff, 0xd8, 0xff]))
		written.push({ path: dest, mode: statSync(dest).mode & 0o777 })
		callback(null)
	}
}))

const { generateThumbnail } = await import('../../Utils/messages-media')

const posixIt = process.platform === 'win32' ? it.skip : it

describe('video thumbnail temporary', () => {
	beforeEach(() => {
		written.length = 0
		ffmpegFails = false
	})

	posixIt('is written 0600 and removed afterwards', async () => {
		const previousUmask = process.umask(0o022)
		try {
			const { thumbnail } = await generateThumbnail('/dev/null', 'video', {})
			expect(thumbnail).toBe(Buffer.from([0xff, 0xd8, 0xff]).toString('base64'))
			expect(written).toHaveLength(1)
			expect(written[0]!.mode).toBe(0o600)
			expect(existsSync(written[0]!.path)).toBe(false)
		} finally {
			process.umask(previousUmask)
		}
	})

	it('does not stay behind when ffmpeg fails', async () => {
		ffmpegFails = true
		const { thumbnail } = await generateThumbnail('/dev/null', 'video', {})
		expect(thumbnail).toBeUndefined()
		const { getTmpFilesDirectory } = await import('../../Utils/messages-media')
		const { readdirSync } = await import('fs')
		expect(readdirSync(getTmpFilesDirectory()).filter(name => name.endsWith('.jpg'))).toEqual([])
	})
})
