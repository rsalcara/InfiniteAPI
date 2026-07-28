import { createPushNameAnnouncementTracker, getPushNameForAnnouncement } from '../../Socket/push-name-announcement'

describe('push-name announcement tracker', () => {
	it('deduplicates one socket and retries the same name after a failed send', () => {
		const tracker = createPushNameAnnouncementTracker()

		expect(tracker.needsAnnouncement('Renato')).toBe(true)
		tracker.markStarted('Renato')
		expect(tracker.needsAnnouncement('Renato')).toBe(false)

		tracker.markFailed('Renato')
		expect(tracker.needsAnnouncement('Renato')).toBe(true)
	})

	it('does not let an older failed send reopen a newer announcement', () => {
		const tracker = createPushNameAnnouncementTracker()

		tracker.markStarted('Old name')
		tracker.markStarted('Current name')
		tracker.markFailed('Old name')

		expect(tracker.needsAnnouncement('Current name')).toBe(false)
	})

	it('starts fresh for every replacement socket', () => {
		const oldSocket = createPushNameAnnouncementTracker()
		oldSocket.markStarted('Persisted name')

		const replacementSocket = createPushNameAnnouncementTracker()
		expect(replacementSocket.needsAnnouncement('Persisted name')).toBe(true)
	})

	it('retries a failed name after an unrelated partial credentials update', () => {
		const tracker = createPushNameAnnouncementTracker()
		const credentials = { me: { name: 'Renato' }, accountSyncCounter: 1 }

		tracker.markStarted('Renato')
		tracker.markFailed('Renato')
		Object.assign(credentials, { accountSyncCounter: 2 })

		const persistedName = getPushNameForAnnouncement(credentials)
		expect(persistedName).toBe('Renato')
		expect(tracker.needsAnnouncement(persistedName!)).toBe(true)
	})
})
