import net from 'net'
import { AbstractSocketClient } from './types'

type TcpState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed'

/** Raw TCP client used only by the opt-in native_android transport. */
export class TcpSocketClient extends AbstractSocketClient {
	protected socket: net.Socket | null = null
	private state: TcpState = 'idle'
	private connectTimer?: ReturnType<typeof setTimeout>

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

		const port = this.url.port ? Number.parseInt(this.url.port, 10) : 443
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`native_android: invalid TCP port ${this.url.port}`)
		}

		this.state = 'connecting'
		this.socket = net.createConnection({ host: this.url.hostname, port })
		this.connectTimer = setTimeout(() => {
			const error = new Error(`native_android: TCP connect timed out after ${this.config.connectTimeoutMs}ms`)
			this.emit('error', error)
			this.socket?.destroy(error)
		}, this.config.connectTimeoutMs)

		this.socket.once('connect', () => {
			if (this.connectTimer) clearTimeout(this.connectTimer)
			this.connectTimer = undefined
			this.state = 'open'
			this.emit('open')
		})
		this.socket.on('data', data => this.emit('message', data))
		this.socket.on('error', error => this.emit('error', error))
		this.socket.once('close', hadError => {
			if (this.connectTimer) clearTimeout(this.connectTimer)
			this.connectTimer = undefined
			this.state = 'closed'
			this.socket = null
			this.emit('close', hadError)
		})
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
			return this.socket.write(data, () => callback?.())
		} catch (error) {
			callback?.(error as Error)
			return false
		}
	}
}
