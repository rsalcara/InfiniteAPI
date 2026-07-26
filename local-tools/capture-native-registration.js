'use strict'

/*
 * Local, read-only forensic hook for a fresh WhatsApp Business Android
 * companion registration. It records:
 *
 * - ClientPayload protobuf bytes before Noise encryption;
 * - the pair-success/pair-device-sign node shape;
 * - exact key_attestation, gpia and client-app-id content.
 *
 * No return value or application field is changed.
 */

function installHook() {
	if (typeof Java === 'undefined' || !Java.available) {
		setTimeout(installHook, 100)
		return
	}

	Java.perform(function () {
		const TAG = '[NATIVE-REGISTRATION]'

		function hex(bytes) {
			if (bytes === null || bytes === undefined) {
				return null
			}

			let output = ''
			for (let index = 0; index < bytes.length; index++) {
				const value = bytes[index] & 0xff
				output += ('0' + value.toString(16)).slice(-2)
			}

			return output
		}

		const AbstractMessageLite = Java.use('com.google.protobuf.AbstractMessageLite')
		const toByteArray = AbstractMessageLite.toByteArray.overload()
		let payloadCaptures = 0

		toByteArray.implementation = function () {
			const result = toByteArray.call(this)
			const className = String(this.getClass().getName())

			if (className === 'X.1Sm') {
				payloadCaptures++
				const bytes = Java.array('byte', result)
				send({
					kind: 'client-payload',
					capture: payloadCaptures,
					className,
					length: result.length,
					hex: hex(bytes)
				})
			}

			return result
		}

		const Node = Java.use('X.0bC')
		const nodeConstructor = Node.$init.overload('java.lang.String', '[B', '[LX.0bA;', '[LX.0bC;')
		const relevantTags = {
			'pair-device': true,
			'pair-success': true,
			'pair-device-sign': true,
			'device-identity': true,
			key_attestation: true,
			gpia: true,
			'client-app-id': true
		}

		nodeConstructor.implementation = function (tag, data, attributes, children) {
			nodeConstructor.call(this, tag, data, attributes, children)

			const normalizedTag = String(tag)
			if (relevantTags[normalizedTag]) {
				const hasData = data !== null && data !== undefined && data.length !== undefined
				const hasAttributes = attributes !== null && attributes !== undefined && attributes.length !== undefined
				const hasChildren = children !== null && children !== undefined && children.length !== undefined
				send({
					kind: 'binary-node',
					tag: normalizedTag,
					contentLength: hasData ? data.length : null,
					contentHex: hasData ? hex(data) : null,
					attributeCount: hasAttributes ? attributes.length : 0,
					childCount: hasChildren ? children.length : 0
				})
			}
		}

		send({
			kind: 'ready',
			message: 'ClientPayload and registration-node hooks installed'
		})
	})
}

setTimeout(installHook, 500)
