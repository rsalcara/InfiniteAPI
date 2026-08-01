import { describe, expect, it } from '@jest/globals'
import { normalizeMessageMetricType } from '../../Utils/prometheus-metrics'

describe('message metric type cardinality', () => {
	it.each(['text', 'image', 'voice', 'interactive_response', 'view_once_audio', 'unknown'])(
		'preserves the supported %s label',
		type => {
			expect(normalizeMessageMetricType(type)).toBe(type)
		}
	)

	it('maps protobuf fallback field names to one bounded label', () => {
		expect(normalizeMessageMetricType('scheduled_call_creation')).toBe('other')
		expect(normalizeMessageMetricType('future_server_message_123')).toBe('other')
	})
})
