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
	// Canonicalize EVERY entry the helper emits to exactly `{ user, server,
	// device }` with `device: 0` for the primary (never `undefined`), on both the
	// fresh (`normalized`) and passed-through (`kept`) sides:
	//   - `device ?? 0` — a downstream re-diff against a `device: 0` cache must
	//     not miss the primary again (the redundant defense this helper promises).
	//   - strip to 3 fields — `entries` arrives as `DecodedDevice` (carrying a
	//     transient `jid`); the cache persists only `{ user, server, device }`
	//     (matching the pre-refactor shape), so spreading `...e` would leak `jid`.
	// `server` is carried at runtime (the cache persists `{ user, server, device }`)
	// even though it isn't on `JidWithDevice`; keep it, drop everything else (e.g.
	// the parser's transient `jid`).
	type CachedDevice = JidWithDevice & { server?: string }
	const canonicalize = ({ user, server, device }: CachedDevice): CachedDevice => ({
		user,
		server,
		device: device ?? 0
	})
	const normalized = entries.map(canonicalize)
	const affected = new Set(normalized.map(e => e.device))
	const kept = existing.filter(d => !affected.has(d.device ?? 0)).map(canonicalize)
	// `add`: drop any stale entry for an affected device, then append the fresh
	// (normalized) ones. `remove`: just drop the affected devices.
	return tag === 'remove' ? kept : [...kept, ...normalized]
}
