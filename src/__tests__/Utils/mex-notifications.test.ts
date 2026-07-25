import { parseTextStatusSideSubNotification, parseTextStatusUpdateNotification } from '../../Utils/mex-notifications'

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

describe('full text-status MEX notification', () => {
	it('parses the captured TextStatusUpdateNotification payload', () => {
		const payload = Buffer.from(
			'{"data":{"xwa2_notify_text_status_on_update":{"emoji":null,"ephemeral_duration_sec":-1,"jid":"121139686838477@lid","last_update_time":"1784940679","text":" "}}}',
			'utf8'
		)

		expect(parseTextStatusUpdateNotification(payload)).toEqual({
			jid: '121139686838477@lid',
			lastUpdateTime: '1784940679',
			text: ' ',
			emoji: null,
			ephemeralDurationSec: -1
		})
	})

	it('rejects incomplete full text-status updates', () => {
		expect(
			parseTextStatusUpdateNotification('{"data":{"xwa2_notify_text_status_on_update":{"jid":"1@lid"}}}')
		).toBeNull()
	})
})
