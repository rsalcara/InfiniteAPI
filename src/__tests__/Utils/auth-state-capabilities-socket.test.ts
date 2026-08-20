import { jest } from '@jest/globals'
import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import makeWASocket from '../../Socket'
import type { AuthenticationState } from '../../Types'
import type { ILogger } from '../../Utils/logger'
import { makeSession, mockWebSocket } from '../TestUtils/session'

mockWebSocket()

const recordingLogger = () => {
	const warnings: Array<{ obj: unknown; msg?: string }> = []
	const logger: ILogger = {
		level: 'silent',
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: (obj, msg) => warnings.push({ obj, msg }),
		error: () => {},
		child: () => logger
	}
	return { logger, warnings }
}

describe('socket auth-state recovery diagnostics', () => {
	it('reports a missing store once without blocking the socket event surface', async () => {
		const session = await makeSession()
		const auth: AuthenticationState = {
			creds: session.state.creds,
			keys: session.state.keys
		}
		const { logger, warnings } = recordingLogger()
		const sock = makeWASocket({
			...DEFAULT_CONNECTION_CONFIG,
			instanceId: 'zpro-main',
			auth,
			logger
		})
		const capabilitiesListener = jest.fn()
		const messageListener = jest.fn()
		sock.ev.on('auth-state.capabilities', capabilitiesListener)
		sock.ev.on('messages.upsert', messageListener)

		await Promise.resolve()
		sock.ev.emit('messages.upsert', { messages: [], type: 'notify' })

		expect(sock.authCapabilities).toEqual(
			expect.objectContaining({
				backend: 'custom',
				instanceId: 'zpro-main',
				accountJid: undefined,
				appStateSyncRecovery: false,
				appStateSyncRecoveryReason: 'missing-store'
			})
		)
		expect(capabilitiesListener).toHaveBeenCalledTimes(1)
		expect(capabilitiesListener).toHaveBeenCalledWith(sock.authCapabilities)
		expect(messageListener).toHaveBeenCalledTimes(1)
		expect(
			warnings.filter(
				entry =>
					typeof entry.obj === 'object' &&
					entry.obj !== null &&
					(entry.obj as { code?: string }).code === 'APP_STATE_SYNC_RECOVERY_UNAVAILABLE'
			)
		).toHaveLength(1)

		await sock.end(new Error('test complete'))
		await session.clear()
	})
})
