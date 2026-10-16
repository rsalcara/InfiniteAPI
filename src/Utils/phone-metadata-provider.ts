import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { PhoneNumberClassification } from '../Types'

/**
 * Abstraction for phone number classification. The primary implementation
 * parses the WhatsApp Android countries.tsv; a fallback can use
 * libphonenumber-js. The interface is intentionally minimal: classify one
 * E.164-like digit string.
 */
export type PhoneMetadataProvider = {
	/** Human-readable source label, e.g. 'apk-countries-tsv@2.26.37.1'. */
	readonly source: string
	classify(e164Digits: string): PhoneNumberClassification
}

// ---------------------------------------------------------------------------
// C13U parser — ported from X/C13U.java (WhatsApp 2.26.37.1)
// Column mapping documented below matches the TSV layout exactly.
// ---------------------------------------------------------------------------

type CountryEntry = {
	countryCode: string
	callingCode: number
	nsnLengths: number[]
	/** Semicolon-separated format regex patterns (col 7). */
	formatPatterns: string[]
	/** Semicolon-separated leading-digit masks (col 9). */
	leadingDigitMasks: string[]
}

const parseCountriesTsv = (tsvContent: string): CountryEntry[] => {
	const entries: CountryEntry[] = []

	for (const line of tsvContent.split('\n')) {
		if (!line.trim()) continue
		const cols = line.split('\t')
		if (cols.length < 12) continue

		// Column mapping from C13U.java constructor:
		//   strArr[0] = A02 → country code (e.g. "BR")
		//   strArr[1] = A03 → country name
		//   strArr[2] = A00 → calling code (e.g. "55")
		//   strArr[3]      → IDD
		//   strArr[4] = A06 → NSN lengths, comma-separated (e.g. "9,10,11")
		//   strArr[5]      → dialing prefix
		//   strArr[6] = A0A → unused for classification
		//   strArr[7] = A09 → format regex patterns, semicolon-separated
		//   strArr[8] = A07 → format replacement patterns
		//   strArr[9] = A08 → leading-digit masks, semicolon-separated
		const countryCode = cols[0]
		const callingCodeStr = cols[2]
		const nsnLengthsStr = cols[4]
		const formatPatternsStr = cols[7]
		const leadingDigitMasksStr = cols[9]

		if (!countryCode || !callingCodeStr) continue

		const callingCode = Number.parseInt(callingCodeStr, 10)
		if (!Number.isFinite(callingCode)) continue

		const nsnLengths = nsnLengthsStr
			? nsnLengthsStr
					.split(',')
					.map(s => Number.parseInt(s.trim(), 10))
					.filter(n => Number.isFinite(n))
			: []

		const formatPatterns = formatPatternsStr ? formatPatternsStr.split(';') : []
		const leadingDigitMasks = leadingDigitMasksStr ? leadingDigitMasksStr.split(';') : []

		entries.push({ countryCode, callingCode, nsnLengths, formatPatterns, leadingDigitMasks })
	}

	return entries
}

// ---------------------------------------------------------------------------
// Classification logic — ported from C11V.java:886-916
//
// C11V builds a combined nationalNumberPattern_ by joining all format
// patterns with "|" (line 931). It then checks each type descriptor
// (mobile_, fixedLine_, etc.) using A08() which matches the national number
// against both possibleNumberPattern_ and nationalNumberPattern_ (line 1105-1107).
//
// The leadingDigitMasks (A08 in C13U, column 9 of TSV) are used as
// leadingDigitsPattern_ in C11V:1410-1420. For BR:
//   mask[0] = [2-9](?:[1-9]|0[1-9])  → 8-digit subscriber
//   mask[1] = 9(?:[1-9]|0[1-9])       → 9-digit subscriber (mobile)
//   mask[4] = (?:[14689][1-9]|...)9    → area+9th digit
//
// The type descriptors in C11V are ordered: personal, tollFree, sharedCost,
// voip, premiumRate, pager, uan, voicemail, fixedLine, mobile.
// Lines 911-916: if fixedLine matches AND mobile matches → "fixed_or_mobile";
// if only fixedLine → "fixed-line"; if only mobile → "mobile".
//
// For our classification we use the leadingDigitMasks to determine if a
// number is mobile or fixed-line, matching the APK's behavior exactly.
// ---------------------------------------------------------------------------

/**
 * Classifies a number using the APK's countries.tsv metadata.
 *
 * Classification algorithm (from C11V.java:886-916):
 *
 * C11V builds type descriptors (mobile_, fixedLine_, etc.) each with their own
 * nationalNumberPattern_ and possibleNumberPattern_. For BR, these are:
 *   - mobile_.nationalNumberPattern_ = union of all format patterns
 *   - fixedLine_.nationalNumberPattern_ = same union
 *
 * The KEY distinction is the leadingDigitsPattern_ (mask), which is PAIRED with
 * each format pattern by index. C11V:1410-1420 assigns mask[i] to format[i].
 * When C11V checks a type, it tests the number against the type's patterns.
 *
 * For BR:
 *   format[0] = (\d{4})(\d{4})        → 8-digit subscriber → mask[0] = [2-9](?:[1-9]|0[1-9])
 *   format[1] = (\d{5})(\d{4})        → 9-digit subscriber → mask[1] = 9(?:[1-9]|0[1-9])
 *   format[2] = (\d{3,5})             → service codes      → mask[2] = 1[125689]
 *   format[3] = (\d{2})(\d{4})(\d{4}) → area+8-digit       → mask[3] = [1-9][1-9]
 *   format[4] = (\d{2})(\d{5})(\d{4}) → area+9-digit       → mask[4] = (?:...)9
 *   format[5] = (\d{4})(\d{4})        → 8-digit again      → mask[5] = (?:300|40(?:0|20))
 *   format[6] = ([3589]00)(\d{2,3})(\d{4}) → service       → mask[6] = [3589]00
 *
 * Mobile numbers match format[4] + mask[4] (area+9th digit).
 * Fixed-line numbers match format[3] + mask[3] (area+8-digit).
 * A 10-digit number starting with9 (e.g. 8399128418) matches format[3] but
 * NOT mask[3] (subscriber99128418 doesn't start with [2-5]), so it's neither
 * mobile nor fixed-line → 'unknown'. This matches the APK's behavior.
 */

/**
 * Extracts digit-group sizes from a format regex pattern like (\d{2})(\d{5})(\d{4}).
 * Returns [2, 5, 4] for that example.
 */
const extractGroupSizes = (formatPattern: string): number[] => {
	const groups = formatPattern.match(/\\d\{(\d+)\}/g) ?? []
	return groups.map(g => {
		const match = g.match(/\\d\{(\d+)\}/)
		return match ? Number.parseInt(match[1]!, 10) : 0
	})
}

/**
 * Counts the subscriber digit length from a format regex pattern.
 * For patterns with 3+ groups, the first group is the area code.
 * For patterns with 2 groups, all digits are subscriber digits.
 * Returns the subscriber digit count.
 */
const countFormatSubscriberDigits = (formatPattern: string): number => {
	const sizes = extractGroupSizes(formatPattern)
	if (sizes.length <= 2) {
		return sizes.reduce((sum, n) => sum + n, 0)
	}

	return sizes.slice(1).reduce((sum, n) => sum + n, 0)
}

const classifyWithEntry = (nationalNumber: string, entry: CountryEntry): PhoneNumberClassification => {
	if (!entry.nsnLengths.includes(nationalNumber.length)) return 'unknown'

	const { formatPatterns, leadingDigitMasks } = entry

	let isMobile = false
	let isFixedLine = false

	// Pair each format pattern with its leading-digit mask by index.
	// This mirrors C11V:1410-1420 where mask[i] is assigned to format[i].
	for (let i = 0; i < formatPatterns.length; i++) {
		const formatPattern = formatPatterns[i]
		if (!formatPattern) continue

		// Check if the national number matches this format pattern.
		let formatMatches = false
		try {
			formatMatches = new RegExp(`^${formatPattern}$`).test(nationalNumber)
		} catch {
			continue // invalid regex in TSV
		}

		if (!formatMatches) continue

		// The format matches. Check the corresponding leading-digit mask.
		// The mask uses ^ to anchor at the start of the national number,
		// so it naturally validates only the leading digits regardless of
		// total length. For example, mask[4] = (?:...)9 matches "839"
		// (area 83 + 9th digit 9) at the start of an 11-digit number.
		const mask = leadingDigitMasks[i]
		if (!mask) continue

		let maskMatches = false
		try {
			maskMatches = new RegExp(`^${mask}`).test(nationalNumber)
		} catch {
			continue
		}

		if (!maskMatches) continue

		// Both format and mask match. Classify by the subscriber digit count.
		// Mobile formats capture a 9-digit subscriber (the mandatory 9th digit
		// is included in a group of 5: \d{5}). Fixed-line formats capture an
		// 8-digit subscriber (groups of 4: \d{4}).
		const subscriberDigitCount = countFormatSubscriberDigits(formatPattern)

		// For formats with area code (3+ groups), also validate the subscriber
		// against the 2-group format+mask from the same TSV entry. This catches
		// invalid subscribers like 900123456 (starts with 90, but mask[1]=9(?:[1-9]|0[1-9])
		// requires the second digit to be non-zero). The 2-group patterns are at
		// indices 0 (8-digit) and 1 (9-digit) in the TSV.
		if (entry.formatPatterns.length >= 2) {
			const areaCodeSize = extractGroupSizes(formatPattern)[0] ?? 0
			const subscriber = nationalNumber.slice(areaCodeSize)
			const twoGroupIndex = subscriberDigitCount === 9 ? 1 : 0
			const twoGroupFormat = entry.formatPatterns[twoGroupIndex]
			const twoGroupMask = entry.leadingDigitMasks[twoGroupIndex]

			if (twoGroupFormat && twoGroupMask) {
				let subscriberFormatOk = false
				let subscriberMaskOk = false
				try {
					subscriberFormatOk = new RegExp(`^${twoGroupFormat}$`).test(subscriber)
					subscriberMaskOk = new RegExp(`^${twoGroupMask}`).test(subscriber)
				} catch {
					// invalid regex — skip subscriber validation
				}

				if (!subscriberFormatOk || !subscriberMaskOk) continue
			}
		}

		if (subscriberDigitCount === 9) {
			isMobile = true
		} else if (subscriberDigitCount === 8) {
			isFixedLine = true
		}
	}

	if (isMobile) return 'mobile'
	if (isFixedLine) return 'landline'
	return 'unknown'
}

// ---------------------------------------------------------------------------
// ApkCountriesTsvProvider
// ---------------------------------------------------------------------------

export type ApkCountriesTsvProviderConfig = {
	/** TSV content string. The consumer is responsible for sourcing the file. */
	tsvContent: string
}

export const createApkCountriesTsvProvider = (config: ApkCountriesTsvProviderConfig): PhoneMetadataProvider => {
	const entries = parseCountriesTsv(config.tsvContent)
	const entryByCallingCode = new Map<string, CountryEntry>()
	for (const entry of entries) {
		entryByCallingCode.set(String(entry.callingCode), entry)
	}

	return {
		source: 'apk-countries-tsv',
		classify(e164Digits: string): PhoneNumberClassification {
			// Find the country entry by matching the calling code prefix.
			// Try longest prefix first (some countries share prefixes).
			for (let len = 3; len >= 1; len--) {
				const prefix = e164Digits.slice(0, len)
				const entry = entryByCallingCode.get(prefix)
				if (entry) {
					const nationalNumber = e164Digits.slice(len)
					return classifyWithEntry(nationalNumber, entry)
				}
			}

			return 'unknown'
		}
	}
}

// ---------------------------------------------------------------------------
// SHA256 integrity verification
// ---------------------------------------------------------------------------

const EXPECTED_SHA256 = '86e115c91b11cd115b876a221bd07cd9b1af1fdabe3d4f484925a03734333690'

const verifySha256 = (content: string, expected: string): boolean => {
	const actual = createHash('sha256').update(content, 'utf8').digest('hex')
	return actual === expected
}

// ---------------------------------------------------------------------------
// File loader — reads the bundled countries.tsv lazily, once per process.
// The file is at src/Utils/phone-metadata/data/countries.tsv (source) or
// lib/Utils/phone-metadata/data/countries.tsv (built). The copy-assets.mjs
// script already copies non-.ts files to lib/.
// ---------------------------------------------------------------------------

let loadedProvider: PhoneMetadataProvider | null | undefined

/**
 * Creates a provider from TSV content after verifying its SHA256.
 * Returns null if the SHA256 doesn't match. This is the single point
 * where integrity verification happens.
 */
export const createVerifiedCountriesTsvProvider = (
	tsvContent: string,
	expectedSha256: string = EXPECTED_SHA256
): PhoneMetadataProvider | null => {
	if (!verifySha256(tsvContent, expectedSha256)) return null
	return createApkCountriesTsvProvider({ tsvContent })
}

/**
 * Loads the countries.tsv from a file path, verifies SHA256, and returns
 * a provider. Returns null if the file is missing or SHA256 doesn't match.
 *
 * @param tsvPath Optional explicit path. When omitted, resolves the bundled
 *   file relative to this module (src/Utils/phone-metadata/data/countries.tsv).
 */
export const loadCountriesTsvFromFile = (tsvPath?: string): PhoneMetadataProvider | null => {
	try {
		let resolvedPath: string
		if (tsvPath) {
			resolvedPath = tsvPath
		} else {
			let dataDir: string
			try {
				const currentFile = fileURLToPath(import.meta.url)
				dataDir = join(dirname(currentFile), 'phone-metadata', 'data')
			} catch {
				dataDir = join(__dirname, 'phone-metadata', 'data')
			}

			resolvedPath = join(dataDir, 'countries.tsv')
		}

		const tsvContent = readFileSync(resolvedPath, 'utf8')
		const provider = createVerifiedCountriesTsvProvider(tsvContent)
		if (!provider) {
			console.error('[phone-metadata] countries.tsv SHA256 mismatch — expected', EXPECTED_SHA256)
		}

		return provider
	} catch (error) {
		console.error('[phone-metadata] failed to load countries.tsv:', (error as Error).message)
		return null
	}
}

/**
 * Loads the bundled countries.tsv. Cached for the lifetime of the process.
 */
export const loadBundledCountriesTsvProvider = (): PhoneMetadataProvider | null => {
	if (loadedProvider !== undefined) return loadedProvider
	loadedProvider = loadCountriesTsvFromFile()
	return loadedProvider
}

// ---------------------------------------------------------------------------
// In-process singleton cache for the TSV provider.
// Loaded once, memorized. If the file is missing or parse fails, returns
// null and classifyPhoneNumber falls back to 'unknown' for all numbers.
// ---------------------------------------------------------------------------

let cachedProvider: PhoneMetadataProvider | null | undefined

/**
 * Returns the cached provider. On first call, loads the bundled countries.tsv.
 * Call `resetPhoneMetadataProvider()` to clear the cache (for testing).
 */
export const getPhoneMetadataProvider = (): PhoneMetadataProvider | null => {
	if (cachedProvider === undefined) {
		cachedProvider = loadBundledCountriesTsvProvider()
	}

	return cachedProvider
}

export const setPhoneMetadataProvider = (provider: PhoneMetadataProvider | null): void => {
	cachedProvider = provider
}

export const resetPhoneMetadataProvider = (): void => {
	cachedProvider = undefined
	loadedProvider = undefined
}

/**
 * Legacy-mobile detection: a 10-digit BR number is legacy-mobile if:
 * - It has 10 national digits (BR country code + 10 national = 12 total)
 * - The subscriber portion starts with 6-9 (old mobile allocation)
 * - classify(inserting 9 at position 4) === 'mobile'
 *
 * The APK's countries.tsv classifies ALL valid 10-digit BR numbers as
 * landline/fixed-line (mask[0] = [2-9](?:[1-9]|0[1-9])). The APK does NOT
 * have a "legacy-mobile" concept. We derive it from the BR numbering plan:
 * subscriber numbers starting with [6-9] were allocated to mobile operators
 * before the9-digit plan (Anatel resolução 263/2001, phase 3 starting 2012).
 * Numbers starting with [2-5] are actual landlines.
 *
 * The subscriber-prefix check [6-9] and the ninth-digit insertion are the
 * only two fixed rules. Everything else comes from the APK metadata.
 */
export const isLegacyMobile = (normalizedPhone: string, provider: PhoneMetadataProvider | null): boolean => {
	if (!provider) return false
	if (!normalizedPhone.startsWith('55')) return false
	const national = normalizedPhone.slice(2)
	if (national.length !== 10) return false

	// Subscriber starts at position 2 of the national number (after area code).
	// BR mobile operators were allocated subscriber numbers starting with [6-9].
	const subscriberFirstDigit = national.charCodeAt(2)
	if (subscriberFirstDigit < 0x36 || subscriberFirstDigit > 0x39) return false // '6'..'9'

	const withNine = `${normalizedPhone.slice(0, 4)}9${normalizedPhone.slice(4)}`
	return provider.classify(withNine) === 'mobile'
}
