import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { AnyMessageContent, MessageContentGenerationOptions } from '../../Types'
import { generateOtpMessage, generateWAMessageContent } from '../../Utils/messages'

const options = {
	upload: jest.fn()
} as unknown as MessageContentGenerationOptions

const protoRoundTrip = (message: any) =>
	proto.Message.decode(proto.Message.encode(proto.Message.create(message)).finish())

describe('official native-flow OTP envelope', () => {
	it('encodes the official otp button and params without changing the visible body', async () => {
		const content = await generateWAMessageContent(
			{
				text: '123456 is your verification code',
				footer: 'Expires in 10 minutes',
				otp: {
					otpType: 'ONE_TAP',
					ctaDisplayName: 'Example App',
					codeExpirationMinutes: 10,
					supportedApps: [{ packageName: 'com.example.app', signatureHash: 'AB:CD:EF' }]
				}
			} as AnyMessageContent,
			options
		)
		const decoded = protoRoundTrip(content)
		const button = decoded.interactiveMessage?.nativeFlowMessage?.buttons?.[0]
		const params = JSON.parse(button?.buttonParamsJson || '{}')

		expect(decoded.interactiveMessage?.body?.text).toBe('123456 is your verification code')
		expect(decoded.interactiveMessage?.footer?.text).toBe('Expires in 10 minutes')
		expect(decoded.interactiveMessage?.nativeFlowMessage?.messageVersion).toBe(1)
		expect(button?.name).toBe('otp')
		expect(params).toEqual({
			otp_type: 'ONE_TAP',
			cta_display_name: 'Example App',
			code_expiration_minutes: 10,
			supported_apps: [{ package_name: 'com.example.app', signature_hash: 'AB:CD:EF' }]
		})
	})

	it('defaults to the official one-tap mode and ten-minute expiration', async () => {
		const content = generateOtpMessage({
			text: '654321 is your code',
			otp: {
				ctaDisplayName: 'Example App',
				supportedApps: [{ packageName: 'com.example.app', signatureHash: 'AB:CD:EF' }]
			}
		})
		const params = JSON.parse(content.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.buttonParamsJson || '{}')

		expect(content.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name).toBe('otp')
		expect(params.otp_type).toBe('ONE_TAP')
		expect(params.code_expiration_minutes).toBeUndefined()
	})

	it('allows COPY_CODE without inventing a supported Android app', () => {
		const content = generateOtpMessage({
			text: '654321 is your code',
			otp: {
				otpType: 'COPY_CODE',
				ctaDisplayName: 'Example App'
			}
		})
		const params = JSON.parse(content.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.buttonParamsJson || '{}')

		expect(content.interactiveMessage?.nativeFlowMessage?.buttons?.[0]?.name).toBe('otp')
		expect(params).toEqual({
			otp_type: 'COPY_CODE',
			cta_display_name: 'Example App'
		})
	})

	it.each([
		[
			'unsupported otp type',
			{ otpType: 'SMS', ctaDisplayName: 'App', supportedApps: [validApp()] },
			'otp.otpType must be'
		],
		['empty display name', { ctaDisplayName: '', supportedApps: [validApp()] }, 'otp.ctaDisplayName is required'],
		[
			'invalid expiration',
			{ ctaDisplayName: 'App', codeExpirationMinutes: 0, supportedApps: [validApp()] },
			'otp.codeExpirationMinutes must be'
		],
		['no supported apps', { ctaDisplayName: 'App', supportedApps: [] }, 'otp.supportedApps requires'],
		[
			'non-array supported apps',
			{ otpType: 'COPY_CODE', ctaDisplayName: 'App', supportedApps: 'nope' },
			'otp.supportedApps must be an array'
		],
		[
			'empty signature hash',
			{ ctaDisplayName: 'App', supportedApps: [{ packageName: 'com.example.app', signatureHash: '' }] },
			'otp.supportedApps[0].signatureHash is required'
		]
	] as const)('rejects %s before relay', async (_label, otp, expectedMessage) => {
		await expect(generateWAMessageContent({ text: '123456', otp } as AnyMessageContent, options)).rejects.toMatchObject(
			{
				message: expect.stringContaining(expectedMessage),
				output: { statusCode: 400 }
			}
		)
	})

	it('rejects an empty package name with the OTP field path', async () => {
		await expect(
			generateWAMessageContent(
				{
					text: '123456',
					otp: { ctaDisplayName: 'App', supportedApps: [{ packageName: '', signatureHash: 'AB:CD:EF' }] }
				} as AnyMessageContent,
				options
			)
		).rejects.toThrow(/^otp\.supportedApps\[0\]\.packageName is required and cannot be empty$/)
	})

	it('rejects an empty visible body', () => {
		expect(() =>
			generateOtpMessage({
				text: '',
				otp: { ctaDisplayName: 'App', supportedApps: [validApp()] }
			})
		).toThrow(/^text is required and cannot be empty$/)
	})

	it('rejects accidental nativeButtons instead of discarding them silently', async () => {
		await expect(
			generateWAMessageContent(
				{
					text: '123456',
					otp: { ctaDisplayName: 'App', supportedApps: [validApp()] },
					nativeButtons: [{ type: 'reply', id: 'unexpected', text: 'Unexpected' }]
				} as AnyMessageContent,
				options
			)
		).rejects.toThrow('otp cannot be combined with nativeButtons; choose one')
	})

	it.each([
		[
			'legacy buttons',
			{
				buttons: [{ buttonId: 'unexpected', buttonText: { displayText: 'Unexpected' }, type: 1 }]
			}
		],
		['image', { image: { url: 'https://example.test/unexpected.png' } }],
		['caption', { caption: 'Unexpected caption' }]
	] as const)('rejects accidental %s instead of discarding it silently', async (_label, extraContent) => {
		await expect(
			generateWAMessageContent(
				{
					text: '123456',
					otp: { otpType: 'COPY_CODE', ctaDisplayName: 'App' },
					...extraContent
				} as AnyMessageContent,
				options
			)
		).rejects.toMatchObject({
			message: expect.stringMatching(/^otp cannot be combined with .+; choose one$/),
			output: { statusCode: 400 }
		})
	})
})

function validApp() {
	return { packageName: 'com.example.app', signatureHash: 'AB:CD:EF' }
}

export {}
