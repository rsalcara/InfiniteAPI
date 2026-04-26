// ============================================
// Format session error logs from libsignal BEFORE any imports
// This MUST be at the very top to intercept console before libsignal loads
// ============================================
const _origConsoleError = console.error
const _origConsoleLog = console.log
const _origConsoleInfo = console.info

// Suppress libsignal session lifecycle dumps from console.log / console.info.
// libsignal's session_record.js uses console.info("Removing old closed session:", obj)
// and console.log("Closing session:", obj) which dump full session objects (~500ms I/O each).
const _SESSION_LIFECYCLE_RE = /^(Closing session|Removing old closed session)/
console.log = function (...args: unknown[]) {
	if (args.length > 0 && typeof args[0] === 'string' && _SESSION_LIFECYCLE_RE.test(args[0])) {
		return
	}

	_origConsoleLog.apply(console, args)
}

console.info = function (...args: unknown[]) {
	if (args.length > 0 && typeof args[0] === 'string' && _SESSION_LIFECYCLE_RE.test(args[0])) {
		return
	}

	_origConsoleInfo.apply(console, args)
}

// Track errors by type + JID to avoid duplicates (using Map for better performance)
const _errorTimestamps = new Map<string, number>()
// Dedup window for repeated decrypt-error console lines (Bad MAC / Counter / etc).
// Was 150ms, but retry attempts of the SAME message are typically ~300-1000ms apart,
// so the second attempt fell outside the window and double-printed.
//
// TRADE-OFF: dedup key is `errorType + JID` (no message-id). With 5s, a burst of
// errors for the SAME JID — even of slightly different categories or different
// messages — collapses to one log line every 5s. This is intentional for a noisy
// production stream; if you need per-message visibility, set BAILEYS_LOG_LEVEL=debug
// to bypass this console-side dedup and see the structured pino logs in full.
const DEDUP_WINDOW_MS = 5000

console.error = function (...args: unknown[]) {
	if (args.length > 0 && typeof args[0] === 'string') {
		const msg = args[0]
		const stack = new Error().stack || ''
		const isFromLibsignal = stack.includes('libsignal') || stack.includes('session_cipher')

		if (isFromLibsignal) {
			// Suppress session lifecycle logs
			if (msg.startsWith('Closing session')) {
				return
			}

			// Format session errors cleanly
			if (
				msg.includes('Session error') ||
				msg.includes('Bad MAC') ||
				msg.includes('MessageCounterError') ||
				msg.includes('Key used already') ||
				msg.includes('Failed to decrypt')
			) {
				// Extract error type
				let errorType = '⚠️ Session Error'
				if (msg.includes('Bad MAC')) errorType = '🔐 Bad MAC Error'
				else if (msg.includes('MessageCounterError') || msg.includes('Key used already')) errorType = '🔢 Counter Error'
				else if (msg.includes('Failed to decrypt')) errorType = '🔌 Decryption Failed'

				// Extract JID from stack trace or message
				const jidMatch = (msg + String(args[1] ?? '')).match(/(\d{10,}(?:_\d+\.\d+)?)/)
				const jid = jidMatch ? jidMatch[1] : null
				const maskedJid = jid && jid.length > 8 ? `${jid.substring(0, 4)}****${jid.substring(jid.length - 4)}` : jid

				// Format clean message
				const cleanMsg = maskedJid ? `${errorType} | JID: ${maskedJid}` : errorType

				// Deduplication key: type + ORIGINAL JID (use unmasked to prevent collisions)
				const dedupeKey = `${errorType}:${jid || 'unknown'}`
				const now = Date.now()
				const lastTime = _errorTimestamps.get(dedupeKey)

				if (lastTime && now - lastTime < DEDUP_WINDOW_MS) {
					return // Skip duplicate within DEDUP_WINDOW_MS window
				}

				_errorTimestamps.set(dedupeKey, now)

				// Cleanup old entries (keep only last 50 to prevent memory leak)
				if (_errorTimestamps.size > 50) {
					const oldestKey = _errorTimestamps.keys().next().value
					if (oldestKey) _errorTimestamps.delete(oldestKey)
				}

				_origConsoleError(cleanMsg)
				return
			}
		}
	}

	_origConsoleError.apply(console, args)
}

import makeWASocket, { makeWASocketAutoVersion } from './Socket/index'

export * from '../WAProto/index.js'
export * from './Utils/index'
export * from './Types/index'
export * from './Defaults/index'
export * from './WABinary/index'
export * from './WAM/index'
export * from './WAUSync/index'

export type WASocket = ReturnType<typeof makeWASocket>
export { makeWASocket, makeWASocketAutoVersion }

// Alias de compatibilidade para zpro.io
// isJidUser é um alias para isPersonJid (mantém retrocompatibilidade)
export { isPersonJid as isJidUser } from './Utils/history'

export default makeWASocket
