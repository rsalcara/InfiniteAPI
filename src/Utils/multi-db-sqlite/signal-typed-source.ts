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
 * resolving. See that file for the full read/write policy.
 */
import { jidDecode } from '../../WABinary'
import type { ILogger } from '../logger'
import type { JidMapBackend } from './lid-mapping-backend'
import { domainTypeToAccountType, parseProtocolAddressId, parseSenderKeyId } from './signal-id-parsing'
import type { SignalTypedBackend } from './signal-typed-backend'

export type TypedSignalType = 'session' | 'pre-key' | 'sender-key' | 'identity-key'

type IdentityKeyRow = { recipientId: number; recipientType: number; deviceId: number | null }

const toBuffer = (valueString: string): Buffer => Buffer.from(valueString, 'utf-8')

export class SignalTypedSourceStore {
	private readonly backend: SignalTypedBackend
	private readonly jidMap: JidMapBackend
	private readonly logger?: ILogger

	constructor(backend: SignalTypedBackend, jidMap: JidMapBackend, logger?: ILogger) {
		this.backend = backend
		this.jidMap = jidMap
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
					const row = this.backend.getSession({
						deviceId: parsed.deviceId,
						recipientAccountId: parsed.user,
						recipientAccountType: domainTypeToAccountType(parsed.domainType)
					})
					return row ? row.record.toString('utf-8') : null
				}

				case 'pre-key': {
					const prekeyId = Number(id)
					if (!Number.isInteger(prekeyId)) return null
					const record = this.backend.getPrekey(prekeyId)
					return record ? record.toString('utf-8') : null
				}

				case 'sender-key': {
					const parsed = parseSenderKeyId(id)
					if (!parsed) return null
					const row = this.backend.getSenderKey({
						groupId: parsed.groupId,
						deviceId: parsed.sender.deviceId,
						senderAccountId: parsed.sender.user,
						senderAccountType: domainTypeToAccountType(parsed.sender.domainType)
					})
					return row ? row.record.toString('utf-8') : null
				}

				case 'identity-key': {
					// Read-only jid resolution: an unknown jid returns null (→
					// caller falls back to signal_kv) instead of materializing a
					// junk `jid` row on a pure read.
					const key = this.identityKeyForRead(id)
					if (!key) return null
					const row = this.backend.getIdentity(key)
					return row ? row.publicKey.toString('utf-8') : null
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
				this.backend.putSession(
					{
						deviceId: parsed.deviceId,
						recipientAccountId: parsed.user,
						recipientAccountType: domainTypeToAccountType(parsed.domainType)
					},
					record
				)
				return
			}

			case 'pre-key': {
				const prekeyId = Number(id)
				if (!Number.isInteger(prekeyId)) return this.warnUnparsed(type, id)
				this.backend.putPrekey(prekeyId, record)
				return
			}

			case 'sender-key': {
				const parsed = parseSenderKeyId(id)
				if (!parsed) return this.warnUnparsed(type, id)
				this.backend.putSenderKey(
					{
						groupId: parsed.groupId,
						deviceId: parsed.sender.deviceId,
						senderAccountId: parsed.sender.user,
						senderAccountType: domainTypeToAccountType(parsed.sender.domainType)
					},
					record
				)
				return
			}

			case 'identity-key': {
				// Write path: resolve-or-create the jid row — storing an identity
				// for a not-yet-seen contact must materialize its jid row (same
				// as the mirror does).
				const key = this.identityKeyForWrite(id)
				if (!key) return this.warnUnparsed(type, id)
				this.backend.putIdentity(key, record)
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
				this.backend.deleteSession({
					deviceId: parsed.deviceId,
					recipientAccountId: parsed.user,
					recipientAccountType: domainTypeToAccountType(parsed.domainType)
				})
				return
			}

			case 'pre-key': {
				const prekeyId = Number(id)
				if (!Number.isInteger(prekeyId)) return this.warnUnparsed(type, id)
				this.backend.deletePrekey(prekeyId)
				return
			}

			case 'sender-key': {
				const parsed = parseSenderKeyId(id)
				if (!parsed) return this.warnUnparsed(type, id)
				this.backend.deleteSenderKey({
					groupId: parsed.groupId,
					deviceId: parsed.sender.deviceId,
					senderAccountId: parsed.sender.user,
					senderAccountType: domainTypeToAccountType(parsed.sender.domainType)
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
	 * Resolves an `identity-key` id (a raw jid string) into the structured
	 * `identities` key for a WRITE. `recipient_id` is the local `jid` row id,
	 * resolve-or-created via the shared JidMapBackend (storing an identity for
	 * a new contact must materialize its jid row, same as the mirror);
	 * `recipient_type` is 0=PN / 1=LID from the jid's domain, `device_id` from
	 * the jid. Returns `null` when the jid can't be decoded.
	 */
	private identityKeyForWrite(id: string): IdentityKeyRow | null {
		const decoded = jidDecode(id)
		if (!decoded) return null
		return {
			recipientId: this.jidMap.resolveJidRowId(id),
			recipientType: domainTypeToAccountType(decoded.domainType ?? 0),
			deviceId: decoded.device ?? null
		}
	}

	/**
	 * Read-only variant of {@link identityKeyForWrite} for get/del: resolves
	 * the jid row id via a pure lookup, returning `null` if the jid was never
	 * seen — so a read never mutates `msgstore.db.jid`.
	 */
	private identityKeyForRead(id: string): IdentityKeyRow | null {
		const decoded = jidDecode(id)
		if (!decoded) return null
		const recipientId = this.jidMap.lookupJidRowId(id)
		if (recipientId === null) return null
		return {
			recipientId,
			recipientType: domainTypeToAccountType(decoded.domainType ?? 0),
			deviceId: decoded.device ?? null
		}
	}

	private warnUnparsed(type: TypedSignalType, id: string): void {
		this.logger?.debug?.(
			{ type, id },
			'multi-db-sqlite: could not parse id for typed signal store, signal_kv still written'
		)
	}
}
