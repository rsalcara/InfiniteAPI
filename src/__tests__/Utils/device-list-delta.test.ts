import { applyDeviceListDelta } from '../../Utils/device-list-delta'

// The #621 regression: the notification parser yields `device: undefined` for
// the primary (a `0` suffix is dropped by jidDecode), but the cache stores it as
// `device: 0`. The delta must normalize both sides or it misses the primary.
describe('applyDeviceListDelta (#621 device-0 normalization)', () => {
	const cache = [
		{ user: '5511999', server: 's.whatsapp.net', device: 0 }, // primary (stored as 0)
		{ user: '5511999', server: 's.whatsapp.net', device: 1 }
	]

	it('remove: drops the primary even when the notification carries device: undefined', () => {
		const entries = [{ user: '5511999', server: 's.whatsapp.net', device: undefined }] // primary, un-normalized
		const result = applyDeviceListDelta(cache, entries, 'remove')
		expect(result.map(d => d.device ?? 0)).toEqual([1]) // primary removed, device 1 kept
	})

	it('add: does NOT duplicate the primary when re-added as device: undefined', () => {
		const entries = [{ user: '5511999', server: 's.whatsapp.net', device: undefined }]
		const result = applyDeviceListDelta(cache, entries, 'add')
		// exactly one primary entry (the fresh one), plus the untouched device 1
		expect(result.filter(d => (d.device ?? 0) === 0)).toHaveLength(1)
		expect(result.map(d => d.device ?? 0).sort()).toEqual([0, 1])
	})

	it('remove: drops a non-primary device normally', () => {
		const entries = [{ user: '5511999', server: 's.whatsapp.net', device: 1 }]
		expect(applyDeviceListDelta(cache, entries, 'remove').map(d => d.device ?? 0)).toEqual([0])
	})

	it('add: appends a brand-new device without touching existing ones', () => {
		const entries = [{ user: '5511999', server: 's.whatsapp.net', device: 2 }]
		expect(
			applyDeviceListDelta(cache, entries, 'add')
				.map(d => d.device ?? 0)
				.sort()
		).toEqual([0, 1, 2])
	})
})
