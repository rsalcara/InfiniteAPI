import type { BaileysEventEmitter } from '../Types'
import { jidNormalizedUser } from '../WABinary'
import type { ILogger } from './logger'

interface PromotionRecord {
	/** epoch ms when the account was promoted to admin */
	promotedAt: number
	/** the admin who granted admin to this account */
	promotedBy: string
	/** original (non-normalized) id of the promoted account, for display */
	participantDisplay: string
	/** how many messages the promoted account sent while it was admin */
	messageCount: number
}

export interface AdminAbuseDetectorOptions {
	/**
	 * Window (ms) within which a promotion reversed by a demote/remove of the
	 * same account is treated as the "promote → blast → demote/leave" pattern.
	 */
	windowMs: number
}

/**
 * Detects the "promote → blast → demote/leave" abuse pattern used to spam
 * announcement groups / locked communities, and identifies WHO did it:
 *   - the promoted account that (likely) sent the blast, and
 *   - the admin who promoted it (colluding or compromised).
 *
 * It is purely passive: it subscribes to the same `group-participants.update`
 * and `messages.upsert` events the consumer already receives, keeps a small
 * in-memory map of recent promotions (pruned to `windowMs`), and on a matching
 * demote/remove emits a `[SECURITY]` log + a `security.admin-abuse-suspected`
 * event. It never blocks or mutates anything.
 */
export const attachAdminAbuseDetector = (
	ev: BaileysEventEmitter,
	logger: ILogger,
	{ windowMs }: AdminAbuseDetectorOptions
) => {
	// key: `${normalizedGroupJid}|${normalizedParticipant}`
	const promotions = new Map<string, PromotionRecord>()

	const recordKey = (jid: string, participant: string) =>
		`${jidNormalizedUser(jid) ?? jid}|${jidNormalizedUser(participant) ?? participant}`

	const prune = (now: number) => {
		for (const [k, rec] of promotions) {
			if (now - rec.promotedAt > windowMs) {
				promotions.delete(k)
			}
		}
	}

	ev.on('group-participants.update', ({ id, author, participants, action }) => {
		const now = Date.now()
		prune(now)

		if (action === 'promote') {
			for (const p of participants) {
				promotions.set(recordKey(id, p.id), {
					promotedAt: now,
					promotedBy: author,
					participantDisplay: p.id,
					messageCount: 0
				})
			}
			return
		}

		if (action === 'demote' || action === 'remove') {
			for (const p of participants) {
				const k = recordKey(id, p.id)
				const rec = promotions.get(k)
				if (!rec) {
					continue
				}

				const elapsed = now - rec.promotedAt
				if (elapsed <= windowMs) {
					logger.warn(
						{
							jid: id,
							participant: rec.participantDisplay,
							promotedBy: rec.promotedBy,
							removedBy: author,
							closedBy: action,
							promotedAt: rec.promotedAt,
							closedAt: now,
							windowMs: elapsed,
							messagesDuringWindow: rec.messageCount
						},
						`[SECURITY] promote→${action} abuse pattern in ${id}: ${rec.participantDisplay} was promoted by ${rec.promotedBy}, sent ${rec.messageCount} message(s), then ${action === 'remove' ? 'left/was removed' : 'was demoted'} ${Math.round(elapsed / 1000)}s later`
					)

					ev.emit('security.admin-abuse-suspected', {
						jid: id,
						participant: rec.participantDisplay,
						promotedBy: rec.promotedBy,
						removedBy: author,
						closedBy: action,
						promotedAt: rec.promotedAt,
						closedAt: now,
						windowMs: elapsed,
						messagesDuringWindow: rec.messageCount
					})
				}

				promotions.delete(k)
			}
		}
	})

	// Count messages a currently-promoted account sends while it holds admin, so
	// the emitted event can quantify the blast.
	ev.on('messages.upsert', ({ messages }) => {
		if (!promotions.size) {
			return
		}

		for (const msg of messages) {
			const jid = msg.key?.remoteJid
			const participant = msg.key?.participant
			if (!jid || !participant || msg.key?.fromMe) {
				continue
			}

			const rec = promotions.get(recordKey(jid, participant))
			if (rec) {
				rec.messageCount++
			}
		}
	})
}
