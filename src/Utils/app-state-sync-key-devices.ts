import type { FullJid } from '../WABinary'
import { jidDecode } from '../WABinary'

type DiscoverOwnDevicesOptions = {
	fetchDevices: () => Promise<FullJid[]>
	readCachedDevices: () => Promise<FullJid[] | undefined>
	writeCachedDevices: (devices: FullJid[]) => Promise<void>
	onFetchError?: (error: unknown) => void
	onCacheWriteError?: (error: unknown) => void
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
	const belongsToAccount = (device: FullJid): boolean =>
		device.user === own.user || Boolean(lid?.user && device.user === lid.user)
	const ordered = [...devices].sort((left, right) => {
		const leftIsPn = left.user === own.user ? 0 : 1
		const rightIsPn = right.user === own.user ? 0 : 1
		return leftIsPn - rightIsPn || (left.device ?? 0) - (right.device ?? 0)
	})
	const byDevice = new Map<number, FullJid>()

	for (const device of ordered) {
		if (!belongsToAccount(device) || device.device === undefined || device.device === ownDevice) continue
		if (!byDevice.has(device.device)) byDevice.set(device.device, device)
	}

	return [...byDevice.values()]
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
		const cached = await readCachedDevices()
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
