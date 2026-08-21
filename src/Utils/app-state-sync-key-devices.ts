import type { AppStateSyncDevice } from '../Types'
import type { FullJid } from '../WABinary'
import { jidDecode, WAJIDDomains } from '../WABinary'

type DiscoverOwnDevicesOptions = {
	fetchDevices: () => Promise<FullJid[]>
	readCachedDevices: () => Promise<FullJid[] | undefined>
	writeCachedDevices: (devices: FullJid[]) => Promise<void>
	onFetchError?: (error: unknown) => void
	onCacheWriteError?: (error: unknown) => void
}

type ReadTypedOwnDevicesOptions = {
	read: () => Promise<unknown>
	ownJid: string
	ownLid?: string
	onReadError?: (error: unknown) => void
}

/** Keeps device 0 explicit; jidEncode intentionally collapses `:0`. */
export const encodeExplicitDeviceJid = ({ user, server, device }: FullJid): string => {
	if (!user || device === undefined || !Number.isInteger(device) || device < 0) {
		throw new Error('invalid app-state peer device')
	}

	return `${user}:${device}@${server}`
}

/**
 * Selects other devices belonging to this account, deduped by device number.
 * PN rows win over equivalent LID rows because peer messages use the account
 * device registry, while LID is only an alias for validating the sender.
 */
export const selectOtherOwnDevices = (devices: FullJid[], ownJid: string, ownLid?: string): FullJid[] => {
	const own = jidDecode(ownJid)
	const lid = jidDecode(ownLid)
	if (!own?.user) throw new Error('missing own device identity')

	const ownDevice = own.device ?? 0
	const ordered = [...devices].sort((left, right) => {
		const leftIsPn = left.user === own.user ? 0 : 1
		const rightIsPn = right.user === own.user ? 0 : 1
		return leftIsPn - rightIsPn || (left.device ?? 0) - (right.device ?? 0)
	})
	const byDevice = new Map<number, FullJid>()

	for (const device of ordered) {
		const canonical = normalizeOwnAccountDevice(device, own, lid)
		if (!canonical || canonical.device === ownDevice) continue
		const deviceId = canonical.device!
		if (!byDevice.has(deviceId)) byDevice.set(deviceId, canonical)
	}

	return [...byDevice.values()]
}

const normalizeOwnAccountDevice = (device: FullJid, own: FullJid, lid: FullJid | undefined): FullJid | undefined => {
	if (device.device === undefined || !Number.isInteger(device.device) || device.device < 0) return undefined

	if (device.user === own.user && ['s.whatsapp.net', 'c.us', 'hosted'].includes(device.server)) {
		const server = device.server === 'c.us' ? ('s.whatsapp.net' as const) : device.server
		const domainType =
			device.domainType ??
			(device.server === 'c.us' ? WAJIDDomains.WHATSAPP : server === 'hosted' ? WAJIDDomains.HOSTED : undefined)
		return {
			...device,
			server,
			...(domainType === undefined ? {} : { domainType })
		}
	}

	if (lid?.user && device.user === lid.user && (device.server === 'lid' || device.server === 'hosted.lid')) {
		const hosted = device.server === 'hosted.lid'
		return {
			...device,
			user: own.user,
			server: hosted ? 'hosted' : 's.whatsapp.net',
			domainType: hosted ? WAJIDDomains.HOSTED : WAJIDDomains.WHATSAPP
		}
	}

	return undefined
}

/** Returns undefined only when the typed cache is absent or unreadable; an empty array is authoritative. */
export const readTypedOwnAppStateDevices = async ({
	read,
	ownJid,
	ownLid,
	onReadError
}: ReadTypedOwnDevicesOptions): Promise<FullJid[] | undefined> => {
	let stored: unknown
	try {
		stored = await read()
	} catch (error) {
		onReadError?.(error)
		return undefined
	}

	if (!Array.isArray(stored)) return undefined
	const decoded = stored.flatMap(value => {
		if (!value || typeof value !== 'object') return []
		const device = value as Partial<AppStateSyncDevice>
		if (!device.user || !device.server || !Number.isInteger(device.device) || Number(device.device) < 0) return []
		const server = device.server === 'c.us' ? 's.whatsapp.net' : device.server
		const jid = jidDecode(`${device.user}:${device.device}@${server}`)
		if (!jid?.user) return []
		return [{ ...jid, domainType: device.domainType ?? jid.domainType, device: Number(device.device) }]
	})
	if (decoded.length === 0 && stored.length > 0) return undefined
	const own = jidDecode(ownJid)
	const lid = jidDecode(ownLid)
	if (!own?.user) throw new Error('missing own device identity')
	const valid = decoded.filter(device => normalizeOwnAccountDevice(device, own, lid))
	if (valid.length === 0 && stored.length > 0) return undefined
	return selectOtherOwnDevices(valid, ownJid, ownLid)
}

/** Fresh USync is authoritative; durable cache is used only when it fails. */
export const discoverOwnAppStateDevices = async ({
	fetchDevices,
	readCachedDevices,
	writeCachedDevices,
	onFetchError,
	onCacheWriteError
}: DiscoverOwnDevicesOptions): Promise<FullJid[]> => {
	let devices: FullJid[]
	try {
		devices = await fetchDevices()
	} catch (error) {
		onFetchError?.(error)
		let cached: FullJid[] | undefined
		try {
			cached = await readCachedDevices()
		} catch {
			// Preserve the authoritative USync failure. The cache is only a
			// fallback and must not hide the reason fresh discovery failed.
			throw error
		}

		if (cached === undefined) throw error
		return cached
	}

	try {
		await writeCachedDevices(devices)
	} catch (error) {
		onCacheWriteError?.(error)
	}

	return devices
}
