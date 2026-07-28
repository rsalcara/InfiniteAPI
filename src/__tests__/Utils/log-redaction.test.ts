import { describe, expect, it } from '@jest/globals'
import { REDACTED, sanitizeLogValue } from '../../Utils/log-redaction'

describe('central log redaction', () => {
	it('redacts Error messages and the message line embedded in stacks', () => {
		const error = new Error('token=must-not-leak for 5511991426667@s.whatsapp.net')
		const sanitized = sanitizeLogValue(error) as Record<string, unknown>
		const serialized = JSON.stringify(sanitized)

		expect(sanitized.message).toBe(REDACTED)
		expect(serialized).not.toContain('must-not-leak')
		expect(serialized).not.toContain('5511991426667')
		expect(sanitized.stack).toContain(REDACTED)
	})

	it('omits nested Error stacks when stack traces are disabled', () => {
		const sanitized = sanitizeLogValue({ nested: new Error('private content') }, { includeErrorStack: false }) as {
			nested: { stack?: unknown; message: string }
		}

		expect(sanitized.nested.message).toBe(REDACTED)
		expect(sanitized.nested.stack).toBeUndefined()
	})

	it('does not execute a throwing getter while sanitizing diagnostics', () => {
		const hostile = Object.defineProperty({}, 'payloadInfo', {
			enumerable: true,
			get() {
				throw new Error('getter secret')
			}
		})

		expect(() => sanitizeLogValue(hostile)).not.toThrow()
		expect(sanitizeLogValue(hostile)).toEqual({ payloadInfo: '[unavailable]' })
	})
})
