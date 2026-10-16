# Native phone validation

InfiniteAPI exposes an additive motor API for consumers that need to resolve a
user-entered WhatsApp number without changing it:

```ts
const result = await sock.validatePhone('558389128418', {
	candidates: ['558389128418', '5583989128418']
})
```

`candidates` is optional. When omitted, only the exact input is queried.
When provided, it **must include the exact input** (B2) and may add only its
allowed plausibility variations.

## Contract

```ts
type PhoneNumberClassification =
	| 'mobile'
	| 'landline'
	| 'legacy-mobile'
	| 'unknown'

type PhoneValidationCandidate = {
	phone: string
	exists: boolean
	/** Canonical WhatsApp PN JID; may have different digits than `phone` (B1). */
	jid?: string
	classification: PhoneNumberClassification
}

type PhoneValidationResult = {
	normalizedPhone: string
	acceptedJid: string | null
	candidates: PhoneValidationCandidate[]
	/** Identifies which metadata source classified the candidates (B6). */
	classificationSource: string
}
```

`normalizedPhone` is the caller input with non-digit characters removed. The
motor never adds or removes a Brazilian ninth digit, never changes an already
paired session JID, and never falls back between candidates. `acceptedJid` is
non-null only when WhatsApp confirms exactly one existing candidate.

### Canonical JID (B1)

Each candidate is queried individually via USync (`onWhatsApp`). The returned
`jid` is the **canonical WhatsApp JID** and may have different digits than the
queried phone. For example, an old account without the9th digit may return a
10-digit JID even when queried with an 11-digit number.

Ambiguity is defined by **distinct JIDs**: if two candidates exist but resolve
to the same canonical JID, there is no ambiguity. If they resolve to different
JIDs, the motor returns `409 phone_validation_ambiguous`.

## Classification source (B6)

Classification uses a `PhoneMetadataProvider` that parses the WhatsApp Android
`countries.tsv` (APK 2.26.37.1). The parser ports `C13U.java` (column mapping)
and `C11V.java:886-916` (type descriptor matching).

When no provider is configured, all numbers are classified as `'unknown'`. The
motor still works — only the ninth-digit variation is skipped.

The `classificationSource` field in the result identifies the provider:
`'apk-countries-tsv'` when the TSV is loaded, `'unavailable'` otherwise.

### Parity with WhatsApp Android

The local classifier mirrors the Brazilian row in the country metadata bundled
with WhatsApp Android 2.26.37.1 and WhatsApp Business 2.26.36.72 (`BR`, country
code `55`, national forms of 10 and 11 digits):

| Input national form | Local classification | Source |
| --- | --- | --- |
| `55 + area + 9xxxx xxxx` (11 digits) | `mobile` | APK mask[1] = `9(?:[1-9]\|0[1-9])` |
| `55 + area + [6-9]xxx xxxx` (10 digits) | `legacy-mobile` | BR numbering plan + APK mask[1] |
| `55 + area + [2-5]xxx xxxx` (10 digits) | `landline` | APK mask[0] = `[2-9](?:[1-9]\|0[1-9])` |
| another valid E.164-like form | `unknown` | — |

The APK classifies ALL valid 10-digit BR numbers as landline/fixed-line. The
`legacy-mobile` classification is derived from the BR numbering plan: subscriber
numbers starting with [6-9] were allocated to mobile operators before the
9-digit plan (Anatel resolução 263/2001, phase 3 starting 2012). If inserting
the9th digit gives a valid mobile number, the original is classified as
`legacy-mobile`.

For a `legacy-mobile` input, the motor permits its exact form and the single
ninth-digit counterpart. There is intentionally no reverse operation for an
11-digit input, no silent normalization, and no candidate synthesis for other
countries. WhatsApp USync (`onWhatsApp`/contact protocol) remains the sole
authority for existence.

## Rate limiting (B3+B4+B5)

### Per-number limit
Five requests per tenant + number per minute. Each **candidate** counts as one
USync query, so a legacy-mobile case with two candidates consumes two slots.

### Per-tenant global cap (B5)
30 USync queries per tenant per minute across all numbers. Prevents bulk
scanning. The cap is configurable.

### Scope
The 429 response includes `data.scope`:
- `'number'` — per-number limit exceeded
- `'tenant'` — global tenant cap exceeded

### Tenant key
`organizationId` → `instanceId` → `accountJid` → `connectionId`. The
`accountJid` survives reconnection; `connectionId` does not.

### Injection
The rate limiter is a process-level singleton by default (shared across sockets
and reconnections). For distributed deployments, inject a custom limiter via
`SocketConfig.phoneValidationRateLimiter` with an async `consume(key)` interface
(e.g. backed by Redis).

## Explicit failures

| Condition | HTTP-shaped behavior |
| --- | --- |
| invalid digit string | `400 phone_invalid` |
| candidate outside the allowed variations | `400 phone_candidates_invalid` |
| candidates omits the exact phone (B2) | `400 phone_candidates_invalid` |
| per-number rate limit (5/min) | `429 phone_validation_rate_limited` `scope: 'number'` |
| per-tenant global cap (30/min) (B5) | `429 phone_validation_rate_limited` `scope: 'tenant'` |
| distinct existing JIDs (B1) | `409 phone_validation_ambiguous` |
| USync omitted or malformed an answer | `502 phone_validation_incomplete` |

## Consumer integration

InfiniteAPI is a motor/library and intentionally does not define an HTTP route.
A consumer may expose its own authenticated endpoint, for example:

```http
POST /internal/instances/:instanceId/validate-phone
Content-Type: application/json

{
	"phone": "558389128418",
	"candidates": ["558389128418", "5583989128418"]
}
```

The consumer should return the motor result verbatim. It must not use the call
to mutate a paired JID, transport profile, or session credentials. Use
`acceptedJid` only after the motor explicitly returns it.

### PhoneMetadataProvider

The consumer can supply a custom `PhoneMetadataProvider` via
`SocketConfig.phoneMetadataProvider`. When absent, the motor loads the
`countries.tsv` from the configured path or classifies everything as `'unknown'`.
