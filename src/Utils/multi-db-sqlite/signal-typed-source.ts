/**
 * Source-of-truth adapter over `axolotl.db`'s typed Signal tables
 * (`sessions`/`prekeys`/`sender_keys`/`identities`).
 *
 * Unlike `signal-typed-mirror.ts` (which writes a best-effort, introspection-
 * only copy while `signal_kv` stays authoritative), this store makes the
 * typed tables the PRIMARY read/write surface for the Signal key store —
 * the same way WhatsApp Android reads sessions/prekeys/identities/sender-keys
 * from these structured tables rather than an opaque blob.
 *
 * It deals in the SAME serialized value string the opaque `signal_kv` uses
 * (`JSON.stringify(value, BufferJSON.replacer)`), stored verbatim in each
 * table's `record` / `public_key` column. That guarantees a byte-identical
 * round-trip for every data type — including `pre-key`, whose value is a
 * `{ public, private }` KeyPair that a raw-bytes column could not hold.
 * (The record bytes are therefore InfiniteAPI's own serialization, not
 * WhatsApp-android's libsignal record format — byte-faithfulness to the
 * mobile record layout is impossible across two different libsignal
 * implementations; structural fidelity — keyed + read like the mobile
 * schema — is what this provides.)
 *
 * The caller (`use-multi-db-sqlite-auth-state.ts`) pairs every write here
 * with a `signal_kv` write in the SAME axolotl.db transaction (both tables
 * live in one file, so the dual-write is atomic and can never diverge), and
 * falls back to `signal_kv` on a typed-table miss so pre-migration rows keep
 * resolving. Identity keys are the one deliberate representation exception:
 * `signal_kv` keeps BufferJSON for public API compatibility, while the typed
 * Android-compatible table stores the decoded raw public-key bytes.
 */
import { BufferJSON } from '../generics'
import type { ILogger } from '../logger'
import type { JidMapBackend } from './lid-mapping-backend'
import type { IdentityKeyFallback } from './signal-id-parsing'
import {
	classifyIdentityKey,
	domainTypeToAccountType,
	parseIdentityKey,
	parseNonNegativeInt,
	parseProtocolAddressId,
	parseSenderKeyId
} from './signal-id-parsing'
import type { SignalTypedBackend } from './signal-typed-backend'

export type TypedSignalType = 'session' | 'pre-key' | 'sender-key' | 'identity-key'

type IdentityKeyRow = { recipientId: number; recipientType: number; deviceId: number | null }

const toBuffer = (valueString: string): Buffer => Buffer.from(valueString, 'utf-8')

const tupleKey = (...values: ReadonlyArray<string | number>): string => JSON.stringify(values)

/** Adds an original id to a parsed key and reports whether the key is new. */
const addAlias = <Key>(aliasesByKey: Map<Key, string[]>, key: Key, id: string): boolean => {
	const aliases = aliasesByKey.get(key)
	if (aliases) {
		aliases.push(id)
		return false
	}

	aliasesByKey.set(key, [id])
	return true
}

const writeAliases = (out: { [id: string]: string }, aliases: string[] | undefined, value: string): void => {
	if (!aliases) return
	for (const id of aliases) out[id] = value
}

export class SignalTypedSourceStore {
	private readonly backend: SignalTypedBackend
	private readonly logger?: ILogger

	constructor(backend: SignalTypedBackend, _jidMap: JidMapBackend, logger?: ILogger) {
		this.backend = backend
		this.logger = logger
	}

	/**
	 * Reads the serialized value string for `(type, id)` from the typed
	 * table, or `null` if the row is absent or the id can't be parsed into
	 * the table's structured key (in which case the caller falls back to
	 * `signal_kv`). Never throws — a lookup failure degrades to `null`.
	 */
	get(type: TypedSignalType, id: string): string | null {
		try {
			switch (type) {
				case 'session': {
					const parsed = parseProtocolAddressId(id)
					if (!parsed) return null
					const recipientAccountType = domainTypeToAccountType(parsed.domainType)
					if (recipientAccountType === null) return null
					const row = this.backend.getSession({
						deviceId: parsed.deviceId,
						recipientAccountId: parsed.user,
						recipientAccountType
					})
					return row ? row.record.toString('utf-8') : null
				}

				case 'pre-key': {
					const prekeyId = parseNonNegativeInt(id)
					if (prekeyId === null) return null
					const record = this.backend.getPrekey(prekeyId)
					return record ? record.toString('utf-8') : null
				}

				case 'sender-key': {
					const parsed = parseSenderKeyId(id)
					if (!parsed) return null
					const senderAccountType = domainTypeToAccountType(parsed.sender.domainType)
					if (senderAccountType === null) return null
					const row = this.backend.getSenderKey({
						groupId: parsed.groupId,
						deviceId: parsed.sender.deviceId,
						senderAccountId: parsed.sender.user,
						senderAccountType
					})
					return row ? row.record.toString('utf-8') : null
				}

				case 'identity-key': {
					const key = this.identityKeyForRead(id)
					if (!key) return null
					const row = this.backend.getIdentity(key)
					return row ? JSON.stringify(row.publicKey, BufferJSON.replacer) : null
				}
			}
		} catch (err) {
			this.logger?.warn?.(
				{ err, type, id },
				'multi-db-sqlite: typed signal store get failed, caller falls back to signal_kv'
			)
			return null
		}
	}

	/**
	 * Batched {@link get}: resolves N ids with cached, bounded row-value `IN`
	 * queries instead of N point lookups — the round-trip amortization matters
	 * most for the session/sender-key fanout on a group send. Returns a map of
	 * id→serialized string for HITS only; an id that misses or can't be parsed
	 * is simply absent (the caller treats absent as a miss and falls back to
	 * `signal_kv`, identical to the per-id path). Semantics are byte-identical
	 * to calling {@link get} for each id — verified by an equivalence test.
	 * Never throws — degrades to an empty prototype-less result.
	 */
	getMany(type: TypedSignalType, ids: ReadonlyArray<string>): { [id: string]: string } {
		const out = Object.create(null) as { [id: string]: string }
		if (ids.length === 0) return out
		try {
			switch (type) {
				case 'session': {
					const aliasesByKey = new Map<string, string[]>()
					const keys: Array<{ deviceId: number; recipientAccountId: string; recipientAccountType: number }> = []
					for (const id of ids) {
						const parsed = parseProtocolAddressId(id)
						if (!parsed) continue
						const recipientAccountType = domainTypeToAccountType(parsed.domainType)
						if (recipientAccountType === null) continue
						const k = {
							deviceId: parsed.deviceId,
							recipientAccountId: parsed.user,
							recipientAccountType
						}
						const key = tupleKey(k.deviceId, k.recipientAccountId, k.recipientAccountType)
						if (addAlias(aliasesByKey, key, id)) keys.push(k)
					}

					for (const row of this.backend.getManySessions(keys)) {
						const aliases = aliasesByKey.get(
							tupleKey(row.device_id, row.recipient_account_id, row.recipient_account_type)
						)
						writeAliases(out, aliases, row.record.toString('utf-8'))
					}

					return out
				}

				case 'pre-key': {
					const aliasesByKey = new Map<number, string[]>()
					const prekeyIds: number[] = []
					for (const id of ids) {
						const prekeyId = parseNonNegativeInt(id)
						if (prekeyId === null) continue
						if (addAlias(aliasesByKey, prekeyId, id)) prekeyIds.push(prekeyId)
					}

					for (const row of this.backend.getManyPrekeys(prekeyIds)) {
						const aliases = aliasesByKey.get(row.prekey_id)
						writeAliases(out, aliases, row.record.toString('utf-8'))
					}

					return out
				}

				case 'sender-key': {
					const aliasesByKey = new Map<string, string[]>()
					const keys: Array<{
						groupId: string
						deviceId: number
						senderAccountId: string
						senderAccountType: number
					}> = []
					for (const id of ids) {
						const parsed = parseSenderKeyId(id)
						if (!parsed) continue
						const senderAccountType = domainTypeToAccountType(parsed.sender.domainType)
						if (senderAccountType === null) continue
						const k = {
							groupId: parsed.groupId,
							deviceId: parsed.sender.deviceId,
							senderAccountId: parsed.sender.user,
							senderAccountType
						}
						const key = tupleKey(k.groupId, k.deviceId, k.senderAccountId, k.senderAccountType)
						if (addAlias(aliasesByKey, key, id)) keys.push(k)
					}

					for (const row of this.backend.getManySenderKeys(keys)) {
						const aliases = aliasesByKey.get(
							tupleKey(row.group_id, row.device_id, row.sender_account_id, row.sender_account_type)
						)
						writeAliases(out, aliases, row.record.toString('utf-8'))
					}

					return out
				}

				case 'identity-key': {
					const aliasesByKey = new Map<string, string[]>()
					const keys: IdentityKeyRow[] = []
					for (const id of ids) {
						const key = this.identityKeyForRead(id)
						if (!key) continue
						// device_id null is coerced to the sentinel (0) both in the
						// batch query and its returned column — mirror that here.
						const tuple = tupleKey(key.recipientId, key.recipientType, key.deviceId ?? 0)
						if (addAlias(aliasesByKey, tuple, id)) keys.push(key)
					}

					for (const row of this.backend.getManyIdentities(keys)) {
						const aliases = aliasesByKey.get(tupleKey(row.recipient_id, row.recipient_type, row.device_id))
						writeAliases(out, aliases, JSON.stringify(row.public_key, BufferJSON.replacer))
					}

					return out
				}
			}
		} catch (err) {
			this.logger?.warn?.(
				{ err, type },
				'multi-db-sqlite: typed signal store getMany failed, caller falls back to signal_kv'
			)
			return out
		}
	}

	/**
	 * Writes the serialized value string for `(type, id)` into the typed
	 * table. Called INSIDE the caller's axolotl.db transaction alongside the
	 * `signal_kv` write. A parse failure logs and no-ops the typed write —
	 * the paired `signal_kv` write still lands, so no data is lost (the row
	 * simply won't have a typed mirror and will resolve via fallback).
	 */
	set(type: TypedSignalType, id: string, valueString: string): void {
		const record = toBuffer(valueString)
		switch (type) {
			case 'session': {
				const parsed = parseProtocolAddressId(id)
				if (!parsed) return this.warnUnparsed(type, id)
				const recipientAccountType = domainTypeToAccountType(parsed.domainType)
				if (recipientAccountType === null) return this.warnUnsupportedDomain(type, id, parsed.domainType)
				this.backend.putSession(
					{
						deviceId: parsed.deviceId,
						recipientAccountId: parsed.user,
						recipientAccountType
					},
					record
				)
				return
			}

			case 'pre-key': {
				const prekeyId = parseNonNegativeInt(id)
				if (prekeyId === null) return this.warnUnparsed(type, id)
				this.backend.putPrekey(prekeyId, record)
				return
			}

			case 'sender-key': {
				const parsed = parseSenderKeyId(id)
				if (!parsed) return this.warnUnparsed(type, id)
				const senderAccountType = domainTypeToAccountType(parsed.sender.domainType)
				if (senderAccountType === null) return this.warnUnsupportedDomain(type, id, parsed.sender.domainType)
				this.backend.putSenderKey(
					{
						groupId: parsed.groupId,
						deviceId: parsed.sender.deviceId,
						senderAccountId: parsed.sender.user,
						senderAccountType
					},
					record
				)
				return
			}

			case 'identity-key': {
				const parsed = classifyIdentityKey(id)
				if (parsed.kind === 'fallback') return this.warnIdentityFallback(id, parsed)
				const publicKey = JSON.parse(valueString, BufferJSON.reviver)
				if (!(publicKey instanceof Uint8Array)) {
					this.backend.deleteIdentity({
						recipientId: parsed.key.recipientId,
						recipientType: parsed.key.recipientType,
						deviceId: parsed.key.deviceId
					})
					return this.warnUnparsed(type, id)
				}

				this.backend.putIdentity(
					{
						recipientId: parsed.key.recipientId,
						recipientType: parsed.key.recipientType,
						deviceId: parsed.key.deviceId
					},
					publicKey
				)
				return
			}
		}
	}

	/**
	 * Removes the `(type, id)` row from the typed table. Correctness here is
	 * load-bearing: because reads hit the typed table FIRST, a delete that
	 * failed to remove the typed row would let a stale value shadow the
	 * delete. Every one of the 4 types therefore has a real delete primitive.
	 */
	del(type: TypedSignalType, id: string): void {
		switch (type) {
			case 'session': {
				const parsed = parseProtocolAddressId(id)
				if (!parsed) return this.warnUnparsed(type, id)
				const recipientAccountType = domainTypeToAccountType(parsed.domainType)
				if (recipientAccountType === null) return
				this.backend.deleteSession({
					deviceId: parsed.deviceId,
					recipientAccountId: parsed.user,
					recipientAccountType
				})
				return
			}

			case 'pre-key': {
				const prekeyId = parseNonNegativeInt(id)
				if (prekeyId === null) return this.warnUnparsed(type, id)
				this.backend.deletePrekey(prekeyId)
				return
			}

			case 'sender-key': {
				const parsed = parseSenderKeyId(id)
				if (!parsed) return this.warnUnparsed(type, id)
				const senderAccountType = domainTypeToAccountType(parsed.sender.domainType)
				if (senderAccountType === null) return
				this.backend.deleteSenderKey({
					groupId: parsed.groupId,
					deviceId: parsed.sender.deviceId,
					senderAccountId: parsed.sender.user,
					senderAccountType
				})
				return
			}

			case 'identity-key': {
				// Read-only jid resolution: an unknown jid means there is
				// nothing to delete (no-op) rather than materializing a junk
				// jid row just to issue a DELETE that matches nothing.
				const key = this.identityKeyForRead(id)
				if (!key) return
				this.backend.deleteIdentity(key)
				return
			}
		}
	}

	/**
	 * Resolves the protocol address to Android's numeric recipient_id. The
	 * identities table does not reference msgstore.jid: official captures store
	 * the actual PN/LID number here (and -1 for the local identity).
	 */
	private identityKeyForRead(id: string): IdentityKeyRow | null {
		const parsed = parseIdentityKey(id)
		if (!parsed) return null
		return {
			recipientId: parsed.recipientId,
			recipientType: parsed.recipientType,
			deviceId: parsed.deviceId
		}
	}

	private warnUnparsed(type: TypedSignalType, id: string): void {
		this.logger?.debug?.(
			{ type, id },
			'multi-db-sqlite: could not parse id for typed signal store, signal_kv still written'
		)
	}

	private warnUnsupportedDomain(type: TypedSignalType, id: string, domainType: number): void {
		this.logger?.debug?.(
			{ type, id, domainType, reason: 'hosted-or-unknown-domain' },
			'multi-db-sqlite: signal id not mapped to a typed row, signal_kv still written'
		)
	}

	/**
	 * Identity-key writes can skip the typed table because the id is unparseable,
	 * hosted, has an unknown domain, or uses an unsupported jid server. Preserve
	 * that exact reason as structured context instead of collapsing expected
	 * hosted fallback and malformed input into the same generic warning.
	 */
	private warnIdentityFallback(id: string, fallback: IdentityKeyFallback): void {
		this.logger?.debug?.(
			{
				id,
				reason: fallback.reason,
				domainType: fallback.domainType,
				server: fallback.server
			},
			'multi-db-sqlite: identity-key not mapped to a typed row, signal_kv still written'
		)
	}
}
