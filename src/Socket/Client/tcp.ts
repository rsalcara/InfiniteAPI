import net from 'net'
import type { NativeAndroidConnectionEndpoint } from '../../Types'
import {
	connectNativeAndroidCandidate,
	iterateNativeAndroidConnectionSequence,
	type NativeConnectionCandidate
} from '../../Utils/native-android-connection-sequence'
import { AbstractSocketClient } from './types'

type TcpState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed'

/** Raw TCP client used only by the opt-in native_android transport. */
export class TcpSocketClient extends AbstractSocketClient {
	protected socket: net.Socket | null = null
	private state: TcpState = 'idle'
	selectedEndpoint?: NativeAndroidConnectionEndpoint
	connectAttemptCount = 0
	dnsAppCached = false
	addressSource = 1

	get isOpen(): boolean {
		return this.state === 'open' && Boolean(this.socket && !this.socket.destroyed)
	}

	get isClosed(): boolean {
		return this.state === 'closed' || this.state === 'idle'
	}

	get isClosing(): boolean {
		return this.state === 'closing'
	}

	get isConnecting(): boolean {
		return this.state === 'connecting'
	}

	connect() {
		if (this.socket || this.state === 'connecting' || this.state === 'open') return
		this.state = 'connecting'
		void this.connectSequence()
	}

	private async connectSequence() {
		const native = this.config.nativeAndroid
		if (!native) {
			this.state = 'closed'
			this.emit('error', new Error('native_android: transport configuration is missing'))
			return
		}

		let candidates: AsyncGenerator<NativeConnectionCandidate>
		try {
			const urlPort = this.url.port ? Number.parseInt(this.url.port, 10) : 443
			const hasExplicitUrlOverride = this.url.hostname !== 'g.whatsapp.net' || urlPort !== 443
			candidates = iterateNativeAndroidConnectionSequence({
				config: hasExplicitUrlOverride ? { ...native, host: this.url.hostname, port: urlPort } : native,
				persisted: this.config.auth?.creds?.nativeAndroidIdentity
			})
		} catch (error) {
			this.state = 'closed'
			this.emit('error', error)
			return
		}

		let lastError: Error | undefined
		try {
			let index = 0
			for await (const candidate of candidates) {
				if (this.state !== 'connecting') return
				try {
					const socket = await connectNativeAndroidCandidate(candidate, native.proxy, this.config.connectTimeoutMs)
					if (this.state !== 'connecting') {
						socket.destroy()
						return
					}
					this.connectAttemptCount = index
					this.attachConnectedSocket(socket, candidate)
					return
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error))
					this.config.logger.debug(
						{
							host: candidate.host,
							port: candidate.port,
							source: candidate.source,
							proxied: Boolean(native.proxy),
							error: lastError.message
						},
						'native_android: connection candidate failed'
					)
				}
				index++
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error))
		}

		this.state = 'closed'
		this.emit('error', lastError || new Error('native_android: no connection candidates are available'))
	}

	private attachConnectedSocket(socket: net.Socket, candidate: NativeConnectionCandidate) {
		this.socket = socket
		this.selectedEndpoint = {
			host: candidate.host,
			address: candidate.address,
			port: candidate.port,
			source: candidate.source,
			sequenceStep: candidate.sequenceStep
		}
		this.dnsAppCached = candidate.dnsCached
		this.addressSource = candidate.addressSource
		this.state = 'open'
		socket.on('data', data => this.emit('message', data))
		socket.on('error', error => this.emit('error', error))
		socket.once('close', hadError => {
			this.state = 'closed'
			this.socket = null
			this.emit('close', hadError)
		})
		this.emit('open')
	}

	async close(timeoutMs = 5000) {
		const socket = this.socket
		if (!socket) {
			this.state = 'closed'
			return
		}

		this.state = 'closing'
		await new Promise<void>(resolve => {
			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolve()
			}

			const timer = setTimeout(() => {
				socket.destroy()
				finish()
			}, timeoutMs)
			socket.once('close', finish)
			socket.end()
		})
	}

	send(data: Uint8Array | string, callback?: (err?: Error) => void): boolean {
		if (!this.socket || !this.isOpen) {
			callback?.(new Error('native_android: TCP socket is not open'))
			return false
		}

		try {
			return this.socket.write(data, error => callback?.(error ?? undefined))
		} catch (error) {
			callback?.(error as Error)
			return false
		}
	}
}
