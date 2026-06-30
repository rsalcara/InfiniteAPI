/**
 * WhatsApp @username feature (rolling out 2026).
 *
 * Replaces phone-number-based identity with a chosen handle (`@tuoli`),
 * so that contacts who haven't saved your number can still find / message
 * you without seeing the underlying PN.
 *
 * Discovered by reverse-engineering the WhatsApp Web bundle
 * (`static.whatsapp.net/rsrc.php/v4*` chunks) — there is no upstream
 * Baileys implementation for the OUTBOUND side. Inbound (parsing
 * `*_username` attrs in stanzas, storing on Contact/GroupMetadata) was
 * already landed in upstream PR #2480 ("feat: add initial username
 * INBOUND and Usync support", merged 2026-04-24) which we have herdado.
 *
 * The OUTBOUND surface uses MEX (Mobile Exchange — GraphQL transported
 * over WhatsApp Noise as `xmlns="w:mex"` IQ stanzas). The four operations
 * below all use the existing `executeWMexQuery` helper in
 * `src/Socket/mex.ts` — only the query IDs + variable shape + response
 * `xwa2_*` field name are username-specific.
 *
 * Identifier convention: the enum/string names mirror the WhatsApp
 * server-side spelling verbatim (`xwa2_username_set`, etc.) instead of
 * camelCase translations, so server logs / Wireshark captures / FAQ docs
 * keep working as ctrl-F search anchors. Same convention `newsletter.ts`
 * uses for its `XWAPaths`.
 */

/**
 * Lifecycle state of the account's own `@username`, as reported by the
 * `xwa2_username_get` GraphQL query.
 *
 *   - `RESERVED` — the user has claimed the handle but the feature is
 *     still in "reservation only mode" (the current public phase, gated
 *     by the `username_reservation_only_mode` AB prop). Messages are
 *     still addressed via PN/LID.
 *   - `ACTIVE`   — the user is fully on the username addressing path:
 *     other parties see `@username` and (unless they have the PN saved)
 *     no longer see the phone number.
 *   - `DELETED`  — soft-deleted; the handle is still server-side known
 *     for grace-period anti-recycling but not advertised.
 *   - `NONE`     — never set.
 *
 * Treat as opaque — server may add new states (e.g. SUSPENDED). Callers
 * should compare with `=== 'RESERVED'` etc. rather than exhaustive
 * switch.
 */
export type UsernameState = 'RESERVED' | 'ACTIVE' | 'DELETED' | 'NONE' | string

/**
 * Result codes returned by the four `xwa2_username_*` GraphQL operations.
 * Like {@link UsernameState}, this is opaque — the server may add codes.
 *
 * Observed values from the WAWebMexClient error handler:
 *   - `SUCCESS`                — set / delete / pin_set succeeded
 *   - `AVAILABLE` / `TAKEN`    — `xwa2_username_check` outcomes
 *   - `INVALID`                — username violates format rules
 *   - `INVALID_PIN` / `INCORRECT_PIN` — pin set with wrong current pin
 *   - `RESERVED_ONLY_PHASE`    — server is in reservation-only mode and
 *     rejected an `ACTIVE`-mode mutation
 */
export type UsernameResult =
	| 'SUCCESS'
	| 'AVAILABLE'
	| 'TAKEN'
	| 'INVALID'
	| 'INVALID_PIN'
	| 'INCORRECT_PIN'
	| 'RESERVED_ONLY_PHASE'
	| string

/**
 * `doc_id` (query_id) values for the four MEX GraphQL operations.
 *
 * Pinned from the WhatsApp Web bundle as of 2026-06-30. Like the
 * newsletter `QueryIds`, these MUST be updated when WA Web rotates them
 * — there is no version negotiation. A rotation manifests as the server
 * returning `MexFatalExtensionError` with `error_code: 421` ("unknown
 * query"); when that happens, the new IDs can be re-extracted by
 * grepping the bundle for `WAWebMexGetUsernameJobQuery` (etc.) and
 * reading the adjacent `params.id` string.
 */
export enum UsernameQueryIds {
	/** `WAWebMexGetUsernameJobQuery` — read own username + state (+ pin if provided) */
	GET = '25347099718279209',
	/** `WAWebMexSetUsernameJobMutation` — reserve / change / delete own username */
	SET = '25757341163897635',
	/** `WAWebMexUsernameAvailabilityQuery` — pre-validate handle availability */
	CHECK = '26122779627399568',
	/** `WAWebMexSetUsernameKeyJobMutation` — set / change the anti-spoof PIN ("chave") */
	PIN_SET = '9749436995157074'
}

/**
 * Server-side response data-paths used in the `data` envelope of the
 * `<result>` payload. Same role as the newsletter `XWAPaths` enum.
 */
export enum XWAUsernamePaths {
	GET = 'xwa2_username_get',
	SET = 'xwa2_username_set',
	CHECK = 'xwa2_username_check',
	PIN_SET = 'xwa2_username_pin_set'
}

/**
 * Response shape of `xwa2_username_get`. The GraphQL selection set
 * exposes `username`, `state`, and `pin` directly; the `pin` field is
 * only populated when the caller passed a `pin` variable that matches
 * the server-side stored PIN (so this doubles as a "verify pin" probe).
 */
export interface UsernameGetResponse {
	username?: string
	state?: UsernameState
	pin?: string
	result?: UsernameResult
}

/**
 * Response shape of `xwa2_username_set` / `xwa2_username_pin_set` —
 * these mutations only return a status code.
 */
export interface UsernameMutationResponse {
	result: UsernameResult
}

/**
 * Response shape of `xwa2_username_check`. `suggestions` is populated
 * when `result === 'TAKEN'` to help the UI offer adjacent handles.
 */
export interface UsernameCheckResponse {
	result: UsernameResult
	suggestions?: string[]
}

/**
 * Options accepted by `setMyUsername` and `checkUsernameAvailability`.
 * Both fields are observability hooks the WhatsApp telemetry pipeline
 * uses to correlate "user typed X → checked Y → set Z" — they have no
 * effect on the mutation's outcome but are required by the server when
 * the AB-prop `username_check_debounce_in_ms > 0` (which is the default).
 *
 * Defaults: `sessionId` is a fresh random hex string and `source` is
 * `'USER_INPUT'`. Override `source` to `'RESTORE'` for bulk-import
 * flows and `'API'` for programmatic callers; the values are free-form
 * and the server treats anything as opaque telemetry.
 */
export interface UsernameMutationOptions {
	sessionId?: string
	source?: string
}
