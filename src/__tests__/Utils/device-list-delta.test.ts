import { applyDeviceListDelta, type DeviceListDeltaEntry } from '../../Utils/device-list-delta'
import type { FullJid } from '../../WABinary'

// The #621 regression: the notification parser yields `device: undefined` for
// the primary (a `0` suffix is dropped by jidDecode), but the cache stores it as
// `device: 0`. The delta must normalize both sides or it misses the primary.
describe('applyDeviceListDelta (#621 device-0 normalization)', () => {
	const pnServer = 's.whatsapp.net' as const
	const cache: FullJid[] = [
		{ user: '5511999', server: pnServer, domainType: 0, device: 0 }, // primary (stored as 0)
		{ user: '5511999', server: pnServer, domainType: 0, device: 1 }
	]

	it('remove: drops the primary even when the notification carries device: undefined', () => {
		const entries = [{ user: '5511999', server: pnServer, device: undefined }] // primary, un-normalized
		const result = applyDeviceListDelta(cache, entries, 'remove')
		expect(result.map(d => d.device ?? 0)).toEqual([1]) // primary removed, device 1 kept
	})

	it('add: does NOT duplicate the primary when re-added as device: undefined', () => {
		const entries = [{ user: '5511999', server: pnServer, device: undefined }]
		const result = applyDeviceListDelta(cache, entries, 'add')
		// exactly one primary entry (the fresh one), plus the untouched device 1
		expect(result.filter(d => (d.device ?? 0) === 0)).toHaveLength(1)
		expect(result.map(d => d.device ?? 0).sort()).toEqual([0, 1])
	})

	it('add: returns the canonical shape (device: 0, never undefined) for the primary', () => {
		// The helper must normalize what it RETURNS, not only what it compares —
		// otherwise a downstream re-diff against a device:0 cache misses it again.
		const entries = [{ user: '5511999', server: pnServer, device: undefined }]
		const result = applyDeviceListDelta([], entries, 'add')
		expect(result.find(d => d.user === '5511999')?.device).toBe(0)
	})

	it('remove: legacy cache with device: undefined is dropped by a normalized (device: 0) notification', () => {
		// The inverse direction: an older/legacy cache holds the primary as
		// `undefined` while the current notification carries the normalized `0`.
		const legacyCache = [
			{ user: '5511999', server: pnServer, device: undefined },
			{ user: '5511999', server: pnServer, device: 1 }
		]
		const entries = [{ user: '5511999', server: pnServer, device: 0 }]
		const result = applyDeviceListDelta(legacyCache, entries, 'remove')
		expect(result.map(d => d.device ?? 0)).toEqual([1]) // primary removed despite undefined-vs-0
	})

	it('remove: drops a non-primary device normally', () => {
		const entries = [{ user: '5511999', server: pnServer, device: 1 }]
		expect(applyDeviceListDelta(cache, entries, 'remove').map(d => d.device ?? 0)).toEqual([0])
	})

	it('add: appends a brand-new device without touching existing ones', () => {
		const entries = [{ user: '5511999', server: pnServer, device: 2 }]
		expect(
			applyDeviceListDelta(cache, entries, 'add')
				.map(d => d.device ?? 0)
				.sort()
		).toEqual([0, 1, 2])
	})

	it('does not leak transient `jid` and preserves domainType', () => {
		// The notification parser yields `DecodedDevice` (with a `jid`); the cache
		// persists FullJid. Only `jid` is transient; domainType is part of the
		// typed-first/JSON-mirror value-identical contract and must survive.
		const entries: DeviceListDeltaEntry[] = [
			{
				jid: '5511999_129:2@hosted.lid',
				user: '5511999',
				server: 'hosted.lid',
				domainType: 129,
				device: 2
			}
		]
		const result = applyDeviceListDelta(cache, entries, 'add')
		expect(result.every(d => !('jid' in d))).toBe(true)
		expect(result.find(d => d.device === 2)).toMatchObject({ server: 'hosted.lid', domainType: 129 })
	})

	it('canonicalizes preserved (kept) legacy entries to device: 0, not undefined', () => {
		// A legacy cache entry with `device: undefined` that is NOT affected by the
		// delta must still come out canonical (device: 0), not pass through as-is.
		const legacyCache = [
			{ user: '5511999', server: 'hosted.lid' as const, domainType: 129, device: undefined }, // legacy primary
			{ user: '5511999', server: pnServer, device: 1 }
		]
		const entries = [{ user: '5511999', server: pnServer, device: 1 }] // touches only device 1
		const result = applyDeviceListDelta(legacyCache, entries, 'remove')
		expect(result.find(d => d.device === 0)).toMatchObject({ server: 'hosted.lid', domainType: 129 })
	})
})
