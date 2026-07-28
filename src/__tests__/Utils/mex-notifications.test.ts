import {
	buildMexDiagnostic,
	normalizeMexOperation,
	parseTextStatusSideSubNotification,
	parseTextStatusUpdateNotification
} from '../../Utils/mex-notifications'

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

describe('safe MEX diagnostics', () => {
	it('normalizes operation names like the Android dispatcher', () => {
		expect(normalizeMexOperation(' NotificationNewsletterUpdate ')).toBe('notificationnewsletterupdate')
		expect(normalizeMexOperation(undefined)).toBeNull()
	})

	it('records metadata and a hash without including payload or full sender JID', () => {
		const payload =
			'{"secret":"must-not-leak","data":{"phone":"5511999999999","message":"private content"}}'
		const diagnostic = buildMexDiagnostic({
			reason: 'unknown_op_name',
			opName: 'FutureOperation',
			from: '5511991426667:46@s.whatsapp.net',
			stanzaId: 'ABC123',
			timestamp: '1784940679',
			content: payload
		})

		expect(diagnostic).toMatchObject({
			event: 'mex_unknown_operation',
			reason: 'unknown_op_name',
			opName: 'FutureOperation',
			from: '6667:46@s.whatsapp.net',
			stanzaId: 'ABC123',
			contentType: 'string',
			payloadLength: Buffer.byteLength(payload),
			topLevelKeys: ['data', 'secret']
		})
		expect(diagnostic.payloadHash).toMatch(/^[0-9a-f]{16}$/)
		expect(JSON.stringify(diagnostic)).not.toContain('must-not-leak')
		expect(JSON.stringify(diagnostic)).not.toContain('private content')
		expect(JSON.stringify(diagnostic)).not.toContain('5511999999999')
	})
})
