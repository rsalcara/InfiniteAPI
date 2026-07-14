/**
 * Best-effort mirror of `session`/`pre-key`/`sender-key`/`identity-key`
 * writes into `axolotl.db`'s typed tables (`SignalTypedBackend`), alongside
 * the opaque `signal_kv` write that remains the one source
 * `Signal/libsignal.ts` actually reads from.
 *
 * Deliberately one-directional and best-effort: a parse failure or SQLite
 * error here is caught and logged, never thrown — this mirror exists for
 * introspection (matching WhatsApp Android's own schema, confirmed via
 * Frida capture) and must never be able to affect what the real
 * `signal_kv` read/write path does for message encryption/decryption.
 */
import type { ILogger } from '../logger'
import type { JidMapBackend } from './lid-mapping-backend'
import {
	domainTypeToAccountType,
	parseIdentityKey,
	parseNonNegativeInt,
	parseProtocolAddressId,
	parseSenderKeyId
} from './signal-id-parsing'
import type { SignalTypedBackend } from './signal-typed-backend'

export type SignalMirrorDeps = {
	signalTypedBackend: SignalTypedBackend
	/** Resolves jid row ids against `msgstore.db.jid` — only `identity-key` needs this. */
	jidMapBackend: JidMapBackend
	logger?: ILogger
}

/**
 * Mirrors one `(type, id, value)` triple from a `SignalDataSet` bucket.
 * `value === null` means "delete" — `SignalTypedBackend` only exposes
 * delete primitives for `session`/`pre-key` (real Baileys code never nulls
 * out an identity or sender-key entry today, and the mobile schema treats
 * both as append/replace-only), so a null `identity-key`/`sender-key`
 * mirror write is a no-op here, not a silent data-loss bug.
 */
export function mirrorSignalEntry(
	type: 'session' | 'pre-key' | 'sender-key' | 'identity-key',
	id: string,
	value: Uint8Array | { public: Uint8Array } | null | undefined,
	deps: SignalMirrorDeps
): void {
	try {
		switch (type) {
			case 'session': {
				const parsed = parseProtocolAddressId(id)
				if (!parsed) {
					deps.logger?.debug?.({ id }, 'multi-db-sqlite: could not parse session id for typed mirror, skipping')
					return
				}

				const key = {
					deviceId: parsed.deviceId,
					recipientAccountId: parsed.user,
					recipientAccountType: domainTypeToAccountType(parsed.domainType)
				}
				if (value === null || value === undefined) {
					deps.signalTypedBackend.deleteSession(key)
				} else {
					deps.signalTypedBackend.putSession(key, value as Uint8Array)
				}

				return
			}

			case 'pre-key': {
				const prekeyId = parseNonNegativeInt(id)
				if (prekeyId === null) {
					deps.logger?.debug?.({ id }, 'multi-db-sqlite: non-numeric pre-key id for typed mirror, skipping')
					return
				}

				if (value === null || value === undefined) {
					deps.signalTypedBackend.deletePrekey(prekeyId)
				} else {
					// `pre-key` values are `KeyPair` ({ public, private }) — the typed
					// `prekeys.record` column mirrors WhatsApp Android's own opaque
					// serialized-record BLOB, so this stores the public half (the
					// only half a private-key-less introspection query needs) as a
					// stand-in record. Full KeyPair serialization is out of scope
					// for a best-effort mirror already covered by signal_kv.
					deps.signalTypedBackend.putPrekey(prekeyId, (value as { public: Uint8Array }).public)
				}

				return
			}

			case 'sender-key': {
				const parsed = parseSenderKeyId(id)
				if (!parsed) {
					deps.logger?.debug?.({ id }, 'multi-db-sqlite: could not parse sender-key id for typed mirror, skipping')
					return
				}

				if (value === null || value === undefined) return // no delete primitive — see doc above
				deps.signalTypedBackend.putSenderKey(
					{
						groupId: parsed.groupId,
						deviceId: parsed.sender.deviceId,
						senderAccountId: parsed.sender.user,
						senderAccountType: domainTypeToAccountType(parsed.sender.domainType)
					},
					value as Uint8Array
				)

				return
			}

			case 'identity-key': {
				if (value === null || value === undefined) return // no delete primitive — see doc above
				// identity-key ids are PROTOCOL ADDRESSES (`user_domainType.device`),
				// not jids — parse them via the shared parser (jidDecode failed here,
				// which is why the typed identities mirror was empty in this
				// kill-switch path). PN/LID only; hosted/unknown → signal_kv fallback.
				const parsed = parseIdentityKey(id)
				if (!parsed) {
					// Two non-error reasons: unparseable id, OR a hosted/unknown domain
					// deliberately left to signal_kv (reconstructing it onto a shared
					// server would collide with a real PN identity — see parseIdentityKey).
					deps.logger?.debug?.(
						{ id },
						'multi-db-sqlite: identity-key not mirrored to typed table (unparseable, or a hosted/unknown domain deliberately left to signal_kv)'
					)
					return
				}

				deps.signalTypedBackend.putIdentity(
					{
						recipientId: deps.jidMapBackend.resolveJidRowId(parsed.jid),
						recipientType: parsed.recipientType,
						deviceId: parsed.deviceId
					},
					value as Uint8Array
				)

				return
			}
		}
	} catch (err) {
		deps.logger?.warn?.(
			{ err, type, id },
			'multi-db-sqlite: signal typed-table mirror write failed, signal_kv unaffected'
		)
	}
}

/** Type guard so callers can filter a generic `SignalDataSet` category name down to the ones this mirror handles. */
export function isMirroredSignalType(type: string): type is 'session' | 'pre-key' | 'sender-key' | 'identity-key' {
	return type === 'session' || type === 'pre-key' || type === 'sender-key' || type === 'identity-key'
}
