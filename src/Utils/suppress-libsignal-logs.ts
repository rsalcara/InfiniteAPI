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
 * Moving it into an explicit function makes the override opt-in for
 * library consumers; `src/index.ts` calls it automatically when
 * `INFINITEAPI_DISABLE_LIBSIGNAL_LOG_FILTER` is NOT set, preserving the
 * default behavior the gateway already depends on.
 */

const SESSION_LIFECYCLE_RE = /^(Closing session|Removing old closed session)/

let installed = false

/**
 * Install the libsignal log filter. Safe to call multiple times (subsequent
 * calls are no-ops). Once installed it is intentionally not removable —
 * the original console methods are captured by closure but never restored,
 * because the filter is a process-wide commitment for the lifetime of the
 * gateway.
 */
export function suppressLibsignalLogs(): void {
	if (installed) return
	installed = true

	const origConsoleError = console.error
	const origConsoleLog = console.log
	const origConsoleInfo = console.info

	console.log = function (...args: unknown[]) {
		if (args.length > 0 && typeof args[0] === 'string' && SESSION_LIFECYCLE_RE.test(args[0])) {
			return
		}

		origConsoleLog.apply(console, args)
	}

	console.info = function (...args: unknown[]) {
		if (args.length > 0 && typeof args[0] === 'string' && SESSION_LIFECYCLE_RE.test(args[0])) {
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
			const msg = args[0]
			// Stack-frame detection: libsignal frames carry the filename in the
			// V8 stack output. In minified / containerized builds this filename
			// may be rewritten — if that happens, the filter degrades into a
			// pure pass-through (no false positives, no false negatives on
			// non-libsignal callers). That's the safer failure mode.
			const stack = new Error().stack || ''
			const isFromLibsignal = stack.includes('libsignal') || stack.includes('session_cipher')

			if (isFromLibsignal) {
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

					const jidMatch = (msg + String(args[1] ?? '')).match(/(\d{10,}(?:_\d+\.\d+)?)/)
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
