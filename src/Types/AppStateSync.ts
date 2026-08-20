import type { JidServer } from '../WABinary'

export const APP_STATE_SYNC_KEY_SHARE_MESSAGE_TYPE = 38 as const
export const APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE = 39 as const

export type AppStateSyncPeerMessageType =
	| typeof APP_STATE_SYNC_KEY_SHARE_MESSAGE_TYPE
	| typeof APP_STATE_SYNC_KEY_REQUEST_MESSAGE_TYPE

export type AppStateSyncPeerMessageInput = {
	messageType: AppStateSyncPeerMessageType
	remoteJid: string
	targetDeviceJid: string
	messageId: string
	timestamp: number
	data: string
}

export type StoredAppStateSyncPeerMessage = AppStateSyncPeerMessageInput & {
	id: string
	acked: boolean
}

export type AppStateSyncDevice = {
	user: string
	server: JidServer
	device: number
	domainType?: number
}

export type AppStateSyncKeyImportResult = {
	missingKeys: number
	peerMessages: number
}

export type AppStateSyncKeyStoreSnapshot = {
	missingKeys: Array<{ keyId: string; collectionName: string }>
	peerMessages: StoredAppStateSyncPeerMessage[]
}

/** Durable missing-key and peer-message capability supplied by built-in auth adapters. */
export interface AppStateSyncKeyStore {
	recordMissingKey(keyId: string, collectionName: string): Promise<void>
	listMissingKeyIds(): Promise<string[]>
	listMissingCollections(): Promise<string[]>
	resolveKeys(keyIds: string[]): Promise<string[]>
	enqueuePeerMessage(input: AppStateSyncPeerMessageInput): Promise<StoredAppStateSyncPeerMessage>
	listPeerMessages(messageType?: AppStateSyncPeerMessageType): Promise<StoredAppStateSyncPeerMessage[]>
	listUnackedPeerMessages(): Promise<StoredAppStateSyncPeerMessage[]>
	markPeerMessageAcked(id: string): Promise<void>
	deletePeerMessages(ids: string[]): Promise<void>
	exportState(): Promise<AppStateSyncKeyStoreSnapshot>
	importState(snapshot: AppStateSyncKeyStoreSnapshot): Promise<AppStateSyncKeyImportResult>
	clear(): Promise<void>
}
