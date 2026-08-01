import { describe, expect, it } from '@jest/globals'
import {
	LOG_ENTRIES_TRUNCATED,
	MAX_DEPTH_REACHED,
	MAX_LOG_DEPTH,
	MAX_LOG_ENTRIES,
	REDACTED,
	sanitizeLogString,
	sanitizeLogValue
} from '../../Utils/log-redaction'

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

	it('removes multiline Error message continuations while retaining stack frames', () => {
		const error = new Error('first secret\nsecond secret')
		const sanitized = sanitizeLogValue(error) as Record<string, unknown>
		const stack = String(sanitized.stack)

		expect(stack).toContain(REDACTED)
		expect(stack).toContain('at ')
		expect(stack).not.toContain('first secret')
		expect(stack).not.toContain('second secret')
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

	it('tolerates hostile Error fields with non-string runtime values', () => {
		const hostile = new Error('private content')
		Object.defineProperties(hostile, {
			name: { configurable: true, get: () => ({ secret: true }) },
			stack: { configurable: true, get: () => ({ secret: true }) }
		})

		expect(() => sanitizeLogValue(hostile)).not.toThrow()
		expect(sanitizeLogValue(hostile)).toMatchObject({
			name: 'Error',
			message: REDACTED,
			stack: undefined
		})
	})

	it('redacts WhatsApp message bodies and display metadata', () => {
		const sanitized = sanitizeLogValue({
			message: { conversation: 'SEGREDO DO CLIENTE 1234' },
			pushName: 'Nome privado',
			vcard: 'BEGIN:VCARD',
			matchedText: 'texto citado',
			selectedDisplayText: 'opção privada',
			title: 'título privado',
			description: 'descrição privada',
			fileName: 'documento-secreto.pdf',
			displayName: 'Contato privado'
		}) as Record<string, unknown>
		const serialized = JSON.stringify(sanitized)

		expect(serialized).not.toContain('SEGREDO DO CLIENTE')
		expect(serialized).not.toContain('Nome privado')
		expect(serialized).not.toContain('documento-secreto.pdf')
		expect(serialized).toContain(REDACTED)
	})

	it('redacts cryptographic key fields while preserving the approved messageKey fields', () => {
		const sanitized = sanitizeLogValue({
			mediaKey: 'media-secret',
			macKey: 'mac-secret',
			authKey: 'auth-secret',
			messageKey: {
				remoteJid: '5515991426667@s.whatsapp.net',
				remoteJidAlt: '5515991426667@s.whatsapp.net',
				fromMe: true,
				id: '3EB0B9832A0DD4DE4E54D3',
				participant: '',
				addressingMode: 'lid',
				authKey: 'nested-secret'
			}
		}) as Record<string, unknown>
		const serialized = JSON.stringify(sanitized)

		expect(serialized).not.toContain('media-secret')
		expect(serialized).not.toContain('mac-secret')
		expect(serialized).not.toContain('auth-secret')
		expect(serialized).not.toContain('nested-secret')
		expect(serialized).toContain('5515991426667@s.whatsapp.net')
		expect(serialized).toContain('3EB0B9832A0DD4DE4E54D3')
	})

	it('bounds very large strings before applying JID and phone redaction', () => {
		const input = `5515991426667@s.whatsapp.net ${'9'.repeat(100_000)}`
		const sanitized = sanitizeLogString(input)

		expect(sanitized).toContain('[truncated ')
		expect(sanitized.length).toBeLessThan(8_300)
		expect(sanitized).not.toContain('5515991426667@s.whatsapp.net')
		expect(sanitized).toContain('6667@s.whatsapp.net')
	})

	it('stops recursive sanitization at the configured maximum depth', () => {
		const root: Record<string, unknown> = {}
		let cursor = root
		for (let depth = 0; depth < MAX_LOG_DEPTH + 10; depth++) {
			const child: Record<string, unknown> = {}
			cursor.quotedMessage = child
			cursor = child
		}

		expect(() => sanitizeLogValue(root)).not.toThrow()
		expect(JSON.stringify(sanitizeLogValue(root))).toContain(MAX_DEPTH_REACHED)
	})

	it('sanitizes cyclic compound values inside approved messageKey fields', () => {
		const cyclic: Record<string, unknown> = { token: 'must-not-leak' }
		cyclic.self = cyclic
		const sanitized = sanitizeLogValue({ messageKey: { remoteJid: cyclic } })
		const serialized = JSON.stringify(sanitized)

		expect(serialized).toContain('[Circular]')
		expect(serialized).toContain(REDACTED)
		expect(serialized).not.toContain('must-not-leak')
	})

	it('never serializes function source or symbol descriptions', () => {
		function secretFunction() {
			return 'must-not-leak'
		}

		const serialized = JSON.stringify(sanitizeLogValue({ fn: secretFunction, symbol: Symbol('must-not-leak') }))

		expect(serialized).toContain('[Function]')
		expect(serialized).toContain('[Symbol]')
		expect(serialized).not.toContain('must-not-leak')
	})

	it('bounds very large arrays and objects with a truncation marker', () => {
		const hugeArray = Array.from({ length: MAX_LOG_ENTRIES + 100 }, (_, index) => index)
		const sanitizedArray = sanitizeLogValue(hugeArray) as unknown[]
		expect(sanitizedArray).toHaveLength(MAX_LOG_ENTRIES + 1)
		expect(sanitizedArray.at(-1)).toBe(LOG_ENTRIES_TRUNCATED)

		const hugeObject = Object.fromEntries(
			Array.from({ length: MAX_LOG_ENTRIES + 100 }, (_, index) => [`field${index}`, index])
		)
		const serializedObject = JSON.stringify(sanitizeLogValue(hugeObject))
		expect(serializedObject).toContain(LOG_ENTRIES_TRUNCATED)
		expect(Object.keys(sanitizeLogValue(hugeObject) as Record<string, unknown>).length).toBe(MAX_LOG_ENTRIES + 1)
	})
})
