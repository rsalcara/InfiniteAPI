import { once } from 'node:events'
import http from 'node:http'
import { Agent } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createNativeAndroidRegistrationOfficialFetch } from '../../Utils/native-android-registration-client'

/**
 * Proxy agent gate: the official fetch must dispatch through the provided
 * node Agent (the platform injects an HttpsProxyAgent so the /v2/* validation
 * calls egress from a residential IP — a datacenter egress is answered with
 * the security custom_block_screen).
 */
class CountingAgent extends Agent {
	public used = 0

	// `addRequest` existe na base mas não nos @types/node — chamado via
	// protótipo com cast; a contagem prova que o fetch despachou pelo agent.
	addRequest(req: http.ClientRequest, options: http.RequestOptions): void {
		this.used += 1
		const base = (
			Agent.prototype as unknown as {
				addRequest: (this: Agent, req: http.ClientRequest, options: http.RequestOptions) => void
			}
		).addRequest
		base.call(this, req, options)
	}
}

describe('native android registration official fetch (proxy agent)', () => {
	let server: http.Server
	let baseUrl: string
	let hits: number

	beforeAll(async () => {
		hits = 0
		server = http.createServer((req, res) => {
			hits += 1
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end('{"status":"ok"}')
		})
		server.listen(0, '127.0.0.1')
		await once(server, 'listening')
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})

	afterAll(async () => {
		server.close()
	})

	it('dispatches the validation request through the provided proxy agent', async () => {
		const agent = new CountingAgent()
		const officialFetch = createNativeAndroidRegistrationOfficialFetch({ agent })
		const response = await officialFetch(`${baseUrl}/v2/code`, {
			method: 'POST',
			headers: { 'user-agent': 'WhatsApp/2.26.36.72 SMBA/14 Device/test-test' },
			body: 'cc=55&in=9999999999'
		})
		expect(response.status).toBe(200)
		expect(agent.used).toBeGreaterThan(0)
		expect(hits).toBeGreaterThan(0)
	})

	it('works without an agent (direct egress, current behavior)', async () => {
		const officialFetch = createNativeAndroidRegistrationOfficialFetch()
		const response = await officialFetch(`${baseUrl}/v2/code`, {
			method: 'POST',
			body: 'cc=55&in=9999999999'
		})
		expect(response.status).toBe(200)
		expect(hits).toBeGreaterThan(0)
	})
})
