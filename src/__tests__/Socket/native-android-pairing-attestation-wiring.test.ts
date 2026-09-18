import { readFileSync } from 'fs'
import { join } from 'path'

describe('native_android pairing attestation socket wiring', () => {
	it('keeps the legacy client-app-id gate wired to the native transport appVersion', () => {
		const source = readFileSync(join(process.cwd(), 'src/Socket/socket.ts'), 'utf8')

		expect(source).toMatch(
			/appendNativeAndroidPairingAttestation\(\s+reply,\s+attestation,\s+appResolution\.identity\.clientAppId,\s+transportSession\.nativeAndroid!\.appVersion\s+\)/
		)
		expect(source).not.toMatch(
			/appendNativeAndroidPairingAttestation\(\s+reply,\s+attestation,\s+appResolution\.identity\.clientAppId\s+\)/
		)
	})
})
