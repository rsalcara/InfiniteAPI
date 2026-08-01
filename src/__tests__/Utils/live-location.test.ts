import { Boom } from '@hapi/boom'
import {
	assertCanStartLiveLocation,
	LIVE_LOCATION_DURATIONS,
	LIVE_LOCATION_LINKED_DEVICE_UNSUPPORTED,
	validateLiveLocationSendOptions
} from '../../Utils/live-location'

describe('assertCanStartLiveLocation', () => {
	it.each([undefined, 0])('allows a primary-device identity (%s)', deviceId => {
		expect(() => assertCanStartLiveLocation(deviceId)).not.toThrow()
	})

	it('rejects a QR/pair-code companion before any relay is attempted', () => {
		try {
			assertCanStartLiveLocation(24)
			throw new Error('expected linked-device rejection')
		} catch (error) {
			expect(error).toBeInstanceOf(Boom)
			expect((error as Boom).output.statusCode).toBe(501)
			expect((error as Boom).data).toMatchObject({
				code: LIVE_LOCATION_LINKED_DEVICE_UNSUPPORTED,
				deviceId: 24,
				requiredDeviceId: 0
			})
		}
	})
})

describe('validateLiveLocationSendOptions', () => {
	it.each(LIVE_LOCATION_DURATIONS)('accepts the official %i-second duration', durationSecs => {
		expect(
			validateLiveLocationSendOptions({
				degreesLatitude: -23.55052,
				degreesLongitude: -46.633308,
				durationSecs
			})
		).toBe(durationSecs)
	})

	it('defaults to 15 minutes', () => {
		expect(validateLiveLocationSendOptions({ degreesLatitude: 0, degreesLongitude: 0 })).toBe(900)
	})

	it.each([
		['degreesLatitude', 91],
		['degreesLatitude', Number.NaN],
		['degreesLongitude', -181],
		['degreesLongitude', Number.POSITIVE_INFINITY]
	] as const)('rejects invalid %s', (field, value) => {
		expect(() =>
			validateLiveLocationSendOptions({
				degreesLatitude: field === 'degreesLatitude' ? value : 0,
				degreesLongitude: field === 'degreesLongitude' ? value : 0
			})
		).toThrow(field)
	})

	it('rejects unsupported duration and invalid optional telemetry', () => {
		const base = { degreesLatitude: 0, degreesLongitude: 0 }

		expect(() => validateLiveLocationSendOptions({ ...base, durationSecs: 1200 })).toThrow('duration')
		expect(() => validateLiveLocationSendOptions({ ...base, accuracyInMeters: -1 })).toThrow('accuracyInMeters')
		expect(() => validateLiveLocationSendOptions({ ...base, speedInMps: Number.NaN })).toThrow('speedInMps')
		expect(() => validateLiveLocationSendOptions({ ...base, degreesClockwiseFromMagneticNorth: 361 })).toThrow(
			'degreesClockwiseFromMagneticNorth'
		)
		expect(() => validateLiveLocationSendOptions({ ...base, sequenceNumber: -1 })).toThrow('sequenceNumber')
	})
})
