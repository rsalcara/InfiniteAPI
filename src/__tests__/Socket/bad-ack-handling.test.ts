import { getMessageAckErrorPolicy } from '../../Utils/message-ack-error'

describe('message error ACK policy', () => {
	it('treats 463 as an account/reachout restriction without retry or token fetch', () => {
		expect(getMessageAckErrorPolicy('463')).toEqual({
			kind: 'message-account-restriction',
			retry: false,
			privacyTokenAction: 'none'
		})
	})

	it('treats 479 as smax-invalid diagnostics without retry or token fetch', () => {
		expect(getMessageAckErrorPolicy('479')).toEqual({
			kind: 'smax-invalid',
			retry: false,
			privacyTokenAction: 'none'
		})
	})

	it('does not invent retries for other server errors', () => {
		expect(getMessageAckErrorPolicy('421')).toEqual({
			kind: 'other',
			retry: false,
			privacyTokenAction: 'none'
		})
	})
})
