/**
 * compactError() is called from inside catch blocks where any throw bubbles
 * past the NACK and leaves the WhatsApp server retrying the same stanza in a
 * tight loop. The function MUST NEVER THROW — these tests pin that contract.
 */
import { compactError } from '../../Utils/error-log-utils'

describe('compactError', () => {
	it('formats an Error instance as "Name: message"', () => {
		expect(compactError(new Error('boom'))).toBe('Error: boom')
	})

	it('preserves custom Error subclass names', () => {
		class MessageCounterError extends Error {
			constructor() {
				super('Key used already or never filled')
				this.name = 'MessageCounterError'
			}
		}
		expect(compactError(new MessageCounterError())).toBe(
			'MessageCounterError: Key used already or never filled'
		)
	})

	it('uses the .type field on plain objects when .name is absent (libsignal-style errors)', () => {
		const err = { type: 'PreKeyError', message: 'Invalid PreKey ID' }
		expect(compactError(err)).toBe('PreKeyError: Invalid PreKey ID')
	})

	it('prefers .name over .type when both are present', () => {
		const err = { name: 'FromName', type: 'FromType', message: 'msg' }
		expect(compactError(err)).toBe('FromName: msg')
	})

	it('returns "Unknown" for null/undefined', () => {
		expect(compactError(null)).toBe('Unknown')
		expect(compactError(undefined)).toBe('Unknown')
	})

	it('coerces primitive values to strings', () => {
		expect(compactError('plain string')).toBe('plain string')
		expect(compactError(42)).toBe('42')
		expect(compactError(true)).toBe('true')
	})

	it('falls back to JSON.stringify on a plain object without .message', () => {
		const err = { name: 'CustomBag', code: 'X1', details: 'no message field' }
		expect(compactError(err)).toBe('CustomBag: {"name":"CustomBag","code":"X1","details":"no message field"}')
	})

	it('does NOT throw on a circular object — returns "[unserializable]" sentinel instead', () => {
		const a: any = { name: 'CircErr' }
		a.self = a
		// Calling JSON.stringify(a) would throw TypeError. The whole point of the
		// guard: this catch-block helper must produce SOME string and not propagate.
		expect(() => compactError(a)).not.toThrow()
		expect(compactError(a)).toBe('CircErr: [unserializable]')
	})

	it('does NOT throw on a BigInt-bearing object — JSON.stringify would otherwise refuse it', () => {
		const err = { name: 'BigIntErr', big: BigInt(9007199254740993) }
		expect(() => compactError(err)).not.toThrow()
		expect(compactError(err)).toBe('BigIntErr: [unserializable]')
	})
})
