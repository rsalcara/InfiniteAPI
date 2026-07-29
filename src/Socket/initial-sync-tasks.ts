/**
 * Waits for both sides of the initial sync window before deciding whether the
 * outer event buffer can be released. Promise.all would reject immediately and
 * skip the release path while the other task was still writing history/LID data.
 */
export const settleInitialSyncTasks = async (
	tasks: readonly Promise<unknown>[],
	shouldReleaseOnSuccess: () => boolean,
	releaseBuffer: (failed: boolean) => void,
	prepareFailureRelease?: () => void
): Promise<void> => {
	const results = await Promise.allSettled(tasks)
	const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')

	if (failure) {
		prepareFailureRelease?.()
	}

	if (failure || shouldReleaseOnSuccess()) {
		releaseBuffer(Boolean(failure))
	}

	if (failure) {
		throw failure.reason
	}
}
