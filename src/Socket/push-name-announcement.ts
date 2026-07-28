/**
 * Socket-local delivery state for push-name presence announcements.
 *
 * Durable credentials remain authoritative. This tracker only prevents
 * duplicate presence stanzas on one socket and re-opens delivery after a
 * failed attempt. Creating a replacement socket creates a fresh tracker.
 */
export const getPushNameForAnnouncement = (credentials: { me?: { name?: string } }): string | undefined => {
	const name = credentials.me?.name
	return typeof name === 'string' ? name : undefined
}

export const createPushNameAnnouncementTracker = () => {
	let announcedName: string | undefined

	return {
		needsAnnouncement: (name: string): boolean => announcedName !== name,
		markStarted: (name: string): void => {
			announcedName = name
		},
		markFailed: (name: string): void => {
			if (announcedName === name) announcedName = undefined
		}
	}
}
