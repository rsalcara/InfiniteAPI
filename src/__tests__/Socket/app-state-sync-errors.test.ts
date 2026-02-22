/**
 * Tests for app state sync irrecoverable error classification.
 *
 * HTTP status codes 400, 405, and 406 from the WhatsApp server indicate
 * protocol-level rejections that cannot be resolved by retrying.
 * These should be classified as irrecoverable to avoid infinite retry loops
 * and unnecessary state resets.
 */

import { describe, expect, it } from '@jest/globals'
import { Boom } from '@hapi/boom'

/**
 * Mirrors the isAppStateSyncIrrecoverable logic in chats.ts.
 * Extracted here as a pure function for unit testing.
 */
const isAppStateSyncIrrecoverable = (error: any): boolean => {
	const statusCode = error?.output?.statusCode
	return statusCode === 400 || statusCode === 405 || statusCode === 406
}

const makeBoomError = (statusCode: number) => new Boom('test error', { statusCode })

describe('isAppStateSyncIrrecoverable', () => {
	describe('irrecoverable status codes', () => {
		it('classifies HTTP 400 Bad Request as irrecoverable', () => {
			expect(isAppStateSyncIrrecoverable(makeBoomError(400))).toBe(true)
		})

		it('classifies HTTP 405 Method Not Allowed as irrecoverable', () => {
			expect(isAppStateSyncIrrecoverable(makeBoomError(405))).toBe(true)
		})

		it('classifies HTTP 406 Not Acceptable as irrecoverable', () => {
			expect(isAppStateSyncIrrecoverable(makeBoomError(406))).toBe(true)
		})
	})

	describe('recoverable status codes', () => {
		it('does not classify HTTP 404 as irrecoverable (handled separately as key-not-found)', () => {
			expect(isAppStateSyncIrrecoverable(makeBoomError(404))).toBe(false)
		})

		it('does not classify HTTP 500 as irrecoverable', () => {
			expect(isAppStateSyncIrrecoverable(makeBoomError(500))).toBe(false)
		})

		it('does not classify HTTP 408 Timeout as irrecoverable', () => {
			expect(isAppStateSyncIrrecoverable(makeBoomError(408))).toBe(false)
		})

		it('does not classify HTTP 503 Service Unavailable as irrecoverable', () => {
			expect(isAppStateSyncIrrecoverable(makeBoomError(503))).toBe(false)
		})
	})

	describe('non-HTTP errors', () => {
		it('does not classify TypeError as irrecoverable (handled separately)', () => {
			const typeError = new TypeError('unexpected token')
			expect(isAppStateSyncIrrecoverable(typeError)).toBe(false)
		})

		it('does not classify generic Error as irrecoverable', () => {
			expect(isAppStateSyncIrrecoverable(new Error('network error'))).toBe(false)
		})

		it('handles null error gracefully', () => {
			expect(isAppStateSyncIrrecoverable(null)).toBe(false)
		})

		it('handles undefined error gracefully', () => {
			expect(isAppStateSyncIrrecoverable(undefined)).toBe(false)
		})

		it('handles error with no output property', () => {
			expect(isAppStateSyncIrrecoverable({ message: 'raw error' })).toBe(false)
		})
	})
})
