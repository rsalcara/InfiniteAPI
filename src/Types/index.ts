export * from './Auth'
export * from './GroupMetadata'
export * from './Chat'
export * from './Contact'
export * from './State'
export * from './Message'
export * from './Socket'
export * from './Events'
export * from './Product'
export * from './Call'
export * from './Signal'
export * from './Newsletter'
export * from './SessionCleanup'
// Re-exports added 2026-06-10 (audit P1-TYPE-01): these types appear in
// public signatures (addLabel, updateBussinesProfile, labels.* events,
// USyncQuery primitives) and the LabelAssociationType/LabelColor runtime
// enums are needed for chat label semantics — without these lines they
// could only be reached via deep-imports of `lib/Types/...`, which is
// fragile to any future `"exports"` map in package.json.
export * from './Label'
export * from './LabelAssociation'
export * from './Bussines'
export * from './USync'

import type { AuthenticationState } from './Auth'
import type { SocketConfig } from './Socket'

export type UserFacingSocketConfig = Partial<SocketConfig> & { auth: AuthenticationState }

export type BrowsersMap = {
	ubuntu(browser: string): [string, string, string]
	macOS(browser: string): [string, string, string]
	baileys(browser: string): [string, string, string]
	windows(browser: string): [string, string, string]
	appropriate(browser: string): [string, string, string]
	android(apiLevel: string): [string, string, string]
}

export enum DisconnectReason {
	connectionClosed = 428,
	connectionLost = 408,
	connectionReplaced = 440,
	timedOut = 408,
	loggedOut = 401,
	badSession = 500,
	restartRequired = 515,
	multideviceMismatch = 411,
	forbidden = 403,
	unavailableService = 503,
	sessionInvalidated = 516
}

export type WAInitResponse = {
	ref: string
	ttl: number
	status: 200
}

export type WABusinessHoursConfig = {
	day_of_week: string
	mode: string
	// Stored as zero-padded HHMM strings (e.g. "0900", "1830") because they
	// come straight off BinaryNode.attrs, which is `Record<string, string>`.
	// Earlier `number` typing was wrong: doing arithmetic on these values
	// silently concatenated strings ("540" + 30 = "54030") instead of
	// adding minutes. (audit P2-TYPE-01)
	open_time?: string
	close_time?: string
}

export type WABusinessProfile = {
	description: string
	email: string | undefined
	business_hours: {
		timezone?: string
		config?: WABusinessHoursConfig[]
		business_config?: WABusinessHoursConfig[]
	}
	website: string[]
	category?: string
	wid?: string
	address?: string
}

export type CurveKeyPair = { private: Uint8Array; public: Uint8Array }
