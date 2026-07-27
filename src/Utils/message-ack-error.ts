export type MessageAckErrorPolicy = {
	kind: 'message-account-restriction' | 'smax-invalid' | 'other'
	retry: false
	privacyTokenAction: 'none'
}

/**
 * Error ACK policy shared by the production handler and regression tests.
 * Neither 463 nor 479 is a request to fetch a peer privacy token: the only
 * privacy IQ available to companions is `type=set` (our-token issuance).
 */
export const getMessageAckErrorPolicy = (error: string): MessageAckErrorPolicy => ({
	kind: error === '463' ? 'message-account-restriction' : error === '479' ? 'smax-invalid' : 'other',
	retry: false,
	privacyTokenAction: 'none'
})
