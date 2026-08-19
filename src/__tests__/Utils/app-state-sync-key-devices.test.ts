import { jest } from '@jest/globals'
import {
	discoverOwnAppStateDevices,
	encodeExplicitDeviceJid,
	readTypedOwnAppStateDevices,
	selectOtherOwnDevices
} from '../../Utils/app-state-sync-key-devices'

describe('app-state sync own-device discovery', () => {
	const ownJid = '5511999999999:2@s.whatsapp.net'
	const ownLid = '123456789012345:2@lid'

	it('excludes this client, retains primary device 0 and dedupes PN/LID aliases', () => {
		const selected = selectOtherOwnDevices(
			[
				{ user: '5511999999999', server: 's.whatsapp.net', device: 2 },
				{ user: '123456789012345', server: 'lid', device: 2 },
				{ user: '123456789012345', server: 'lid', device: 0 },
				{ user: '5511999999999', server: 's.whatsapp.net', device: 0 },
				{ user: '5511999999999', server: 's.whatsapp.net', device: 4 },
				{ user: '5500000000000', server: 's.whatsapp.net', device: 3 }
			],
			ownJid,
			ownLid
		)

		expect(selected).toEqual([
			{ user: '5511999999999', server: 's.whatsapp.net', device: 0 },
			{ user: '5511999999999', server: 's.whatsapp.net', device: 4 }
		])
		expect(selected.map(encodeExplicitDeviceJid)).toEqual([
			'5511999999999:0@s.whatsapp.net',
			'5511999999999:4@s.whatsapp.net'
		])
	})

	it('canonicalizes LID-only USync rows to the PN device registry and preserves hosted routing', () => {
		expect(
			selectOtherOwnDevices(
				[
					{ user: '123456789012345', server: 'lid', device: 4 },
					{ user: '123456789012345', server: 'hosted.lid', device: 5 }
				],
				ownJid,
				ownLid
			)
		).toEqual([
			{ user: '5511999999999', server: 's.whatsapp.net', device: 4, domainType: 0 },
			{ user: '5511999999999', server: 'hosted', device: 5, domainType: 128 }
		])
	})

	it('uses and persists a successful empty USync result instead of stale cache', async () => {
		const writeCachedDevices = jest.fn(async () => undefined)
		const readCachedDevices = jest.fn(async () => [
			{ user: '5511999999999', server: 's.whatsapp.net' as const, device: 1 }
		])

		await expect(
			discoverOwnAppStateDevices({
				fetchDevices: async () => [],
				readCachedDevices,
				writeCachedDevices
			})
		).resolves.toEqual([])
		expect(writeCachedDevices).toHaveBeenCalledWith([])
		expect(readCachedDevices).not.toHaveBeenCalled()
	})

	it('treats a persisted empty typed device list as authoritative', async () => {
		await expect(readTypedOwnAppStateDevices({ read: async () => [], ownJid, ownLid })).resolves.toEqual([])
	})

	it('allows legacy device fallbacks when the typed device cache cannot be read', async () => {
		const onReadError = jest.fn()
		await expect(
			readTypedOwnAppStateDevices({
				read: async () => {
					throw new Error('typed cache unavailable')
				},
				ownJid,
				ownLid,
				onReadError
			})
		).resolves.toBeUndefined()
		expect(onReadError).toHaveBeenCalledWith(expect.objectContaining({ message: 'typed cache unavailable' }))
	})

	it('falls back to the durable device list only when USync fails', async () => {
		const cached = [{ user: '5511999999999', server: 's.whatsapp.net' as const, device: 0 }]
		const writeCachedDevices = jest.fn(async () => undefined)
		const onFetchError = jest.fn()

		await expect(
			discoverOwnAppStateDevices({
				fetchDevices: async () => {
					throw new Error('USync unavailable')
				},
				readCachedDevices: async () => cached,
				writeCachedDevices,
				onFetchError
			})
		).resolves.toEqual(cached)
		expect(writeCachedDevices).not.toHaveBeenCalled()
		expect(onFetchError).toHaveBeenCalledWith(expect.objectContaining({ message: 'USync unavailable' }))
	})

	it('propagates a USync failure when no durable device list exists', async () => {
		await expect(
			discoverOwnAppStateDevices({
				fetchDevices: async () => {
					throw new Error('USync unavailable')
				},
				readCachedDevices: async () => undefined,
				writeCachedDevices: async () => undefined
			})
		).rejects.toThrow('USync unavailable')
	})

	it('preserves the USync error when reading the durable fallback also fails', async () => {
		await expect(
			discoverOwnAppStateDevices({
				fetchDevices: async () => {
					throw new Error('USync root cause')
				},
				readCachedDevices: async () => {
					throw new Error('cache secondary failure')
				},
				writeCachedDevices: async () => undefined
			})
		).rejects.toThrow('USync root cause')
	})

	it('keeps the fresh result when only durable persistence fails', async () => {
		const fresh = [{ user: '5511999999999', server: 's.whatsapp.net' as const, device: 0 }]
		const onCacheWriteError = jest.fn()

		await expect(
			discoverOwnAppStateDevices({
				fetchDevices: async () => fresh,
				readCachedDevices: async () => undefined,
				writeCachedDevices: async () => {
					throw new Error('disk unavailable')
				},
				onCacheWriteError
			})
		).resolves.toEqual(fresh)
		expect(onCacheWriteError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk unavailable' }))
	})
})
