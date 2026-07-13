import type { FullJid } from '../WABinary'

/** A cached device plus the transient jid carried by device notifications. */
export type DeviceListDeltaEntry = FullJid & { jid?: string }

/**
 * Applies an `add`/`remove` device-list delta (from a `<notification
 * type="devices">`) onto the cached device list, returning the new list.
 *
 * Extracted + exported so it is unit-testable — this is exactly where the #621
 * bug lived: the notification parser yields `device: undefined` for the primary
 * (a `0` device suffix is dropped by `jidDecode`), while the cache (both the
 * JSON mirror and the typed store's read-back) stores the primary as `device:
 * 0`. Comparing `undefined` against `0` in the delta would MISS the primary — a
 * `remove` wouldn't drop it and an `add` would append a duplicate. So we
 * normalize `device ?? 0` on BOTH sides before diffing.
 */
export const applyDeviceListDelta = (
	existing: readonly FullJid[],
	entries: readonly DeviceListDeltaEntry[],
	tag: 'add' | 'remove'
): FullJid[] => {
	// Canonicalize EVERY entry the helper emits with `device: 0` for the primary
	// (never `undefined`), on both the fresh (`normalized`) and passed-through
	// (`kept`) sides:
	//   - `device ?? 0` — a downstream re-diff against a `device: 0` cache must
	//     not miss the primary again (the redundant defense this helper promises).
	//   - omit ONLY `jid` — it is a notification-parser artifact. All FullJid
	//     fields, especially `domainType`, must survive so the JSON mirror remains
	//     value-identical to the typed-first user-device cache read.
	const canonicalize = ({ jid, ...device }: DeviceListDeltaEntry): FullJid => {
		// Mark the intentionally omitted parser-only field as consumed.
		void jid

		return { ...device, device: device.device ?? 0 }
	}

	const normalized = entries.map(canonicalize)
	const affected = new Set(normalized.map(e => e.device))
	const kept = existing.filter(d => !affected.has(d.device ?? 0)).map(canonicalize)
	// `add`: drop any stale entry for an affected device, then append the fresh
	// (normalized) ones. `remove`: just drop the affected devices.
	return tag === 'remove' ? kept : [...kept, ...normalized]
}
