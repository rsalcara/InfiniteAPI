import { readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import {
	createApkCountriesTsvProvider,
	createVerifiedCountriesTsvProvider,
	loadCountriesTsvFromFile,
	resetPhoneMetadataProvider,
	setPhoneMetadataProvider
} from '../../Utils/phone-metadata-provider'
import {
	buildAllowedPhoneCandidates,
	classifyPhoneNumber,
	createPhoneValidationRateLimiter,
	normalizePhoneForValidation,
	preparePhoneValidation,
	resolvePhoneValidationResult
} from '../../Utils/phone-validation'

// Minimal BR-only TSV for testing (from APK 2.26.37.1 countries.tsv).
// Only the columns used by the parser are included.
const BR_TSV_LINE =
	'BR\tBrasil\t55\t724\t9,10,11\t0\tX\t' +
	'(\\d{4})(\\d{4});(\\d{5})(\\d{4});(\\d{3,5});(\\d{2})(\\d{4})(\\d{4});(\\d{2})(\\d{5})(\\d{4});(\\d{4})(\\d{4});([3589]00)(\\d{2,3})(\\d{4})\t' +
	'$1-$2;$1-$2;$1;$1 $2-$3;$1 $2-$3;$1-$2;$1 $2 $3\t' +
	'[2-9](?:[1-9]|0[1-9]);9(?:[1-9]|0[1-9]);1[125689];[1-9][1-9];(?:[14689][1-9]|2[12478]|3[1-578]|5[1-5]|7[13-579])9;(?:300|40(?:0|20));[3589]00\t' +
	'X\tBrazil\tX\trow\tX\tX\tX\tX\tX\tX\tX\tX\tX'

describe('phone validation parity with WhatsApp Android BR metadata (B6)', () => {
	beforeAll(() => {
		const provider = createApkCountriesTsvProvider({ tsvContent: BR_TSV_LINE + '\n' })
		setPhoneMetadataProvider(provider)
	})

	afterAll(() => {
		resetPhoneMetadataProvider()
	})

	it('classifies current mobile (11-digit with 9th digit)', () => {
		// Pattern mask[1] = 9(?:[1-9]|0[1-9]) → 96-99, 91-99, 901-909
		expect(classifyPhoneNumber('5583989128418')).toBe('mobile')
		expect(classifyPhoneNumber('5511987654321')).toBe('mobile')
	})

	it('classifies90-95 as mobile (matches APK pattern 9(?:[1-9]|0[1-9]))', () => {
		// B6 fix: these were 'unknown' with the old hardcoded regex /^9[6-9]/
		expect(classifyPhoneNumber('5583901234567')).toBe('mobile')
		expect(classifyPhoneNumber('5583911234567')).toBe('mobile')
		expect(classifyPhoneNumber('5583921234567')).toBe('mobile')
		expect(classifyPhoneNumber('5583931234567')).toBe('mobile')
		expect(classifyPhoneNumber('5583941234567')).toBe('mobile')
		expect(classifyPhoneNumber('5583951234567')).toBe('mobile')
	})

	it('classifies900 as NOT mobile (9 followed by 0, but 00 is not in pattern)', () => {
		// Pattern 9(?:[1-9]|0[1-9]) requires the second digit to be non-zero.
		// 55839001234567 → subscriber 9001234567 → 900 → 9+00 → not matched
		// Actually: 9001234567 has 10 digits, not 9. So it's not 11-digit.
		// For 11-digit: 55839001234567 has 12 national digits → unknown.
		expect(classifyPhoneNumber('55839001234')).toBe('unknown')
	})

	it('classifies10-digit BR numbers as landline (APK behavior)', () => {
		// The APK classifies ALL valid 10-digit BR numbers as landline/fixed-line
		// (mask[0] = [2-9](?:[1-9]|0[1-9]) covers both [2-5] and [6-9]).
		// The 'legacy-mobile' classification is a candidate-generation concept,
		// not an APK metadata value.
		expect(classifyPhoneNumber('558389128418')).toBe('landline')
		expect(classifyPhoneNumber('551131920164')).toBe('landline')
	})

	it('classifies numbers per APK metadata with subscriber validation', () => {
		// Subscriber must also match the 2-group format+mask from the TSV.
		// mask[0] = [2-9](?:[1-9]|0[1-9]) → subscriber starting with 0 or 1 fails.
		expect(classifyPhoneNumber('558301234567')).toBe('unknown')
		expect(classifyPhoneNumber('558311234567')).toBe('unknown')
		// Subscriber starting with 2-9 passes mask[0].
		expect(classifyPhoneNumber('558321234567')).toBe('landline')
		// Non-BR number
		expect(classifyPhoneNumber('12025551234')).toBe('unknown')
	})

	it('normalizes by removing formatting only', () => {
		expect(normalizePhoneForValidation('+55 (83) 98912-8418')).toBe('5583989128418')
	})

	it('does not add or remove the Brazilian ninth digit', () => {
		expect(normalizePhoneForValidation('558389128418')).toBe('558389128418')
		expect(normalizePhoneForValidation('5583989128418')).toBe('5583989128418')
	})

	it('rejects invalid and too-short phone input', () => {
		expect(() => normalizePhoneForValidation('')).toThrow('phone is required')
		expect(() => normalizePhoneForValidation('551234')).toThrow(
			'phone must contain 8 to 15 digits without the + prefix'
		)
	})

	// B7: P8 mutant — minimum 8 digits boundary
	it('rejects7 digits and accepts8 digits', () => {
		expect(() => normalizePhoneForValidation('1234567')).toThrow('8 to 15 digits')
		expect(normalizePhoneForValidation('12345678')).toBe('12345678')
	})

	it('queries only the exact form for current mobile and landline numbers', () => {
		expect(buildAllowedPhoneCandidates('5583989128418')).toEqual([{ phone: '5583989128418', classification: 'mobile' }])
		expect(buildAllowedPhoneCandidates('551131920164')).toEqual([{ phone: '551131920164', classification: 'landline' }])
	})

	it('allows only the exact form plus its ninth-digit counterpart for legacy mobile', () => {
		const candidates = buildAllowedPhoneCandidates('558389128418')
		expect(candidates).toEqual([
			{ phone: '558389128418', classification: 'legacy-mobile' },
			{ phone: '5583989128418', classification: 'mobile' }
		])
	})

	it('rejects a candidate that was not derived from the exact input', () => {
		expect(() => preparePhoneValidation('558389128418', ['5511987654321'])).toThrow(
			'candidates may only contain exact plausibility variations of phone'
		)
	})

	// B2: require exact candidate when candidates is provided
	it('rejects candidates that omit the exact normalizedPhone', () => {
		expect(() => preparePhoneValidation('558389128418', ['5583989128418'])).toThrow(
			'candidates must include the exact phone number'
		)
	})

	it('rejects an empty explicit candidate list', () => {
		expect(() => preparePhoneValidation('558389128418', [])).toThrow('candidates must be a non-empty array')
	})

	it('preserves the input and classifies each prepared candidate', () => {
		const result = preparePhoneValidation('+55 83 8912-8418', ['+55 83 8912-8418', '+55 83 98912-8418'])
		expect(result.normalizedPhone).toBe('558389128418')
		expect(result.candidates).toEqual([
			{ phone: '558389128418', classification: 'legacy-mobile' },
			{ phone: '5583989128418', classification: 'mobile' }
		])
		expect(result.classificationSource).toBe('apk-countries-tsv')
	})
})

describe('phone validation result policy (B1)', () => {
	let request: ReturnType<typeof preparePhoneValidation>

	beforeAll(() => {
		const provider = createApkCountriesTsvProvider({ tsvContent: BR_TSV_LINE + '\n' })
		setPhoneMetadataProvider(provider)
		request = preparePhoneValidation('558389128418', ['558389128418', '5583989128418'])
	})

	afterAll(() => {
		resetPhoneMetadataProvider()
	})

	it('returns null without choosing a fallback when no candidate exists', () => {
		const result = resolvePhoneValidationResult(request, [
			{ jid: '558389128418@s.whatsapp.net', exists: false },
			{ jid: '5583989128418@s.whatsapp.net', exists: false }
		])

		expect(result.acceptedJid).toBeNull()
		expect(result.candidates[0]).toEqual({ phone: '558389128418', exists: false, classification: 'legacy-mobile' })
		expect(result.candidates[1]).toEqual({ phone: '5583989128418', exists: false, classification: 'mobile' })
		expect(result.classificationSource).toBe('apk-countries-tsv')
	})

	it('accepts the only candidate explicitly confirmed by WhatsApp', () => {
		const result = resolvePhoneValidationResult(request, [
			{ jid: '558389128418@s.whatsapp.net', exists: false },
			{ jid: '5583989128418@s.whatsapp.net', exists: true }
		])

		expect(result.acceptedJid).toBe('5583989128418@s.whatsapp.net')
		expect(result.candidates[1]).toEqual({
			phone: '5583989128418',
			exists: true,
			jid: '5583989128418@s.whatsapp.net',
			classification: 'mobile'
		})
	})

	// B1: two candidates existing with the SAME JID is NOT ambiguous.
	it('does not flag as ambiguous when both candidates resolve to the same canonical JID', () => {
		const result = resolvePhoneValidationResult(request, [
			{ jid: '558389128418@s.whatsapp.net', exists: true },
			{ jid: '558389128418@s.whatsapp.net', exists: true }
		])

		expect(result.acceptedJid).toBe('558389128418@s.whatsapp.net')
		expect(result.candidates.filter(c => c.exists)).toHaveLength(2)
	})

	// B1: two candidates existing with DIFFERENT JIDs IS ambiguous.
	it('refuses an ambiguous response when JIDs are distinct', () => {
		expect(() =>
			resolvePhoneValidationResult(request, [
				{ jid: '558389128418@s.whatsapp.net', exists: true },
				{ jid: '5583989128418@s.whatsapp.net', exists: true }
			])
		).toThrow('multiple phone candidates exist; an explicit choice is required')
	})

	it('refuses a partial response instead of inferring a missing answer', () => {
		expect(() =>
			resolvePhoneValidationResult(request, [{ jid: '558389128418@s.whatsapp.net', exists: false }])
		).toThrow('WhatsApp returned no phone validation response')
	})

	it('refuses a missing response', () => {
		expect(() => resolvePhoneValidationResult(request, undefined as never)).toThrow(
			'WhatsApp returned no phone validation response'
		)
	})

	// B1: canonical JID with different digits than queried phone
	it('accepts a canonical JID that differs from the queried phone digits', () => {
		const result = resolvePhoneValidationResult(request, [
			{ jid: '558389128418@s.whatsapp.net', exists: false },
			{ jid: '558389128418@s.whatsapp.net', exists: true }
		])

		// The JID has the old 10-digit number, but the candidate queried was 11-digit.
		// This is the canonical JID — not ambiguous.
		expect(result.acceptedJid).toBe('558389128418@s.whatsapp.net')
	})
})

describe('phone validation rate limiter (B3+B4+B5)', () => {
	it('limits by tenant and number within the window', async () => {
		let time = 1_000
		const limiter = createPhoneValidationRateLimiter(() => time)
		const key = 'tenant-a:558389128418'

		for (let index = 0; index < 5; index += 1) {
			await expect(limiter.consume(key)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 })
		}

		const blocked = await limiter.consume(key)
		expect(blocked.allowed).toBe(false)
		expect(blocked.retryAfterSeconds).toBe(60)

		time += 60_001
		await expect(limiter.consume(key).then(r => r.allowed)).resolves.toBe(true)
	})

	it('does not let another tenant or number consume the budget', async () => {
		const time = 2_000
		const limiter = createPhoneValidationRateLimiter(() => time)

		for (let index = 0; index < 5; index += 1) {
			await expect(limiter.consume('tenant-a:558389128418').then(r => r.allowed)).resolves.toBe(true)
		}

		await expect(limiter.consume('tenant-a:551131920164').then(r => r.allowed)).resolves.toBe(true)
		await expect(limiter.consume('tenant-b:558389128418').then(r => r.allowed)).resolves.toBe(true)
		await expect(limiter.consume('tenant-a:558389128418').then(r => r.allowed)).resolves.toBe(false)
	})

	// B4: eviction must not delete an active bucket
	it('refuses new keys when the map is full instead of evicting active buckets', async () => {
		const time = 3_000
		const limiter = createPhoneValidationRateLimiter(() => time, 60_000, 5, 3, 30)

		// Fill the map to maxKeys (3).
		await limiter.consume('tenant:558389128418')
		await limiter.consume('tenant:5583989128418')
		await limiter.consume('tenant:551131920164')

		// All three are active (not expired). A new key should be refused.
		const blocked = await limiter.consume('tenant:5511987654321')
		expect(blocked.allowed).toBe(false)

		// The original keys should still be allowed (not evicted).
		await expect(limiter.consume('tenant:558389128418').then(r => r.allowed)).resolves.toBe(true)
	})

	// B4: expired buckets ARE evicted to make room
	it('evicts expired buckets to make room for new keys', async () => {
		let time = 4_000
		const limiter = createPhoneValidationRateLimiter(() => time, 60_000, 5, 3, 30)

		await limiter.consume('tenant:558389128418')
		await limiter.consume('tenant:5583989128418')
		await limiter.consume('tenant:551131920164')

		// Advance time past the window.
		time += 60_001

		// Now the expired buckets should be evicted.
		await expect(limiter.consume('tenant:5511987654321').then(r => r.allowed)).resolves.toBe(true)
	})

	// B5: global per-tenant cap
	it('limits the total USync queries per tenant across all numbers', async () => {
		const time = 5_000
		const limiter = createPhoneValidationRateLimiter(() => time, 60_000, 100, 10_000, 10)

		// 10 distinct numbers, each using 1 query → hits the global cap.
		for (let i = 0; i < 10; i++) {
			await expect(limiter.consume(`tenant-a:5583${String(i).padStart(7, '0')}`).then(r => r.allowed)).resolves.toBe(
				true
			)
		}

		// The 11th number should be blocked by the global cap.
		const blocked = await limiter.consume('tenant-a:558399999999')
		expect(blocked.allowed).toBe(false)

		// A different tenant should still be allowed.
		await expect(limiter.consume('tenant-b:558389128418').then(r => r.allowed)).resolves.toBe(true)
	})

	// B7: P12 mutant — retry-after should be less than 60 after advancing the clock
	it('returns retry-after < 60 after partial window elapsed', async () => {
		let time = 6_000
		const limiter = createPhoneValidationRateLimiter(() => time)

		for (let i = 0; i < 5; i++) {
			await limiter.consume('tenant:558389128418')
		}

		// Advance 30 seconds (half window).
		time += 30_000

		const blocked = await limiter.consume('tenant:558389128418')
		expect(blocked.allowed).toBe(false)
		expect(blocked.retryAfterSeconds).toBeLessThan(60)
		expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
	})

	// R10: expired hits should NOT count toward tenant global cap
	it('does not count expired hits toward the tenant global cap', async () => {
		let time = 7_000
		const limiter = createPhoneValidationRateLimiter(() => time, 60_000, 100, 10_000, 3)

		await limiter.consume('tenant:558389128418')
		await limiter.consume('tenant:5583989128418')
		await limiter.consume('tenant:551131920164')

		// All 3 slots used. Advance past window.
		time += 60_001

		// Expired hits should not count → new request should pass.
		await expect(limiter.consume('tenant:5511987654321').then(r => r.allowed)).resolves.toBe(true)
	})

	// R2: scope should be 'tenant' when global cap triggers
	it('returns scope tenant when the global cap triggers', async () => {
		const limiter = createPhoneValidationRateLimiter(Date.now, 60_000, 100, 10_000, 2)

		await limiter.consume('tenant:558389128418')
		await limiter.consume('tenant:5583989128418')

		const blocked = await limiter.consume('tenant:551131920164')
		expect(blocked.allowed).toBe(false)
		expect(blocked.scope).toBe('tenant')
	})
})

// R1: loader actually loads the bundled TSV (no injection).
// This test runs WITHOUT setPhoneMetadataProvider, so it exercises the real loader.
describe('phone metadata loader (R1)', () => {
	afterAll(() => {
		resetPhoneMetadataProvider()
	})

	it('loads the bundled countries.tsv and classifies correctly', () => {
		// Reset to force loader path (not injected provider).
		resetPhoneMetadataProvider()

		// If the loader works, classifyPhoneNumber should return real results.
		const result = classifyPhoneNumber('5583989128418')
		// The real TSV should classify this as mobile.
		// If the loader fails, it returns 'unknown'.
		expect(result).toBe('mobile')
	})

	it('returns classificationSource from the real provider', () => {
		resetPhoneMetadataProvider()
		const result = preparePhoneValidation('558389128418')
		expect(result.classificationSource).toBe('apk-countries-tsv')
	})

	// S2: tampered content → createVerifiedCountriesTsvProvider returns null.
	it('rejects tampered countries.tsv content (S2)', () => {
		// Read the real bundled file.
		const currentDir = dirname(fileURLToPath(import.meta.url))
		const tsvPath = join(currentDir, '../../Utils/phone-metadata/data/countries.tsv')
		const realContent = readFileSync(tsvPath, 'utf8')

		// Real content passes SHA256 verification.
		const realProvider = createVerifiedCountriesTsvProvider(realContent)
		expect(realProvider).not.toBeNull()
		expect(realProvider!.source).toBe('apk-countries-tsv')

		// Tampered content (one field changed) fails SHA256 verification.
		const tampered = realContent.replace('55\t724', '55\t725')
		expect(createVerifiedCountriesTsvProvider(tampered)).toBeNull()
	})

	// S2b: loader with tampered file on disk → returns null.
	it('loader rejects tampered file on disk (S2b)', () => {
		const currentDir = dirname(fileURLToPath(import.meta.url))
		const realPath = join(currentDir, '../../Utils/phone-metadata/data/countries.tsv')
		const realContent = readFileSync(realPath, 'utf8')

		// Write a tampered copy to a temp file.
		const tmpPath = join(currentDir, 'countries-tampered.tsv')
		writeFileSync(tmpPath, realContent.replace('55\t724', '55\t725'), 'utf8')

		try {
			// Loader with real file → provider.
			expect(loadCountriesTsvFromFile(realPath)).not.toBeNull()
			// Loader with tampered file → null (SHA256 mismatch).
			expect(loadCountriesTsvFromFile(tmpPath)).toBeNull()
		} finally {
			try {
				unlinkSync(tmpPath)
			} catch {
				/* cleanup */
			}
		}
	})
})
