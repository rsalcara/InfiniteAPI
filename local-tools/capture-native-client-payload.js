'use strict'

/*
 * Local, read-only forensic hook. Captures only the official ClientPayload
 * protobuf (runtime class X.1Sm) before Noise encryption. It changes no return
 * values and is intentionally not part of the library build.
 */

function installHook() {
	if (typeof Java === 'undefined' || !Java.available) {
		setTimeout(installHook, 100)
		return
	}

	Java.perform(function () {
		const TAG = '[NATIVE-CLIENT-PAYLOAD]'
		const AbstractMessageLite = Java.use('com.google.protobuf.AbstractMessageLite')
		const toByteArray = AbstractMessageLite.toByteArray.overload()
		let captures = 0

		function hex(bytes) {
			let output = ''
			for (let i = 0; i < bytes.length; i++) {
				const value = bytes[i] & 0xff
				output += ('0' + value.toString(16)).slice(-2)
			}
			return output
		}

		toByteArray.implementation = function () {
			const result = toByteArray.call(this)
			const className = String(this.getClass().getName())

			if (className === 'X.1Sm') {
				captures++
				const bytes = Java.array('byte', result)
				console.log(
					TAG +
						' ' +
						JSON.stringify({
							capture: captures,
							className: className,
							length: result.length,
							hex: hex(bytes)
						})
				)
			}

			return result
		}

		console.log(TAG + ' ready; waiting for X.1Sm serialization')
	})
}

// The app is spawned suspended by the Python runner. Deferring installation
// lets script.load() return so the runner can resume Android before Java.perform.
setTimeout(installHook, 500)
