/**
 * Tests for the mex notification re-shapers in
 * `Utils/username-notifications.ts`. These are the bodies behind the
 * three `op_name`s WhatsApp pushes when a handle changes:
 *
 *   UsernameSetNotification     → handleUsernameSetNotification
 *   UsernameDeleteNotification  → handleUsernameDeleteNotification
 *   UsernameUpdateNotification  → handleUsernameSideSubNotification
 *
 * Each function takes `(data, ev, logger)` and emits `contacts.update`
 * — except side-sub, which only logs (no contact-by-hash index).
 *
 * Wire-shape pin (regression for "the WA Web bundle rotated the keys"):
 *   - SET payload key: `xwa2_notify_username_on_change`
 *   - SET payload fields: `username`, `lid`
 *   - DELETE payload key: `xwa2_notify_username_delete`
 *   - DELETE payload fields: `lid`, `display_name?`
 *   - SIDE-SUB payload key: `xwa2_notify_username_on_update_side_sub`
 *
 * The `contacts.update` payload MUST emit `username: null` (not
 * `undefined`) on DELETE so `attachMeUsernameSync` can distinguish
 * "explicitly cleared" from "no opinion".
 */
import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import type { BaileysEventEmitter, Contact } from '../../Types'
import type { ILogger } from '../../Utils/logger'
import {
	handleUsernameDeleteNotification,
	handleUsernameSetNotification,
	handleUsernameSideSubNotification
} from '../../Utils/username-notifications'

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

const ME_LID = '46802258641027@lid'

describe('handleUsernameSetNotification (UsernameSetNotification)', () => {
	it('emits contacts.update with {id: lid, lid, username}', () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const captured: Array<Array<Partial<Contact>>> = []
		ev.on('contacts.update', updates => captured.push(updates))

		handleUsernameSetNotification(
			{ xwa2_notify_username_on_change: { username: 'tuoli', lid: ME_LID } },
			ev,
			silentLogger()
		)

		expect(captured).toHaveLength(1)
		expect(captured[0]).toEqual([{ id: ME_LID, lid: ME_LID, username: 'tuoli' }])
	})

	it('logs and NO-OP on missing payload', () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const updates: unknown[] = []
		ev.on('contacts.update', u => updates.push(u))
		const warnSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { warn: jest.Mock }).warn = warnSpy

		handleUsernameSetNotification({}, ev, logger)
		expect(updates).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledTimes(1)
	})

	it('logs and NO-OP on missing username field', () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const updates: unknown[] = []
		ev.on('contacts.update', u => updates.push(u))
		const warnSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { warn: jest.Mock }).warn = warnSpy

		handleUsernameSetNotification({ xwa2_notify_username_on_change: { lid: ME_LID } }, ev, logger)
		expect(updates).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledTimes(1)
	})

	it('normalizes the LID (strips device suffix)', () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const captured: Array<Array<Partial<Contact>>> = []
		ev.on('contacts.update', updates => captured.push(updates))

		// `:30` is a device suffix — jidNormalizedUser strips it
		handleUsernameSetNotification(
			{ xwa2_notify_username_on_change: { username: 'tuoli', lid: '46802258641027:30@lid' } },
			ev,
			silentLogger()
		)

		expect(captured[0]![0]!.id).toBe('46802258641027@lid')
		expect(captured[0]![0]!.lid).toBe('46802258641027@lid')
	})

	it('rejects non-string lid / username (wire-trust guard)', () => {
		// Regression for the auditor's P2-3 finding. The wire payload
		// could carry numbers / objects / nulls. Type-check both fields
		// so we never emit `contacts.update` with garbage downstream.
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const updates: unknown[] = []
		ev.on('contacts.update', u => updates.push(u))
		const warnSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { warn: jest.Mock }).warn = warnSpy

		// number `lid`
		handleUsernameSetNotification(
			{ xwa2_notify_username_on_change: { username: 'tuoli', lid: 12345 as unknown as string } },
			ev,
			logger
		)
		// object `username`
		handleUsernameSetNotification(
			{ xwa2_notify_username_on_change: { username: { hax: true } as unknown as string, lid: ME_LID } },
			ev,
			logger
		)

		expect(updates).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledTimes(2)
	})
})

describe('handleUsernameDeleteNotification (UsernameDeleteNotification)', () => {
	it('emits contacts.update with username: null (explicit clear)', () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const captured: Array<Array<Partial<Contact>>> = []
		ev.on('contacts.update', updates => captured.push(updates))

		handleUsernameDeleteNotification(
			{ xwa2_notify_username_delete: { lid: ME_LID, display_name: 'Renato Alcará' } },
			ev,
			silentLogger()
		)

		expect(captured).toHaveLength(1)
		const update = captured[0]![0]!
		expect(update.id).toBe(ME_LID)
		expect(update.lid).toBe(ME_LID)
		// `null` matters — `attachMeUsernameSync` uses it to clear
		// `creds.me.username`. `undefined` would be ignored as "no
		// opinion".
		expect(update.username).toBeNull()
		expect(update.name).toBe('Renato Alcará')
	})

	it('omits `name` when display_name is missing', () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const captured: Array<Array<Partial<Contact>>> = []
		ev.on('contacts.update', updates => captured.push(updates))

		handleUsernameDeleteNotification({ xwa2_notify_username_delete: { lid: ME_LID } }, ev, silentLogger())

		const update = captured[0]![0]!
		expect(update.username).toBeNull()
		expect(update.name).toBeUndefined()
	})

	it('logs and NO-OP on missing lid', () => {
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const updates: unknown[] = []
		ev.on('contacts.update', u => updates.push(u))
		const warnSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { warn: jest.Mock }).warn = warnSpy

		handleUsernameDeleteNotification({ xwa2_notify_username_delete: {} }, ev, logger)
		expect(updates).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledTimes(1)
	})

	it('rejects non-string lid and ignores non-string display_name (wire-trust guard)', () => {
		// Regression for the auditor's P2-3 finding.
		const ev = new EventEmitter() as unknown as BaileysEventEmitter
		const updates: Array<Array<Partial<Contact>>> = []
		ev.on('contacts.update', u => updates.push(u))
		const warnSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { warn: jest.Mock }).warn = warnSpy

		// non-string lid → reject entirely
		handleUsernameDeleteNotification({ xwa2_notify_username_delete: { lid: 42 as unknown as string } }, ev, logger)
		expect(updates).toHaveLength(0)
		expect(warnSpy).toHaveBeenCalledTimes(1)

		// non-string display_name → accept (lid is valid) but drop name
		handleUsernameDeleteNotification(
			{ xwa2_notify_username_delete: { lid: ME_LID, display_name: { hax: true } as unknown as string } },
			ev,
			logger
		)
		expect(updates).toHaveLength(1)
		expect(updates[0]![0]!.username).toBeNull()
		expect(updates[0]![0]!.name).toBeUndefined()
	})
})

describe('handleUsernameSideSubNotification (UsernameUpdateNotification)', () => {
	it('logs and does NOT emit (no contact-by-hash index)', () => {
		const infoSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { info: jest.Mock }).info = infoSpy

		handleUsernameSideSubNotification({ xwa2_notify_username_on_update_side_sub: { hash: 'abc123' } }, logger)
		expect(infoSpy).toHaveBeenCalledTimes(1)
		const [ctx, msg] = infoSpy.mock.calls[0]!
		expect(ctx).toEqual({ hash: 'abc123' })
		expect(msg).toMatch(/side-sub.*ignored/i)
	})

	it('logs even on missing payload (degrades gracefully)', () => {
		const infoSpy = jest.fn()
		const logger = silentLogger()
		;(logger as unknown as { info: jest.Mock }).info = infoSpy

		handleUsernameSideSubNotification({}, logger)
		expect(infoSpy).toHaveBeenCalledTimes(1)
	})
})
