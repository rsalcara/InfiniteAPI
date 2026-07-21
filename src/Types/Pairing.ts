export type PairingCodeProfile = 'smb_android' | 'web'

export type SmbAndroidVersion = [number, number, number, number?]

export type SmbAndroidDeviceMetadata = {
	catalogId: string
	commercialName: string
	osVersion: string
	manufacturer: string
	device: string
	osBuildNumber: string
	verified: true
}

export type SmbAndroidDeviceIdentity = {
	phoneId: string
	deviceExpId: string
	/** Immutable snapshot selected when this SMB_ANDROID session is created. */
	deviceProfile?: SmbAndroidDeviceMetadata
}

/** Fields actually observed in the server's pair-success response. */
export type PairSuccessMetadata = {
	platform?: string
	deviceJid: string
	deviceLid?: string
	businessName?: string
	accountType?: number
	advDeviceType?: number
	keyIndex?: number
}
