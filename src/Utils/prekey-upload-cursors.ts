export type PrekeyCursorSnapshot = {
	firstUnuploadedPreKeyId: number
	nextPreKeyId: number
}

export type TypedPrekeyProgress = {
	firstUnsentId: number | null
	nextGeneratedId: number | null
	unsentCount: number
}

/**
 * Reconciles crash-stale creds cursors with the authoritative typed prekey table.
 * It can rewind to a legacy orphan or advance past an ACK/direct-distribution
 * state that committed before the corresponding creds update reached creds.db.
 */
export const reconcilePrekeyCursors = (
	creds: PrekeyCursorSnapshot,
	typed: TypedPrekeyProgress
): Partial<PrekeyCursorSnapshot> => {
	const update: Partial<PrekeyCursorSnapshot> = {}
	if (typed.nextGeneratedId !== null && typed.nextGeneratedId > creds.nextPreKeyId) {
		update.nextPreKeyId = typed.nextGeneratedId
	}

	let firstUnuploaded: number | undefined
	if (typed.firstUnsentId !== null) {
		firstUnuploaded = typed.firstUnsentId
	} else if (
		typed.unsentCount === 0 &&
		typed.nextGeneratedId !== null &&
		typed.nextGeneratedId > creds.firstUnuploadedPreKeyId
	) {
		firstUnuploaded = typed.nextGeneratedId
	}

	if (firstUnuploaded !== undefined && firstUnuploaded !== creds.firstUnuploadedPreKeyId) {
		update.firstUnuploadedPreKeyId = firstUnuploaded
	}

	return update
}
