import { Boom } from '@hapi/boom'

export const LIVE_LOCATION_DURATIONS = [900, 3600, 28800] as const

export interface LiveLocationSendOptions {
	degreesLatitude: number
	degreesLongitude: number
	/** Share window in seconds. WhatsApp currently offers 15 minutes, 1 hour, or 8 hours. */
	durationSecs?: number
	/** Android UI label: "Add comment". Stored in LiveLocationMessage.caption. */
	comment?: string
	/** @deprecated Use `comment`; retained for API compatibility. */
	caption?: string
	accuracyInMeters?: number
	speedInMps?: number
	degreesClockwiseFromMagneticNorth?: number
	sequenceNumber?: number
	jpegThumbnail?: Uint8Array
}

export const LIVE_LOCATION_LINKED_DEVICE_UNSUPPORTED = 'LIVE_LOCATION_LINKED_DEVICE_UNSUPPORTED'

/**
 * The official Android client allows a share to start only when its own
 * registration device id is zero (the primary phone). QR/pair-code sessions
 * have a positive device id even when they advertise an Android transport.
 */
export const assertCanStartLiveLocation = (deviceId: number | undefined): void => {
	if (deviceId !== undefined && deviceId > 0) {
		throw new Boom('Live location cannot be started by a linked device; use the primary phone', {
			statusCode: 501,
			data: {
				code: LIVE_LOCATION_LINKED_DEVICE_UNSUPPORTED,
				deviceId,
				requiredDeviceId: 0
			}
		})
	}
}

const assertFiniteRange = (value: number, field: string, minimum: number, maximum: number) => {
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Boom(`${field} must be a finite number between ${minimum} and ${maximum}`, {
			statusCode: 400,
			data: { field, value, minimum, maximum }
		})
	}
}

const assertOptionalNonNegative = (value: number | undefined, field: string) => {
	if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
		throw new Boom(`${field} must be a finite non-negative number`, {
			statusCode: 400,
			data: { field, value }
		})
	}
}

/** Validates caller-controlled values before encoding or persisting a live-location share. */
export const validateLiveLocationSendOptions = (location: LiveLocationSendOptions): number => {
	assertFiniteRange(location.degreesLatitude, 'degreesLatitude', -90, 90)
	assertFiniteRange(location.degreesLongitude, 'degreesLongitude', -180, 180)
	assertOptionalNonNegative(location.accuracyInMeters, 'accuracyInMeters')
	assertOptionalNonNegative(location.speedInMps, 'speedInMps')

	if (location.degreesClockwiseFromMagneticNorth !== undefined) {
		assertFiniteRange(location.degreesClockwiseFromMagneticNorth, 'degreesClockwiseFromMagneticNorth', 0, 360)
	}

	if (
		location.sequenceNumber !== undefined &&
		(!Number.isSafeInteger(location.sequenceNumber) || location.sequenceNumber < 0)
	) {
		throw new Boom('sequenceNumber must be a non-negative safe integer', {
			statusCode: 400,
			data: { field: 'sequenceNumber', value: location.sequenceNumber }
		})
	}

	const durationSecs = location.durationSecs ?? LIVE_LOCATION_DURATIONS[0]
	if (!LIVE_LOCATION_DURATIONS.includes(durationSecs as (typeof LIVE_LOCATION_DURATIONS)[number])) {
		throw new Boom('Live-location duration must be 900, 3600, or 28800 seconds', {
			statusCode: 400,
			data: { durationSecs, allowed: LIVE_LOCATION_DURATIONS }
		})
	}

	return durationSecs
}
