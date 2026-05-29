import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}
	get isConnecting(): boolean {
		return this.socket?.readyState === WebSocket.CONNECTING
	}

	connect() {
		if (this.socket) {
			return
		}

		this.socket = new WebSocket(this.url, {
			origin: DEFAULT_ORIGIN,
			headers: this.config.options?.headers as {},
			handshakeTimeout: this.config.connectTimeoutMs,
			timeout: this.config.connectTimeoutMs,
			agent: this.config.agent
		})

		// Set max listeners from config (default: 20)
		// WARNING: 0 disables limit and allows potential memory leaks
		const maxListeners = this.config.maxWebSocketListeners ?? 20
		if (maxListeners === 0) {
			this.config.logger?.warn('WebSocket setMaxListeners(0) allows UNLIMITED listeners - potential memory leak!')
		}

		this.socket.setMaxListeners(maxListeners)

		const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']

		for (const event of events) {
			this.socket?.on(event, (...args: any[]) => this.emit(event, ...args))
		}
	}

	async close(timeoutMs = 5000) {
		if (!this.socket) {
			return
		}

		const closePromise = new Promise<void>(resolve => {
			this.socket?.once('close', resolve)
		})

		this.socket.close()

		// Audit ROBUST-001 — antes `await closePromise` ficava pendente
		// indefinidamente se o WS não emitisse `close` (TCP half-open, RST
		// nunca recebido, servidor degradado). Race com timeout + fallback
		// pra `terminate()` garante que reconexão sempre ocorre em ≤5s.
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined
		const timeoutPromise = new Promise<'timeout'>(resolve => {
			timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs)
		})
		const result = await Promise.race([closePromise.then(() => 'closed' as const), timeoutPromise])
		if (timeoutHandle) clearTimeout(timeoutHandle)

		if (result === 'timeout') {
			// Last resort — force the WebSocket transport down. terminate()
			// shuts down the underlying TCP socket without waiting for the
			// close frame to round-trip.
			try {
				this.socket?.terminate?.()
			} catch {
				/* best effort */
			}
		}

		this.socket = null
	}
	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		this.socket?.send(str, cb)

		return Boolean(this.socket)
	}
}
