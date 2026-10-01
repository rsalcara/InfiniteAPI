import { chmodSync, closeSync, mkdirSync, openSync } from 'fs'
import { chmod, mkdir } from 'fs/promises'

/**
 * Session material (credentials, Signal keys, message stores) and decrypted
 * media must be readable only by the process owner. The app gets this from
 * its UID-private sandbox; on a server the equivalent is 0700 directories and
 * 0600 files (audit S-01 / G-03).
 *
 * `mode` on mkdir/open only applies when the entry is created, so existing
 * entries are corrected with an explicit chmod. POSIX permission bits do not
 * apply on Windows, where these helpers only create.
 *
 * Correcting an existing entry needs ownership. When the process does not own
 * it (shared volume, container with another UID), chmod fails with EPERM; the
 * session must keep opening as before, so that case is tolerated and reported
 * as `false` instead of failing startup.
 */
export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

const POSIX = process.platform !== 'win32'

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
const notOwned = (error: unknown) => errorCode(error) === 'EPERM'

/**
 * Creates `dir` (and missing parents) private, and restricts `dir` itself if
 * it already existed. Returns false when an existing dir is not ours to chmod.
 */
export const ensurePrivateDir = async (dir: string): Promise<boolean> => {
	await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
	if (!POSIX) return true
	try {
		await chmod(dir, PRIVATE_DIR_MODE)
		return true
	} catch (error) {
		if (notOwned(error)) return false
		throw error
	}
}

export const ensurePrivateDirSync = (dir: string): boolean => {
	mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
	if (!POSIX) return true
	try {
		chmodSync(dir, PRIVATE_DIR_MODE)
		return true
	} catch (error) {
		if (notOwned(error)) return false
		throw error
	}
}

/**
 * Restricts an existing file to 0600. A missing file is not an error; a file
 * that is not ours to chmod returns false.
 */
export const restrictFile = async (file: string): Promise<boolean> => {
	if (!POSIX) return true
	try {
		await chmod(file, PRIVATE_FILE_MODE)
		return true
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return true
		if (notOwned(error)) return false
		throw error
	}
}

export const restrictFileSync = (file: string): boolean => {
	if (!POSIX) return true
	try {
		chmodSync(file, PRIVATE_FILE_MODE)
		return true
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return true
		if (notOwned(error)) return false
		throw error
	}
}

/**
 * Restricts an open file handle to 0600 (used on temporaries before rename).
 * A handle on a file owned by another user (writable through group/ACL)
 * returns false instead of aborting the write.
 */
export const restrictHandle = async (handle: { chmod(mode: number): Promise<void> }): Promise<boolean> => {
	if (!POSIX) return true
	try {
		await handle.chmod(PRIVATE_FILE_MODE)
		return true
	} catch (error) {
		if (notOwned(error)) return false
		throw error
	}
}

/**
 * Creates `file` empty with 0600 if missing (and restricts it if present),
 * so a SQLite database is never created with the umask default. SQLite gives
 * its -wal/-shm/-journal files the permissions of the database file.
 */
export const ensurePrivateFileSync = (file: string): boolean => {
	closeSync(openSync(file, 'a', PRIVATE_FILE_MODE))
	return restrictFileSync(file)
}
