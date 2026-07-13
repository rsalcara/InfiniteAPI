import type { JidWithDevice } from '../WABinary'

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
	existing: readonly JidWithDevice[],
	entries: readonly JidWithDevice[],
	tag: 'add' | 'remove'
): JidWithDevice[] => {
	// Normalize the primary (`device ?? 0`) up front so the helper ALWAYS emits
	// the canonical shape (`device: 0`, never `undefined`) — not just compares by
	// it. Returning an un-normalized `{ device: undefined }` from `add` would
	// weaken the redundant defense this helper promises (a downstream re-diff
	// against a `device: 0` cache would miss it again).
	const normalized = entries.map(e => ({ ...e, device: e.device ?? 0 }))
	const affected = new Set(normalized.map(e => e.device))
	const kept = existing.filter(d => !affected.has(d.device ?? 0))
	// `add`: drop any stale entry for an affected device, then append the fresh
	// (normalized) ones. `remove`: just drop the affected devices.
	return tag === 'remove' ? kept : [...kept, ...normalized]
}
