import { jest } from '@jest/globals'
import * as http from 'http'
import type { AnyMessageContent, MessageContentGenerationOptions } from '../../Types'
import { generateWAMessageContent } from '../../Utils/messages'

describe('group invite thumbnail download', () => {
	it('uses the configured Node HTTP agent', async () => {
		const thumbnail = Buffer.from('group-thumbnail')
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'image/jpeg' })
			res.end(thumbnail)
		})
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('server did not bind')

		const agent = new http.Agent()
		const instrumentedAgent = agent as unknown as { addRequest: (...args: never[]) => void }
		const addRequest = instrumentedAgent.addRequest.bind(agent)
		const addRequestSpy = jest.fn((...args: never[]) => addRequest(...args))
		instrumentedAgent.addRequest = addRequestSpy

		try {
			const content = await generateWAMessageContent(
				{
					groupInvite: {
						inviteCode: 'invite-code',
						inviteExpiration: 1_800_000_000,
						text: 'Join the group',
						jid: '120363000000000000@g.us',
						subject: 'Test group'
					}
				} as AnyMessageContent,
				{
					upload: jest.fn(),
					getProfilePicUrl: jest.fn(async () => `http://127.0.0.1:${address.port}/thumbnail`),
					options: { agent }
				} as unknown as MessageContentGenerationOptions
			)

			expect(Buffer.from(content.groupInviteMessage!.jpegThumbnail!)).toEqual(thumbnail)
			expect(addRequestSpy).toHaveBeenCalledTimes(1)
		} finally {
			agent.destroy()
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
		}
	})

	it('preserves group invite generation when the optional thumbnail returns an HTTP error', async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(404)
			res.end()
		})
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('server did not bind')

		try {
			const content = await generateWAMessageContent(
				{
					groupInvite: {
						inviteCode: 'invite-code',
						inviteExpiration: 1_800_000_000,
						text: 'Join the group',
						jid: '120363000000000000@g.us',
						subject: 'Test group'
					}
				} as AnyMessageContent,
				{
					upload: jest.fn(),
					getProfilePicUrl: jest.fn(async () => `http://127.0.0.1:${address.port}/missing`)
				} as unknown as MessageContentGenerationOptions
			)

			expect(content.groupInviteMessage?.jpegThumbnail).toBeUndefined()
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
		}
	})
})
