import { jest } from '@jest/globals'
import * as fs from 'fs'
import * as http from 'http'
import { Agent } from 'https'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import type { MediaConnInfo, SocketConfig } from '../../Types'
import type { ILogger } from '../../Utils/logger'
import {
	encryptedStream,
	getHttpStream,
	getWAUploadToServer,
	type UploadParams,
	uploadWithNodeHttp
} from '../../Utils/messages-media'

const createTempFile = async (content: string): Promise<string> => {
	const filePath = path.join(os.tmpdir(), `test-upload-${Date.now()}.txt`)
	await fs.promises.writeFile(filePath, content)
	return filePath
}

const cleanupTempFile = async (filePath: string): Promise<void> => {
	try {
		await fs.promises.unlink(filePath)
	} catch {}
}

const createLogger = (): ILogger => {
	const logger: ILogger = {
		level: 'silent',
		child: () => logger,
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {}
	}
	return logger
}

describe('uploadWithNodeHttp', () => {
	let server: http.Server
	let serverPort: number
	let tempFilePath: string
	const testFileContent = 'Hello, this is test content for upload!'

	beforeAll(async () => {
		tempFilePath = await createTempFile(testFileContent)
	})

	afterAll(async () => {
		await cleanupTempFile(tempFilePath)
	})

	afterEach(() => {
		if (server) {
			server.close()
		}
	})

	const startServer = (handler: http.RequestListener): Promise<number> => {
		return new Promise(resolve => {
			server = http.createServer(handler)
			server.listen(0, () => {
				const address = server.address()
				if (address && typeof address === 'object') {
					serverPort = address.port
					resolve(serverPort)
				}
			})
		})
	}

	it('should successfully upload a file and receive JSON response', async () => {
		const expectedResponse = { url: 'https://example.com/media/123', direct_path: '/media/123' }
		let receivedBody = ''

		await startServer((req, res) => {
			req.on('data', chunk => {
				receivedBody += chunk
			})
			req.on('end', () => {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify(expectedResponse))
			})
		})

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/upload`,
			filePath: tempFilePath,
			headers: { 'Content-Type': 'application/octet-stream' }
		}

		const result = await uploadWithNodeHttp(params)

		expect(result).toEqual(expectedResponse)
		expect(receivedBody).toBe(testFileContent)
	})

	it('routes a dispatcher supplied directly to the exported helper through fetch', async () => {
		const originalFetch = globalThis.fetch
		const dispatcher = { dispatch: () => undefined }
		let fetchInit: RequestInit | undefined
		globalThis.fetch = (async (_input, init) => {
			fetchInit = init
			return new Response(JSON.stringify({ success: true }), {
				headers: { 'Content-Type': 'application/json' }
			})
		}) as typeof fetch

		try {
			await expect(
				uploadWithNodeHttp({
					url: 'https://upload.example/media',
					filePath: tempFilePath,
					headers: { 'Content-Type': 'application/octet-stream' },
					agent: dispatcher
				})
			).resolves.toEqual({ success: true })
			expect(fetchInit?.dispatcher).toBe(dispatcher)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it('destroys the upload stream when fetch rejects', async () => {
		const originalFetch = globalThis.fetch
		const destroySpy = jest.spyOn(fs.ReadStream.prototype, 'destroy')
		globalThis.fetch = (async () => {
			throw new Error('fetch failed')
		}) as typeof fetch

		try {
			await expect(
				uploadWithNodeHttp({
					url: 'https://upload.example/media',
					filePath: tempFilePath,
					headers: { 'Content-Type': 'application/octet-stream' },
					agent: { dispatch: () => undefined }
				})
			).rejects.toThrow('fetch failed')
			expect(destroySpy).toHaveBeenCalled()
		} finally {
			destroySpy.mockRestore()
			globalThis.fetch = originalFetch
		}
	})

	it('should follow a single redirect (302)', async () => {
		const expectedResponse = { url: 'https://example.com/media/456', direct_path: '/media/456' }
		let requestCount = 0

		await startServer((req, res) => {
			requestCount++
			if (req.url === '/upload') {
				res.writeHead(302, { Location: `http://localhost:${serverPort}/final` })
				res.end()
			} else if (req.url === '/final') {
				let body = ''
				req.on('data', chunk => (body += chunk))
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(expectedResponse))
				})
			}
		})

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/upload`,
			filePath: tempFilePath,
			headers: { 'Content-Type': 'application/octet-stream' }
		}

		const result = await uploadWithNodeHttp(params)

		expect(result).toEqual(expectedResponse)
		expect(requestCount).toBe(2)
	})

	it('should follow multiple redirects (301 -> 302 -> 200)', async () => {
		const expectedResponse = { url: 'https://example.com/media/789', direct_path: '/media/789' }
		let requestCount = 0

		await startServer((req, res) => {
			requestCount++
			if (req.url === '/upload') {
				res.writeHead(301, { Location: `http://localhost:${serverPort}/redirect1` })
				res.end()
			} else if (req.url === '/redirect1') {
				res.writeHead(302, { Location: `http://localhost:${serverPort}/redirect2` })
				res.end()
			} else if (req.url === '/redirect2') {
				res.writeHead(307, { Location: `http://localhost:${serverPort}/final` })
				res.end()
			} else if (req.url === '/final') {
				let body = ''
				req.on('data', chunk => (body += chunk))
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(expectedResponse))
				})
			}
		})

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/upload`,
			filePath: tempFilePath,
			headers: { 'Content-Type': 'application/octet-stream' }
		}

		const result = await uploadWithNodeHttp(params)

		expect(result).toEqual(expectedResponse)
		expect(requestCount).toBe(4)
	})

	it('should throw error on too many redirects (more than 5)', async () => {
		await startServer((req, res) => {
			const currentNum = parseInt(req.url?.replace('/redirect', '') || '0')
			res.writeHead(302, { Location: `http://localhost:${serverPort}/redirect${currentNum + 1}` })
			res.end()
		})

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/redirect0`,
			filePath: tempFilePath,
			headers: { 'Content-Type': 'application/octet-stream' }
		}

		await expect(uploadWithNodeHttp(params)).rejects.toThrow('Too many redirects')
	})

	it('should return undefined for non-JSON response', async () => {
		await startServer((req, res) => {
			let body = ''
			req.on('data', chunk => (body += chunk))
			req.on('end', () => {
				res.writeHead(200, { 'Content-Type': 'text/html' })
				res.end('<html>Not JSON</html>')
			})
		})

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/upload`,
			filePath: tempFilePath,
			headers: { 'Content-Type': 'application/octet-stream' }
		}

		const result = await uploadWithNodeHttp(params)

		expect(result).toBeUndefined()
	})

	it('should handle relative redirect URLs', async () => {
		const expectedResponse = { url: 'https://example.com/media/rel', direct_path: '/media/rel' }
		let requestCount = 0

		await startServer((req, res) => {
			requestCount++
			if (req.url === '/upload') {
				res.writeHead(302, { Location: '/final' })
				res.end()
			} else if (req.url === '/final') {
				let body = ''
				req.on('data', chunk => (body += chunk))
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(expectedResponse))
				})
			}
		})

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/upload`,
			filePath: tempFilePath,
			headers: { 'Content-Type': 'application/octet-stream' }
		}

		const result = await uploadWithNodeHttp(params)

		expect(result).toEqual(expectedResponse)
		expect(requestCount).toBe(2)
	})

	it('should preserve headers on redirect', async () => {
		const expectedResponse = { success: true }
		let capturedHeaders: http.IncomingHttpHeaders | undefined

		await startServer((req, res) => {
			if (req.url === '/upload') {
				res.writeHead(302, { Location: `http://localhost:${serverPort}/final` })
				res.end()
			} else if (req.url === '/final') {
				capturedHeaders = req.headers
				let body = ''
				req.on('data', chunk => (body += chunk))
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(expectedResponse))
				})
			}
		})

		const customHeaders = {
			'Content-Type': 'application/octet-stream',
			'X-Custom-Header': 'test-value',
			Authorization: 'Bearer token123'
		}

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/upload`,
			filePath: tempFilePath,
			headers: customHeaders
		}

		const result = await uploadWithNodeHttp(params)

		expect(result).toEqual(expectedResponse)
		expect(capturedHeaders?.['x-custom-header']).toBe('test-value')
		expect(capturedHeaders?.['authorization']).toBe('Bearer token123')
	})

	it('should strip credentials on a cross-origin upload redirect', async () => {
		let capturedHeaders: http.IncomingHttpHeaders | undefined
		const targetServer = http.createServer((req, res) => {
			capturedHeaders = req.headers
			req.resume()
			req.on('end', () => {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ success: true }))
			})
		})
		await new Promise<void>(resolve => targetServer.listen(0, '127.0.0.1', resolve))
		const targetAddress = targetServer.address()
		if (!targetAddress || typeof targetAddress === 'string') throw new Error('target server did not bind')

		try {
			await startServer((req, res) => {
				req.resume()
				req.on('end', () => {
					res.writeHead(302, { Location: `http://127.0.0.1:${targetAddress.port}/final` })
					res.end()
				})
			})

			const result = await uploadWithNodeHttp({
				url: `http://127.0.0.1:${serverPort}/upload`,
				filePath: tempFilePath,
				headers: {
					Authorization: 'Bearer secret',
					'Proxy-Authorization': 'Basic secret',
					Cookie: 'session=secret',
					Host: 'source.example',
					'X-Custom-Header': 'kept'
				}
			})

			expect(result).toEqual({ success: true })
			expect(capturedHeaders?.authorization).toBeUndefined()
			expect(capturedHeaders?.['proxy-authorization']).toBeUndefined()
			expect(capturedHeaders?.cookie).toBeUndefined()
			expect(capturedHeaders?.host).toBe(`127.0.0.1:${targetAddress.port}`)
			expect(capturedHeaders?.['x-custom-header']).toBe('kept')
		} finally {
			await new Promise<void>((resolve, reject) => targetServer.close(error => (error ? reject(error) : resolve())))
		}
	})

	it('should re-stream file content on redirect', async () => {
		const expectedResponse = { success: true }
		let finalReceivedBody = ''

		await startServer((req, res) => {
			if (req.url === '/upload') {
				req.on('data', () => {})
				req.on('end', () => {
					res.writeHead(302, { Location: `http://localhost:${serverPort}/final` })
					res.end()
				})
			} else if (req.url === '/final') {
				req.on('data', chunk => {
					finalReceivedBody += chunk
				})
				req.on('end', () => {
					res.writeHead(200, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify(expectedResponse))
				})
			}
		})

		const params: UploadParams = {
			url: `http://localhost:${serverPort}/upload`,
			filePath: tempFilePath,
			headers: { 'Content-Type': 'application/octet-stream' }
		}

		const result = await uploadWithNodeHttp(params)

		expect(result).toEqual(expectedResponse)
		expect(finalReceivedBody).toBe(testFileContent)
	})
})

describe('getHttpStream', () => {
	let server: http.Server

	afterEach(() => {
		server?.close()
	})

	it('uses the configured Node agent for downloads and redirects', async () => {
		server = http.createServer((req, res) => {
			if (req.url === '/redirect') {
				res.writeHead(302, { Location: '/media' })
				res.end()
				return
			}

			res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
			res.end('proxied-download')
		})
		const port = await new Promise<number>(resolve => {
			server.listen(0, () => resolve((server.address() as { port: number }).port))
		})
		const agent = new http.Agent()
		const instrumentedAgent = agent as unknown as {
			addRequest: (...args: never[]) => void
		}
		const originalAddRequest = instrumentedAgent.addRequest.bind(agent)
		let requestCount = 0
		instrumentedAgent.addRequest = (...args: never[]) => {
			requestCount += 1
			originalAddRequest(...args)
		}

		const stream = await getHttpStream(`http://127.0.0.1:${port}/redirect`, { agent })
		const chunks: Buffer[] = []
		for await (const chunk of stream) chunks.push(Buffer.from(chunk))

		expect(Buffer.concat(chunks).toString()).toBe('proxied-download')
		expect(requestCount).toBe(2)
	})

	it('rejects malformed redirect locations as typed fetch errors', async () => {
		server = http.createServer((_req, res) => {
			res.writeHead(302, { Location: 'http://[invalid' })
			res.end()
		})
		const port = await new Promise<number>(resolve => {
			server.listen(0, () => resolve((server.address() as { port: number }).port))
		})

		await expect(getHttpStream(`http://127.0.0.1:${port}/redirect`, { agent: new http.Agent() })).rejects.toMatchObject(
			{
				message: expect.stringContaining('Invalid redirect URL'),
				output: { statusCode: 502 }
			}
		)
	})

	it('fails closed with a clear error when a Node agent cannot handle the target protocol', async () => {
		await expect(getHttpStream('http://127.0.0.1:1/media', { agent: new Agent() })).rejects.toMatchObject({
			message: 'Configured Node HTTP agent does not support http: URLs',
			output: { statusCode: 502 }
		})
	})

	it('routes a dispatcher supplied in agent through fetch instead of Node HTTP', async () => {
		const originalFetch = globalThis.fetch
		const dispatcher = { dispatch: () => undefined }
		let fetchInit: RequestInit | undefined
		globalThis.fetch = (async (_input, init) => {
			fetchInit = init
			return new Response('dispatcher-download')
		}) as typeof fetch

		try {
			const stream = await getHttpStream('https://download.example/media', {
				agent: dispatcher
			} as unknown as RequestInit)
			const chunks: Buffer[] = []
			for await (const chunk of stream) chunks.push(Buffer.from(chunk))

			expect(Buffer.concat(chunks).toString()).toBe('dispatcher-download')
			expect(fetchInit?.dispatcher).toBe(dispatcher)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it('does not let the response-header timeout truncate a slow response body', async () => {
		server = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
			res.flushHeaders()
			setTimeout(() => res.end('slow-body'), 50)
		})
		const port = await new Promise<number>(resolve => {
			server.listen(0, () => resolve((server.address() as { port: number }).port))
		})

		const stream = await getHttpStream(`http://127.0.0.1:${port}/media`, {
			agent: new http.Agent(),
			timeout: 10
		})
		const chunks: Buffer[] = []
		for await (const chunk of stream) chunks.push(Buffer.from(chunk))

		expect(Buffer.concat(chunks).toString()).toBe('slow-body')
	})

	it.each([
		['Headers', new Headers({ 'x-from-headers': 'headers-value' })],
		['tuple array', [['x-from-tuples', 'tuple-value']] as [string, string][]]
	])('normalizes %s request headers for the Node HTTP path', async (_label, headers) => {
		let receivedHeaders: http.IncomingHttpHeaders | undefined
		server = http.createServer((req, res) => {
			receivedHeaders = req.headers
			res.writeHead(200)
			res.end('headers-ok')
		})
		const port = await new Promise<number>(resolve => {
			server.listen(0, () => resolve((server.address() as { port: number }).port))
		})

		const stream = await getHttpStream(`http://127.0.0.1:${port}/media`, {
			agent: new http.Agent(),
			headers
		})
		const chunks: Buffer[] = []
		for await (const chunk of stream) chunks.push(Buffer.from(chunk))

		const expectedName = _label === 'Headers' ? 'x-from-headers' : 'x-from-tuples'
		const expectedValue = _label === 'Headers' ? 'headers-value' : 'tuple-value'
		expect(receivedHeaders?.[expectedName]).toBe(expectedValue)
	})

	it('strips credentials but preserves ordinary headers on cross-origin redirects', async () => {
		const originalFetch = globalThis.fetch
		const calls: Array<{ url: string; headers: Headers }> = []
		globalThis.fetch = (async (input, init) => {
			calls.push({ url: input.toString(), headers: new Headers(init?.headers) })
			if (calls.length === 1) {
				return new Response(null, {
					status: 302,
					headers: { Location: 'https://media.example/final' }
				})
			}

			return new Response('redirected-media')
		}) as typeof fetch

		try {
			const stream = await getHttpStream('https://download.example/start', {
				dispatcher: { dispatch: () => undefined },
				headers: {
					Authorization: 'Bearer secret',
					'Proxy-Authorization': 'Basic secret',
					Cookie: 'session=secret',
					Host: 'download.example',
					Origin: 'https://web.whatsapp.com',
					Range: 'bytes=0-99',
					'X-Custom': 'kept'
				}
			})
			const chunks: Buffer[] = []
			for await (const chunk of stream) chunks.push(Buffer.from(chunk))

			expect(calls).toHaveLength(2)
			const redirectedHeaders = calls[1]!.headers
			expect(redirectedHeaders.has('authorization')).toBe(false)
			expect(redirectedHeaders.has('proxy-authorization')).toBe(false)
			expect(redirectedHeaders.has('cookie')).toBe(false)
			expect(redirectedHeaders.has('host')).toBe(false)
			expect(redirectedHeaders.get('origin')).toBe('https://web.whatsapp.com')
			expect(redirectedHeaders.get('range')).toBe('bytes=0-99')
			expect(redirectedHeaders.get('x-custom')).toBe('kept')
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it('enforces the same five-redirect limit on the fetch dispatcher path', async () => {
		const originalFetch = globalThis.fetch
		let calls = 0
		globalThis.fetch = (async () => {
			calls += 1
			return new Response(null, { status: 302, headers: { Location: `/redirect-${calls}` } })
		}) as typeof fetch

		try {
			await expect(
				getHttpStream('https://download.example/redirect-0', {
					dispatcher: { dispatch: () => undefined }
				})
			).rejects.toThrow('Too many redirects')
			expect(calls).toBe(6)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it('applies download timeouts on the fetch dispatcher path', async () => {
		const originalFetch = globalThis.fetch
		globalThis.fetch = ((_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
			})) as typeof fetch

		try {
			await expect(
				getHttpStream('https://download.example/slow', {
					dispatcher: { dispatch: () => undefined },
					timeout: 10
				})
			).rejects.toThrow('Timed out fetching stream')
		} finally {
			globalThis.fetch = originalFetch
		}
	})
})

describe('getWAUploadToServer', () => {
	let tempFilePath: string
	let originalFetch: typeof globalThis.fetch
	let originalBunDescriptor: PropertyDescriptor | undefined

	beforeAll(async () => {
		tempFilePath = await createTempFile('fetch upload content')
	})

	beforeEach(() => {
		originalFetch = globalThis.fetch
		originalBunDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun')
		Object.defineProperty(process.versions, 'bun', {
			value: 'test-runtime',
			configurable: true
		})
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		if (originalBunDescriptor) {
			Object.defineProperty(process.versions, 'bun', originalBunDescriptor)
		} else {
			delete (process.versions as { bun?: string }).bun
		}
	})

	afterAll(async () => {
		await cleanupTempFile(tempFilePath)
	})

	it('does not pass a generic https Agent as a fetch dispatcher', async () => {
		let fetchInit: RequestInit | undefined
		globalThis.fetch = (async (_input, init) => {
			fetchInit = init
			return new Response(JSON.stringify({ url: 'https://example.com/media', direct_path: '/media' }), {
				headers: { 'Content-Type': 'application/json' }
			})
		}) as typeof fetch

		const mediaConn: MediaConnInfo = {
			auth: 'auth-token',
			ttl: 60,
			hosts: [{ hostname: 'upload.example.com', maxContentLengthBytes: 1024 }],
			fetchDate: new Date()
		}
		const upload = getWAUploadToServer(
			{
				customUploadHosts: [],
				fetchAgent: new Agent(),
				logger: createLogger(),
				options: {}
			} as Partial<SocketConfig> as SocketConfig,
			async () => mediaConn
		)

		await expect(upload(tempFilePath, { fileEncSha256B64: 'abc123', mediaType: 'image' })).resolves.toEqual({
			mediaUrl: 'https://example.com/media',
			directPath: '/media',
			meta_hmac: undefined,
			fbid: undefined,
			ts: undefined
		})
		expect((fetchInit as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher).toBeUndefined()
	})

	it('uses an Undici dispatcher for uploads in the Node runtime', async () => {
		Object.defineProperty(process.versions, 'bun', { value: undefined, configurable: true })
		const dispatcher = { dispatch: () => undefined }
		let fetchInit: RequestInit | undefined
		globalThis.fetch = (async (_input, init) => {
			fetchInit = init
			return new Response(JSON.stringify({ url: 'https://example.com/media', direct_path: '/media' }), {
				headers: { 'Content-Type': 'application/json' }
			})
		}) as typeof fetch

		const mediaConn: MediaConnInfo = {
			auth: 'auth-token',
			ttl: 60,
			hosts: [{ hostname: 'upload.example.com', maxContentLengthBytes: 1024 }],
			fetchDate: new Date()
		}
		const upload = getWAUploadToServer(
			{
				customUploadHosts: [],
				fetchAgent: dispatcher,
				logger: createLogger(),
				options: {}
			} as Partial<SocketConfig> as SocketConfig,
			async () => mediaConn
		)

		await expect(upload(tempFilePath, { fileEncSha256B64: 'abc123', mediaType: 'image' })).resolves.toBeDefined()
		expect(fetchInit?.dispatcher).toBe(dispatcher)
	})
})

describe('encryptedStream', () => {
	const cleanupFiles = async (files: (string | undefined)[]) => {
		for (const file of files) {
			if (file) {
				try {
					await fs.promises.unlink(file)
				} catch {}
			}
		}
	}

	it('should encrypt a buffer and return valid result without hanging', async () => {
		const testData = Buffer.from('Hello, this is test content for encryption!')

		const result = await encryptedStream(testData, 'image')

		expect(result).toBeDefined()
		expect(result.mediaKey).toBeDefined()
		expect(result.mediaKey.length).toBe(32)
		expect(result.encFilePath).toBeDefined()
		expect(result.fileSha256).toBeDefined()
		expect(result.fileEncSha256).toBeDefined()
		expect(result.mac).toBeDefined()
		expect(result.mac.length).toBe(10)
		expect(result.fileLength).toBe(testData.length)

		const encFileExists = await fs.promises
			.access(result.encFilePath)
			.then(() => true)
			.catch(() => false)
		expect(encFileExists).toBe(true)

		await cleanupFiles([result.encFilePath, result.originalFilePath])
	})

	it('should encrypt a stream and complete without race condition', async () => {
		const chunks = ['chunk1', 'chunk2', 'chunk3', 'chunk4', 'chunk5']
		const testStream = Readable.from(chunks.map(c => Buffer.from(c)))

		const result = await encryptedStream({ stream: testStream }, 'document')

		expect(result).toBeDefined()
		expect(result.mediaKey).toBeDefined()
		expect(result.encFilePath).toBeDefined()
		expect(result.fileLength).toBe(chunks.join('').length)

		await cleanupFiles([result.encFilePath, result.originalFilePath])
	})

	it('should save original file when saveOriginalFileIfRequired is true', async () => {
		const testData = Buffer.from('Original file content to save')

		const result = await encryptedStream(testData, 'audio', {
			saveOriginalFileIfRequired: true
		})

		expect(result).toBeDefined()
		expect(result.originalFilePath).toBeDefined()

		const originalContent = await fs.promises.readFile(result.originalFilePath!)
		expect(originalContent.toString()).toBe(testData.toString())

		await cleanupFiles([result.encFilePath, result.originalFilePath])
	})

	it('should complete encryption for various media types', async () => {
		const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'] as const
		const testData = Buffer.from('Test data for different media types')

		for (const mediaType of mediaTypes) {
			const result = await encryptedStream(testData, mediaType)

			expect(result).toBeDefined()
			expect(result.mediaKey).toBeDefined()
			expect(result.encFilePath).toBeDefined()

			await cleanupFiles([result.encFilePath, result.originalFilePath])
		}
	})

	it('should handle empty buffer without hanging', async () => {
		const emptyData = Buffer.from('')

		const result = await encryptedStream(emptyData, 'image')

		expect(result).toBeDefined()
		expect(result.fileLength).toBe(0)
		expect(result.encFilePath).toBeDefined()

		await cleanupFiles([result.encFilePath, result.originalFilePath])
	})

	it('should handle small content that finishes quickly', async () => {
		const smallData = Buffer.from('x')

		const result = await encryptedStream(smallData, 'image')

		expect(result).toBeDefined()
		expect(result.fileLength).toBe(1)

		await cleanupFiles([result.encFilePath, result.originalFilePath])
	})

	it('should complete multiple concurrent encryptions without deadlock', async () => {
		const testData = Buffer.from('Concurrent encryption test')

		const promises = Array.from({ length: 5 }, () => encryptedStream(testData, 'image'))

		const results = await Promise.all(promises)

		expect(results.length).toBe(5)
		for (const result of results) {
			expect(result).toBeDefined()
			expect(result.mediaKey).toBeDefined()
			await cleanupFiles([result.encFilePath, result.originalFilePath])
		}
	})
})
