import net from 'net'
import type { NativeAndroidConnectionEndpoint } from '../../Types'
import {
	connectNativeAndroidCandidate,
	getNativeAndroidConnectedHost,
	iterateNativeAndroidConnectionSequence,
	type NativeConnectionCandidate
} from '../../Utils/native-android-connection-sequence'
import { MAX_NODE_TIMER_MS } from '../../Utils/native-android-constants'
import { resolveProxyConnectionPhase, resolveProxyRouteAudit } from '../../Utils/proxy-route'
import { AbstractSocketClient } from './types'

type TcpState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed'

/** Raw TCP client used only by the opt-in native_android transport. */
export class TcpSocketClient extends AbstractSocketClient {
	protected socket: net.Socket | null = null
	private state: TcpState = 'idle'
	private connectAbortController?: AbortController
	private readonly proxyRouteAudit = resolveProxyRouteAudit(this.config, 'native_android')
	private readonly connectionPhase = resolveProxyConnectionPhase(this.config)
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
			this.emitTerminalFailure(new Error('native_android: transport configuration is missing'))
			return
		}

		const abortController = new AbortController()
		this.connectAbortController = abortController
		const isCurrentAttempt = () => this.state === 'connecting' && this.connectAbortController === abortController
		const defaultSequenceTimeoutMs = Math.min(
			Math.max(Number.isFinite(this.config.connectTimeoutMs) ? this.config.connectTimeoutMs * 16 : 0, 120_000),
			MAX_NODE_TIMER_MS
		)
		const sequenceDeadline = Date.now() + (native.sequenceTimeoutMs ?? defaultSequenceTimeoutMs)
		let candidates: AsyncGenerator<NativeConnectionCandidate>
		try {
			const urlPort = this.url.port ? Number.parseInt(this.url.port, 10) : 443
			const hasExplicitUrlOverride = this.url.hostname !== 'g.whatsapp.net' || urlPort !== 443
			candidates = iterateNativeAndroidConnectionSequence({
				config: hasExplicitUrlOverride ? { ...native, host: this.url.hostname, port: urlPort } : native,
				persisted: this.config.auth?.creds?.nativeAndroidIdentity,
				dnsTimeoutMs: native.dnsTimeoutMs ?? this.config.connectTimeoutMs,
				sequenceDeadline,
				signal: abortController.signal
			})
		} catch (error) {
			this.emitTerminalFailure(error)
			return
		}

		let lastError: Error | undefined
		try {
			let index = 0
			for await (const candidate of candidates) {
				if (!isCurrentAttempt()) return
				const remainingSequenceMs = sequenceDeadline - Date.now()
				if (remainingSequenceMs <= 0) {
					lastError = new Error('native_android: connection sequence timed out')
					break
				}

				try {
					const socket = await connectNativeAndroidCandidate(
						candidate,
						native.proxy,
						Math.min(this.config.connectTimeoutMs, remainingSequenceMs),
						abortController.signal
					)
					if (!isCurrentAttempt()) {
						socket.destroy()
						return
					}

					this.connectAttemptCount = index
					if (this.connectAbortController === abortController) this.connectAbortController = undefined
					this.attachConnectedSocket(socket, candidate)
					return
				} catch (error) {
					if (!isCurrentAttempt()) return
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

		if (!isCurrentAttempt()) return
		this.connectAbortController = undefined
		this.emitTerminalFailure(lastError || new Error('native_android: no connection candidates are available'))
	}

	private emitTerminalFailure(error: unknown) {
		if (this.state === 'closed') return
		this.state = 'closed'
		try {
			this.emit('error', error instanceof Error ? error : new Error(String(error)))
		} finally {
			this.emit('close', true)
		}
	}

	private attachConnectedSocket(socket: net.Socket, candidate: NativeConnectionCandidate) {
		const connectedHost = getNativeAndroidConnectedHost(socket)
		const native = this.config.nativeAndroid!
		const proxy = native.proxy
		this.socket = socket
		this.selectedEndpoint = {
			host: candidate.host,
			address: connectedHost && net.isIP(connectedHost) ? connectedHost : candidate.address,
			port: candidate.port,
			source: candidate.source,
			sequenceStep: candidate.sequenceStep
		}
		this.dnsAppCached = candidate.dnsCached
		this.addressSource = candidate.addressSource
		this.state = 'open'
		this.config.logger.info(
			{
				event: 'whatsapp_transport_route_established',
				transportProfile: 'native_android',
				connectionPhase: this.connectionPhase,
				connectionTrigger: this.config.connectionTrigger ?? 'unspecified',
				routeMode: proxy ? 'proxy' : 'direct',
				...this.proxyRouteAudit,
				proxyType: proxy?.type,
				proxyEndpointHost: proxy?.host,
				proxyEndpointPort: proxy?.port,
				proxyDnsMode: proxy
					? proxy.type === 'http-connect' ||
						proxy.type === 'https-connect' ||
						(proxy.resolveDns ?? proxy.type === 'socks5')
						? 'remote'
						: 'local'
					: undefined,
				// This is the TCP tunnel property; proxyPolicyEnforced covers the aggregate TCP/WS/HTTP policy.
				proxyFailClosed: Boolean(proxy),
				physicalRemoteAddress: socket.remoteAddress,
				physicalRemotePort: socket.remotePort,
				whatsappTargetHost: candidate.host,
				whatsappTargetPort: candidate.port,
				whatsappConnectAddress: connectedHost,
				candidateSource: candidate.source,
				sequenceStep: candidate.sequenceStep,
				connectAttempt: this.connectAttemptCount + 1,
				dnsAppCached: candidate.dnsCached,
				addressSource: candidate.addressSource
			},
			'native_android: WhatsApp transport route established'
		)
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
		this.connectAbortController?.abort()
		this.connectAbortController = undefined
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
