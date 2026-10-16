import { spawnSync } from 'child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { uploadingNecessaryImages } from '../../Utils/business'
import {
	getRawMediaUploadData,
	getTmpFilesDirectory,
	removeTmpFiles,
	sweepStaleMediaTmpDirectories
} from '../../Utils/messages-media'
import { useMultiFileAuthState } from '../../Utils/use-multi-file-auth-state'
import { useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const mode = (path: string) => statSync(path).mode & 0o777
const posix = process.platform !== 'win32'
const posixIt = posix ? it : it.skip

/**
 * Audit S-01 / G-03: session material and media temporaries are private to
 * the process owner (0700 directories, 0600 files), including sessions and
 * files created before this rule.
 */
describe('private session and media files', () => {
	let base: string
	let previousUmask: number

	beforeEach(() => {
		previousUmask = process.umask(0o022)
		base = mkdtempSync(join(tmpdir(), 'private-files-'))
	})

	afterEach(() => {
		process.umask(previousUmask)
		rmSync(base, { recursive: true, force: true })
	})

	posixIt('corrects an existing multi-file session created with open permissions', async () => {
		const folder = join(base, 'legacy-session')
		mkdirSync(folder, { mode: 0o755 })
		chmodSync(folder, 0o755)
		writeFileSync(join(folder, 'creds.json'), '{}', { mode: 0o644 })
		writeFileSync(join(folder, 'session-123.json'), '{}', { mode: 0o644 })

		const { saveCreds } = await useMultiFileAuthState(folder)
		await saveCreds()

		expect(mode(folder)).toBe(0o700)
		expect(mode(join(folder, 'creds.json'))).toBe(0o600)
		expect(mode(join(folder, 'session-123.json'))).toBe(0o600)
	})

	posixIt('creates the single-file SQLite auth database and its WAL 0600', async () => {
		const dbPath = join(base, 'auth.db')
		const { saveCreds, close } = await useSqliteAuthState({ dbPath })
		await saveCreds()
		try {
			expect(mode(dbPath)).toBe(0o600)
			if (existsSync(`${dbPath}-wal`)) expect(mode(`${dbPath}-wal`)).toBe(0o600)
		} finally {
			close()
		}
	})

	posixIt('restricts the database SQLite really opened when the path is a file: URI', async () => {
		// Drivers differ: better-sqlite3 opens the literal name, node:sqlite the URI.
		const previousCwd = process.cwd()
		process.chdir(base)
		try {
			const { saveCreds, close } = await useSqliteAuthState({ dbPath: 'file:uri-auth.db' })
			await saveCreds()
			close()
		} finally {
			process.chdir(previousCwd)
		}

		const created = ['uri-auth.db', 'file:uri-auth.db'].map(name => join(base, name)).filter(existsSync)
		expect(created).toHaveLength(1)
		expect(mode(created[0]!)).toBe(0o600)
	})

	posixIt('closes, uploads and removes the catalog image, also when the upload fails', async () => {
		const image = Buffer.alloc(256 * 1024, 7)
		let uploaded: Buffer | undefined
		let uploadedPath = ''
		const { url } = (
			await uploadingNecessaryImages([image], async filePath => {
				uploadedPath = filePath
				uploaded = readFileSync(filePath)
				expect(mode(filePath)).toBe(0o600)
				return { mediaUrl: 'unused', directPath: '/v/t62/catalog.jpg' }
			})
		)[0]!
		expect(url).toContain('/v/t62/catalog.jpg')
		expect(uploaded?.equals(image)).toBe(true)
		expect(existsSync(uploadedPath)).toBe(false)

		await expect(
			uploadingNecessaryImages([image], async filePath => {
				uploadedPath = filePath
				throw new Error('upload failed')
			})
		).rejects.toThrow('upload failed')
		expect(existsSync(uploadedPath)).toBe(false)
	})

	posixIt('keeps media temporaries in a 0700 directory with 0600 files', async () => {
		const directory = getTmpFilesDirectory()
		expect(directory.startsWith(join(tmpdir(), 'infiniteapi-media-'))).toBe(true)
		expect(mode(directory)).toBe(0o700)

		const { filePath } = await getRawMediaUploadData(Buffer.from('decrypted media'), 'image')
		try {
			expect(filePath.startsWith(directory)).toBe(true)
			expect(mode(filePath)).toBe(0o600)
		} finally {
			await removeTmpFiles([filePath])
		}
	})

	it('removes every temporary even when one removal fails', async () => {
		const directory = getTmpFilesDirectory()
		const blocking = join(directory, 'not-removable')
		mkdirSync(blocking)
		writeFileSync(join(blocking, 'child'), 'x')
		const first = join(directory, 'enc-file')
		const second = join(directory, 'original-file')
		writeFileSync(first, 'enc')
		writeFileSync(second, 'original')

		await removeTmpFiles([first, blocking, second])

		expect(existsSync(first)).toBe(false)
		expect(existsSync(second)).toBe(false)
		rmSync(blocking, { recursive: true, force: true })
	})

	it('recreates the media directory if it was removed while the process runs', () => {
		const directory = getTmpFilesDirectory()
		rmSync(directory, { recursive: true, force: true })
		const recreated = getTmpFilesDirectory()
		expect(existsSync(recreated)).toBe(true)
	})
})

describe('stale media temporaries sweep', () => {
	const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
	const makeOwnedDir = (pid: number, old: boolean) => {
		const dir = mkdtempSync(join(tmpdir(), `infiniteapi-media-${pid}-`))
		writeFileSync(join(dir, 'original'), 'decrypted')
		if (old) utimesSync(dir, twoDaysAgo(), twoDaysAgo())
		return dir
	}

	it('removes only directories whose owner process is gone and that are older than a day', () => {
		// A pid that existed and has exited.
		const deadPid = spawnSync(process.execPath, ['-e', '']).pid
		const deadAndOld = makeOwnedDir(deadPid, true)
		const deadButRecent = makeOwnedDir(deadPid, false)
		// An idle instance under the same UID: alive owner, old directory.
		const aliveAndOld = makeOwnedDir(process.ppid, true)
		const ownAndOld = makeOwnedDir(process.pid, true)
		const created = [deadAndOld, deadButRecent, aliveAndOld, ownAndOld]

		try {
			sweepStaleMediaTmpDirectories()

			expect(existsSync(deadAndOld)).toBe(false)
			expect(existsSync(deadButRecent)).toBe(true)
			expect(existsSync(aliveAndOld)).toBe(true)
			expect(existsSync(ownAndOld)).toBe(true)
		} finally {
			for (const dir of created) rmSync(dir, { recursive: true, force: true })
		}
	})

	it('names its own directory after this process', () => {
		expect(getTmpFilesDirectory().startsWith(join(tmpdir(), `infiniteapi-media-${process.pid}-`))).toBe(true)
	})
})
