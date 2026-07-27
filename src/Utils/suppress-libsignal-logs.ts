/**
 * Optional console filter for libsignal's noisy `console.log` /
 * `console.info` / `console.error` calls.
 *
 * Background: `libsignal/session_record.js` dumps full session objects on
 * every close ("Closing session", "Removing old closed session") and emits
 * Bad MAC / counter / decrypt errors as raw stack traces. For a gateway
 * that handles thousands of sessions, the raw output drowns out everything
 * else and noticeably hurts I/O. This module installs a narrow filter
 * that:
 *   - Suppresses the two session-lifecycle log lines outright.
 *   - Collapses repeated `Bad MAC` / `MessageCounterError` / `Failed to
 *     decrypt` errors (originating from libsignal frames in the stack)
 *     into a single masked one-line summary, deduplicated within a 150 ms
 *     window per `(errorType, jid)` pair.
 *
 * History: this code used to live at the top of `src/index.ts` and ran as
 * an import side effect. That meant any consumer of the library — even
 * one importing only types — had their process-wide `console` rewritten.
 * Moving it into an explicit installer avoids an import-time dependency on
 * the Socket graph. `src/prelude.ts` always installs diagnostic capture; the
 * `INFINITEAPI_DISABLE_LIBSIGNAL_LOG_FILTER` flag controls only whether the
 * noisy output is suppressed.
 */

import { AsyncLocalStorage } from 'async_hooks'

const SESSION_LIFECYCLE_RE = /^(Closing session|Removing old closed session)/

let installed = false
let suppressOutput = true

export type LibsignalFailureKind =
	| 'bad-mac'
	| 'message-counter'
	| 'key-already-used'
	| 'decrypt-failed'
	| 'session-error'

export interface LibsignalFailureDiagnostic {
	kind: LibsignalFailureKind
}

/**
 * `libsignal` tries every stored session and logs each candidate failure, but
 * ultimately throws only `No matching sessions found for message`. Keep the
 * non-secret failure classes in the async decrypt context so callers can send
 * the same retry reason as the official client. Ciphertext, keys, stacks and
 * unmasked phone numbers are deliberately not retained here.
 */
const diagnosticContext = new AsyncLocalStorage<LibsignalFailureDiagnostic[]>()

export const recordLibsignalFailureDiagnostic = (message: string): LibsignalFailureKind | undefined => {
	const failureKind = classifyLibsignalFailure(message)
	if (failureKind) diagnosticContext.getStore()?.push({ kind: failureKind })
	return failureKind
}

export class LibsignalDecryptError extends Error {
	constructor(
		message: string,
		readonly diagnostics: readonly LibsignalFailureDiagnostic[],
		readonly originalError: unknown
	) {
		super(message)
		this.name = 'LibsignalDecryptError'
		;(this as Error & { cause?: unknown }).cause = originalError
	}
}

export const classifyLibsignalFailure = (message: string): LibsignalFailureKind | undefined => {
	if (message.includes('Bad MAC')) return 'bad-mac'
	if (message.includes('MessageCounterError')) return 'message-counter'
	if (message.includes('Key used already')) return 'key-already-used'
	if (message.includes('Failed to decrypt')) return 'decrypt-failed'
	if (message.includes('Session error')) return 'session-error'
	return undefined
}

const ownDiagnosticFrame = /[\\/]suppress-libsignal-logs\.(?:[cm]?[jt]s)(?::\d+:\d+)?\)?$/i
const libsignalFrame =
	/(?:[\\/]node_modules[\\/](?:@whiskeysockets[\\/])?libsignal[\\/]|[\\/]libsignal[\\/]|session_cipher\.)/i

/**
 * Match the real caller frames only. The interceptor itself has "libsignal"
 * in its filename, so testing the complete stack would classify every
 * application console.error as a Signal failure.
 */
export const isLibsignalCallerStack = (stack: string): boolean =>
	stack
		.split('\n')
		.map(line => line.trim())
		.filter(line => line && !ownDiagnosticFrame.test(line))
		.some(line => libsignalFrame.test(line))

const safeErrorMessage = (value: unknown): string => {
	if (typeof value === 'string') return value
	if (!(value instanceof Error)) return ''
	try {
		return typeof value.message === 'string' ? value.message : ''
	} catch {
		return ''
	}
}

export async function withLibsignalDiagnosticCapture<T>(work: () => Promise<T>): Promise<T> {
	const diagnostics: LibsignalFailureDiagnostic[] = []
	try {
		return await diagnosticContext.run(diagnostics, work)
	} catch (error) {
		if (error instanceof LibsignalDecryptError || diagnostics.length === 0) throw error

		const hasBadMac = diagnostics.some(item => item.kind === 'bad-mac')
		const fallbackMessage = error instanceof Error ? error.message : String(error)
		throw new LibsignalDecryptError(hasBadMac ? 'Bad MAC' : fallbackMessage, [...diagnostics], error)
	}
}

/**
 * Install the libsignal diagnostic interceptor. Safe to call multiple times;
 * subsequent calls update only the suppression preference. The interceptor
 * is intentionally not removable because candidate failure capture must stay
 * active for the lifetime of the gateway.
 */
export type LibsignalDiagnosticOptions = {
	suppressLogs?: boolean
}

/**
 * Install the diagnostic interceptor independently from log suppression.
 * Consumers may disable filtering while still retaining the candidate failure
 * classes needed to produce the correct retry reason.
 */
export function installLibsignalDiagnostics(options: LibsignalDiagnosticOptions = {}): void {
	suppressOutput = options.suppressLogs ?? true
	if (installed) return
	installed = true

	const origConsoleError = console.error
	const origConsoleLog = console.log
	const origConsoleInfo = console.info

	console.log = function (...args: unknown[]) {
		if (suppressOutput && args.length > 0 && typeof args[0] === 'string' && SESSION_LIFECYCLE_RE.test(args[0])) {
			return
		}

		origConsoleLog.apply(console, args)
	}

	console.info = function (...args: unknown[]) {
		if (suppressOutput && args.length > 0 && typeof args[0] === 'string' && SESSION_LIFECYCLE_RE.test(args[0])) {
			return
		}

		origConsoleInfo.apply(console, args)
	}

	// Bounded dedup map. Cap matches the previous in-`index.ts` behavior so
	// memory usage is identical (50 entries × ~80 bytes ≈ 4 KB ceiling).
	const errorTimestamps = new Map<string, number>()
	const DEDUP_WINDOW_MS = 150
	const MAX_DEDUP_ENTRIES = 50

	console.error = function (...args: unknown[]) {
		if (args.length > 0 && typeof args[0] === 'string') {
			// Never coerce arbitrary caller objects: null-prototype objects and
			// hostile Symbol.toPrimitive implementations can throw here and
			// must not make a diagnostic filter break application code.
			const msg = args.map(safeErrorMessage).filter(Boolean).join(' ')
			// Stack-frame detection: libsignal frames carry the filename in the
			// V8 stack output. In minified / containerized builds this filename
			// may be rewritten — if that happens, the filter degrades into a
			// pure pass-through (no false positives, no false negatives on
			// non-libsignal callers). That's the safer failure mode.
			const isFromLibsignal = isLibsignalCallerStack(new Error().stack || '')

			if (isFromLibsignal) {
				recordLibsignalFailureDiagnostic(msg)

				if (!suppressOutput) {
					origConsoleError.apply(console, args)
					return
				}

				if (msg.startsWith('Closing session')) {
					return
				}

				if (
					msg.includes('Session error') ||
					msg.includes('Bad MAC') ||
					msg.includes('MessageCounterError') ||
					msg.includes('Key used already') ||
					msg.includes('Failed to decrypt')
				) {
					let errorType = '⚠️ Session Error'
					if (msg.includes('Bad MAC')) errorType = '🔐 Bad MAC Error'
					else if (msg.includes('MessageCounterError') || msg.includes('Key used already'))
						errorType = '🔢 Counter Error'
					else if (msg.includes('Failed to decrypt')) errorType = '🔌 Decryption Failed'

					const jidMatch = msg.match(/(\d{10,}(?:_\d+\.\d+)?)/)
					const jid = jidMatch ? jidMatch[1] : null
					const maskedJid = jid && jid.length > 8 ? `${jid.substring(0, 4)}****${jid.substring(jid.length - 4)}` : jid

					const cleanMsg = maskedJid ? `${errorType} | JID: ${maskedJid}` : errorType

					// Dedup on UNMASKED jid so two different real numbers that share
					// a prefix do not collapse into each other.
					const dedupeKey = `${errorType}:${jid || 'unknown'}`
					const now = Date.now()
					const lastTime = errorTimestamps.get(dedupeKey)

					if (lastTime && now - lastTime < DEDUP_WINDOW_MS) {
						return
					}

					errorTimestamps.set(dedupeKey, now)

					if (errorTimestamps.size > MAX_DEDUP_ENTRIES) {
						const oldestKey = errorTimestamps.keys().next().value
						if (oldestKey) errorTimestamps.delete(oldestKey)
					}

					origConsoleError(cleanMsg)
					return
				}
			}
		}

		origConsoleError.apply(console, args)
	}
}

/** Preserve the existing public API: explicit calls enable suppression. */
export function suppressLibsignalLogs(): void {
	installLibsignalDiagnostics({ suppressLogs: true })
}
