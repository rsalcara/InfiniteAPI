/**
 * Unit tests for `attachMeUsernameSync`.
 *
 * The listener consumes `contacts.upsert` / `contacts.update` events
 * (re-shaped by `messages-recv.handleMexNotification` from the
 * `UsernameSetNotification` / `UsernameDeleteNotification` mex stanza
 * pushed by WhatsApp when the user changes their handle on the
 * primary phone), and mirrors the result onto `creds.me.username`
 * with a `creds.update` emit so persistence runs on the same path
 * every other creds change uses.
 *
 * Contract:
 *   - first reservation: upsert with @ → set + emit creds.update
 *   - change: upsert with different @ → flip + emit
 *   - no-op: upsert with the same @ → NO emit
 *   - clear: upsert with `username: null` → clear + emit
 *   - no-opinion: upsert with `username` absent → leave alone
 *   - other contacts: upsert for someone ELSE → never touch creds
 *   - LID/PN duality: upsert addressed by `me.lid` matches `me.id`
 *     (and vice-versa) — the mex notification path uses LID
 */
import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import type { AuthenticationCreds, BaileysEventEmitter, Contact } from '../../Types'
import type { ILogger } from '../../Utils/logger'
import { attachMeUsernameSync } from '../../Utils/me-username-sync'

const silentLogger = (): ILogger =>
	({
		level: 'silent',
		child: () => silentLogger(),
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {}
	}) as unknown as ILogger

const ME_ID = '5511999999991@s.whatsapp.net'
const ME_LID = '46802258641027@lid'
const OTHER = '5511777777777@s.whatsapp.net'

const makeCreds = (): AuthenticationCreds =>
	({
		me: { id: ME_ID, lid: ME_LID, name: 'me', username: undefined }
	}) as unknown as AuthenticationCreds

const makeEv = () => new EventEmitter() as unknown as BaileysEventEmitter

describe('attachMeUsernameSync', () => {
	it('first reservation: sets username + emits creds.update', () => {
		const creds = makeCreds()
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [{ id: ME_ID, username: 'tuoli' } as Contact])

		expect(creds.me!.username).toBe('tuoli')
		expect(updates).toHaveLength(1)
		expect(updates[0]!.me!.username).toBe('tuoli')
	})

	it('change: flips the value + emits creds.update once', () => {
		const creds = makeCreds()
		creds.me!.username = 'tuoli'
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [{ id: ME_ID, username: 'tuoli2' } as Contact])

		expect(creds.me!.username).toBe('tuoli2')
		expect(updates).toHaveLength(1)
	})

	it('no-op: repeated upsert with same username does NOT emit', () => {
		const creds = makeCreds()
		creds.me!.username = 'tuoli'
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [{ id: ME_ID, username: 'tuoli' } as Contact])
		ev.emit('contacts.upsert', [{ id: ME_ID, username: 'tuoli' } as Contact])

		expect(updates).toHaveLength(0)
	})

	it('clear: `username: null` clears the field + emits', () => {
		const creds = makeCreds()
		creds.me!.username = 'tuoli'
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [{ id: ME_ID, username: null } as unknown as Contact])

		expect(creds.me!.username).toBeUndefined()
		expect(updates).toHaveLength(1)
	})

	it('no-opinion: upsert with `username` ABSENT leaves field alone', () => {
		const creds = makeCreds()
		creds.me!.username = 'tuoli'
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		// payload without `username` key — could be a notify change
		ev.emit('contacts.upsert', [{ id: ME_ID, notify: 'New Name' } as Contact])

		expect(creds.me!.username).toBe('tuoli')
		expect(updates).toHaveLength(0)
	})

	it('other contact: upsert for someone ELSE MUST NOT touch creds', () => {
		const creds = makeCreds()
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [{ id: OTHER, username: 'other_handle' } as Contact])

		expect(creds.me!.username).toBeUndefined()
		expect(updates).toHaveLength(0)
	})

	it('LID/PN duality: addressed by `me.lid` matches `me.id`', () => {
		// The mex notification path carries the LID — this is the case
		// that fires in practice when the user changes their @ on the
		// primary phone.
		const creds = makeCreds()
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [{ id: ME_LID, username: 'tuoli' } as Contact])

		expect(creds.me!.username).toBe('tuoli')
		expect(updates).toHaveLength(1)
	})

	it('LID/PN duality: contact with `c.lid` set (and unrelated `c.id`) matches `me.lid`', () => {
		// Regression for the auditor's P2-2 finding. Before the fix
		// the handler only compared `c.id` and would skip a PN-addressed
		// contact whose `c.lid` matched `me.lid`.
		const creds = makeCreds()
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [
			{
				id: '5511000000000@s.whatsapp.net', // a PN that is NOT me.id
				lid: ME_LID, // but the LID-side IS me
				username: 'tuoli'
			} as Contact
		])

		expect(creds.me!.username).toBe('tuoli')
		expect(updates).toHaveLength(1)
	})

	it('contacts.update path: same handle logic runs on the partial payload', () => {
		const creds = makeCreds()
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.update', [{ id: ME_ID, username: 'tuoli' }])

		expect(creds.me!.username).toBe('tuoli')
		expect(updates).toHaveLength(1)
	})

	it('mixed batch: only the entry for `me` flips creds, others ignored', () => {
		const creds = makeCreds()
		const ev = makeEv()
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, silentLogger())

		ev.emit('contacts.upsert', [
			{ id: OTHER, username: 'noise1' } as Contact,
			{ id: ME_ID, username: 'tuoli' } as Contact,
			{ id: '5511111111111@s.whatsapp.net', username: 'noise2' } as Contact
		])

		expect(creds.me!.username).toBe('tuoli')
		expect(updates).toHaveLength(1)
	})

	it('no `me` at all: never touches creds (pre-pair phase)', () => {
		const creds = { me: undefined } as unknown as AuthenticationCreds
		const ev = makeEv()
		const warnSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { warn: jest.Mock }).warn = warnSpy
		const updates: Array<Partial<AuthenticationCreds>> = []
		ev.on('creds.update', u => updates.push(u))
		attachMeUsernameSync(ev, creds, logger)

		ev.emit('contacts.upsert', [{ id: ME_ID, username: 'tuoli' } as Contact])

		expect(updates).toHaveLength(0)
	})
})
