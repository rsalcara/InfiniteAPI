/**
 * Unit tests for `attachAdminAbuseDetector`.
 *
 * Validates the "promote → blast → demote/leave" detection contract:
 *   - promote alone (no follow-up) MUST NOT emit
 *   - promote → demote inside the window MUST emit + log
 *   - promote → remove inside the window MUST emit + log
 *   - promote → demote OUTSIDE the window MUST NOT emit
 *   - demote without prior promote MUST NOT emit
 *   - messages.upsert MUST increment `messagesDuringWindow` only while promoted
 *   - the emitted event MUST identify both the promoted account AND the admin
 *     who promoted it
 *
 * The detector is purely passive — it never blocks or mutates events.
 */
import { jest } from '@jest/globals'
import { EventEmitter } from 'node:events'
import type { BaileysEventEmitter } from '../../Types'
import { attachAdminAbuseDetector } from '../../Utils/admin-abuse-detector'
import type { ILogger } from '../../Utils/logger'

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

const GROUP = '120363000000000000@g.us'
const ADMIN = '5511999999991@s.whatsapp.net'
const VICTIM = '5511999999992@s.whatsapp.net'

const makeEv = () => new EventEmitter() as unknown as BaileysEventEmitter

describe('attachAdminAbuseDetector', () => {
	let warnSpy: jest.Mock

	beforeEach(() => {
		jest.useFakeTimers()
		warnSpy = jest.fn()
	})

	afterEach(() => {
		jest.useRealTimers()
	})

	const buildLogger = (): ILogger => {
		const base = silentLogger()
		;(base as unknown as { warn: jest.Mock }).warn = warnSpy
		return base
	}

	it('promote alone (no demote/remove) MUST NOT emit', () => {
		const ev = makeEv()
		const events: unknown[] = []
		ev.on('security.admin-abuse-suspected', e => events.push(e))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM, isAdmin: true }],
			action: 'promote'
		} as never)

		expect(events).toHaveLength(0)
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('promote → demote inside window MUST emit + log', () => {
		const ev = makeEv()
		const events: Array<Record<string, unknown>> = []
		ev.on('security.admin-abuse-suspected', e => events.push(e as Record<string, unknown>))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'promote'
		} as never)

		jest.advanceTimersByTime(30_000) // still inside the 60s window

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'demote'
		} as never)

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			jid: GROUP,
			participant: VICTIM,
			promotedBy: ADMIN,
			removedBy: ADMIN,
			closedBy: 'demote'
		})
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const [warnCtx, warnMsg] = warnSpy.mock.calls[0]!
		expect(warnMsg).toMatch(/\[SECURITY\]/)
		expect(warnCtx).toMatchObject({ jid: GROUP, participant: VICTIM, promotedBy: ADMIN })
	})

	it('promote → remove inside window MUST emit (same as demote)', () => {
		const ev = makeEv()
		const events: Array<Record<string, unknown>> = []
		ev.on('security.admin-abuse-suspected', e => events.push(e as Record<string, unknown>))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'promote'
		} as never)
		jest.advanceTimersByTime(5_000)
		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'remove'
		} as never)

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ closedBy: 'remove' })
	})

	it('promote → demote OUTSIDE window MUST NOT emit', () => {
		const ev = makeEv()
		const events: unknown[] = []
		ev.on('security.admin-abuse-suspected', e => events.push(e))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'promote'
		} as never)

		jest.advanceTimersByTime(90_000) // 30s past the 60s window

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'demote'
		} as never)

		expect(events).toHaveLength(0)
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('demote without prior promote MUST NOT emit', () => {
		const ev = makeEv()
		const events: unknown[] = []
		ev.on('security.admin-abuse-suspected', e => events.push(e))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'demote'
		} as never)

		expect(events).toHaveLength(0)
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('messages.upsert increments messagesDuringWindow only while promoted', () => {
		const ev = makeEv()
		const events: Array<Record<string, unknown>> = []
		ev.on('security.admin-abuse-suspected', e => events.push(e as Record<string, unknown>))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'promote'
		} as never)

		// 3 messages from the promoted account, all while it holds admin
		for (let i = 0; i < 3; i++) {
			ev.emit('messages.upsert', {
				messages: [
					{
						key: { remoteJid: GROUP, participant: VICTIM, fromMe: false, id: `msg-${i}` }
					}
				],
				type: 'notify'
			} as never)
		}

		// 1 message from someone ELSE — must NOT count
		ev.emit('messages.upsert', {
			messages: [
				{
					key: {
						remoteJid: GROUP,
						participant: '5511777777777@s.whatsapp.net',
						fromMe: false,
						id: 'msg-other'
					}
				}
			],
			type: 'notify'
		} as never)

		// 1 message from the promoted account but fromMe — must NOT count
		ev.emit('messages.upsert', {
			messages: [
				{
					key: { remoteJid: GROUP, participant: VICTIM, fromMe: true, id: 'msg-self' }
				}
			],
			type: 'notify'
		} as never)

		// trigger demote — emit captures messagesDuringWindow
		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'demote'
		} as never)

		expect(events).toHaveLength(1)
		expect(events[0]!.messagesDuringWindow).toBe(3)
	})

	it('emits identify BOTH the promoted account AND the promoting admin', () => {
		const PROMOTER = '5511000000001@s.whatsapp.net'
		const ev = makeEv()
		const events: Array<Record<string, unknown>> = []
		ev.on('security.admin-abuse-suspected', e => events.push(e as Record<string, unknown>))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: PROMOTER, // promoted BY this admin
			participants: [{ id: VICTIM }],
			action: 'promote'
		} as never)

		const REMOVER = '5511000000002@s.whatsapp.net' // different admin removed
		ev.emit('group-participants.update', {
			id: GROUP,
			author: REMOVER,
			participants: [{ id: VICTIM }],
			action: 'remove'
		} as never)

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			participant: VICTIM,
			promotedBy: PROMOTER,
			removedBy: REMOVER
		})
	})

	it('after demote the promotion record is cleared (no double-fire)', () => {
		const ev = makeEv()
		const events: unknown[] = []
		ev.on('security.admin-abuse-suspected', e => events.push(e))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'promote'
		} as never)
		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'demote'
		} as never)
		// a second demote — record was already cleared, must NOT fire again
		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'demote'
		} as never)

		expect(events).toHaveLength(1)
	})

	it('pruning: old promotions are dropped after windowMs elapses on next event', () => {
		const ev = makeEv()
		const events: unknown[] = []
		ev.on('security.admin-abuse-suspected', e => events.push(e))
		attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'promote'
		} as never)

		jest.advanceTimersByTime(120_000) // 2× window

		// Another (unrelated) event triggers the prune; then demote VICTIM
		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: '5511000@s.whatsapp.net' }],
			action: 'promote'
		} as never)
		ev.emit('group-participants.update', {
			id: GROUP,
			author: ADMIN,
			participants: [{ id: VICTIM }],
			action: 'demote'
		} as never)

		expect(events).toHaveLength(0)
	})

	describe('LID/PN alias correlation (audit release #583 review #5)', () => {
		// Same physical user; promote arrives addressed by LID, demote
		// by PN (common in communities where the group is LID-addressed
		// but admin actions surface PN-addressed). Detector MUST still
		// correlate the two events as the same person.
		const VICTIM_LID = '4001@lid'
		const VICTIM_PN = '5511777000@s.whatsapp.net'

		it('promote (by LID) → demote (by PN) on the same record correlates and emits', () => {
			const ev = makeEv()
			const events: Array<Record<string, unknown>> = []
			ev.on('security.admin-abuse-suspected', e => events.push(e as Record<string, unknown>))
			attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

			// Promote indexed under BOTH `id` and `phoneNumber` aliases
			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_LID, phoneNumber: VICTIM_PN }],
				action: 'promote'
			} as never)
			jest.advanceTimersByTime(5_000)
			// Demote arrives addressed by PN ONLY — must still match
			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_PN }],
				action: 'demote'
			} as never)

			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ participant: VICTIM_LID })
		})

		it('messages.upsert under PN counts toward a promotion indexed under LID', () => {
			const ev = makeEv()
			const events: Array<Record<string, unknown>> = []
			ev.on('security.admin-abuse-suspected', e => events.push(e as Record<string, unknown>))
			attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_LID, phoneNumber: VICTIM_PN }],
				action: 'promote'
			} as never)

			// Two messages, both addressed via PN even though the
			// promotion was by LID
			for (let i = 0; i < 2; i++) {
				ev.emit('messages.upsert', {
					messages: [{ key: { remoteJid: GROUP, participant: VICTIM_PN, fromMe: false, id: `m${i}` } }],
					type: 'notify'
				} as never)
			}

			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_LID }],
				action: 'demote'
			} as never)

			expect(events).toHaveLength(1)
			expect(events[0]!.messagesDuringWindow).toBe(2)
		})

		it('messages.upsert that addresses by `participantAlt` counts (LID/PN counterpart key)', () => {
			const ev = makeEv()
			const events: Array<Record<string, unknown>> = []
			ev.on('security.admin-abuse-suspected', e => events.push(e as Record<string, unknown>))
			attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_LID }], // ONLY LID indexed
				action: 'promote'
			} as never)

			// message addressed by an unrelated PN as `participant`,
			// but `participantAlt` carries the LID we promoted under
			ev.emit('messages.upsert', {
				messages: [
					{
						key: {
							remoteJid: GROUP,
							participant: VICTIM_PN, // unrelated to record
							participantAlt: VICTIM_LID, // matches!
							fromMe: false,
							id: 'm-alt'
						}
					}
				],
				type: 'notify'
			} as never)

			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_LID }],
				action: 'demote'
			} as never)

			expect(events).toHaveLength(1)
			expect(events[0]!.messagesDuringWindow).toBe(1)
		})

		it('demote dedupes the SAME record across multiple aliases (no double-emit)', () => {
			const ev = makeEv()
			const events: unknown[] = []
			ev.on('security.admin-abuse-suspected', e => events.push(e))
			attachAdminAbuseDetector(ev, buildLogger(), { windowMs: 60_000 })

			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_LID, phoneNumber: VICTIM_PN }],
				action: 'promote'
			} as never)
			// Pathological: demote payload lists the SAME user twice,
			// once per alias. Must emit ONE event, not two.
			ev.emit('group-participants.update', {
				id: GROUP,
				author: ADMIN,
				participants: [{ id: VICTIM_LID }, { id: VICTIM_PN }],
				action: 'demote'
			} as never)

			expect(events).toHaveLength(1)
		})
	})
})
