import { parseTextStatusSideSubNotification } from '../../Utils/mex-notifications'

describe('text-status side-sub MEX notification', () => {
	it('parses the captured binary payload without treating it as newsletter data', () => {
		const payload = Buffer.from('{"data":{"xwa2_notify_text_status_on_update_side_sub":{"hash":"mTPs"}}}', 'utf8')

		expect(parseTextStatusSideSubNotification(payload)).toEqual({ hash: 'mTPs' })
	})

	it('rejects an absent or empty hash', () => {
		expect(parseTextStatusSideSubNotification('{"data":{}}')).toBeNull()
		expect(
			parseTextStatusSideSubNotification('{"data":{"xwa2_notify_text_status_on_update_side_sub":{"hash":""}}}')
		).toBeNull()
	})
})
