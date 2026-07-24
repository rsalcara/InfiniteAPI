export type TextStatusSideSubNotification = {
	hash: string
}

const decodeMexJson = (content: string | Uint8Array): unknown => {
	const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8')
	return JSON.parse(text)
}

/**
 * Parses the server-push emitted when a contact's text status/about changes.
 *
 * This is not a newsletter notification. The official Android client uses the
 * opaque hash to resolve affected side-list contacts before refreshing them.
 * InfiniteAPI exposes the hash so applications with an equivalent contact
 * index can perform that resolution without falsely treating the update as a
 * malformed newsletter payload.
 */
export const parseTextStatusSideSubNotification = (
	content: string | Uint8Array
): TextStatusSideSubNotification | null => {
	const parsed = decodeMexJson(content) as {
		data?: {
			xwa2_notify_text_status_on_update_side_sub?: {
				hash?: unknown
			}
		}
	}
	const hash = parsed?.data?.xwa2_notify_text_status_on_update_side_sub?.hash

	return typeof hash === 'string' && hash.length > 0 ? { hash } : null
}
