import type { BaileysEventEmitter, GroupParticipant } from '../Types'
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
	/**
	 * Every alias key under which this record is indexed in the
	 * `promotions` Map (group|id, group|lid, group|phoneNumber, …). On
	 * demote/remove we use this list to evict every entry pointing to
	 * the same record in one pass, instead of relying on the demote
	 * event to address the participant on the same alias the promote
	 * used. (audit release #583 review item #5)
	 */
	aliasKeys: string[]
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
 *
 * LID/PN alias handling — `group-participants.update` and the upstream
 * `messages.upsert` may address the same physical user under any of
 * `participant.id` (the addressing the group used), `participant.lid`
 * (the LID counterpart), and `participant.phoneNumber` (the PN
 * counterpart). The detector indexes a record under all aliases known
 * at promote-time AND looks up under all aliases known at
 * demote/upsert-time, so a promote-by-LID + demote-by-PN (common in
 * communities where the group is LID-addressed but admin actions
 * arrive PN-addressed) still correlates.
 */
export const attachAdminAbuseDetector = (
	ev: BaileysEventEmitter,
	logger: ILogger,
	{ windowMs }: AdminAbuseDetectorOptions
) => {
	// key: `${normalizedGroupJid}|${normalizedParticipantAlias}`
	const promotions = new Map<string, PromotionRecord>()

	const normalize = (jid: string) => jidNormalizedUser(jid) || jid

	const recordKey = (jid: string, participant: string) => `${normalize(jid)}|${normalize(participant)}`

	/** Aliases worth indexing for a single participant. */
	const aliasesOf = (p: Pick<GroupParticipant, 'id' | 'lid' | 'phoneNumber'>): string[] => {
		const out = new Set<string>()
		for (const candidate of [p.id, p.lid, p.phoneNumber]) {
			if (candidate) out.add(candidate)
		}

		return [...out]
	}

	const prune = (now: number) => {
		// Group entries by record (same record may live under multiple
		// keys); only prune once per record but evict every key.
		const stale = new Set<PromotionRecord>()
		for (const rec of promotions.values()) {
			if (now - rec.promotedAt > windowMs) {
				stale.add(rec)
			}
		}

		for (const rec of stale) {
			for (const k of rec.aliasKeys) {
				promotions.delete(k)
			}
		}
	}

	ev.on('group-participants.update', ({ id, author, participants, action }) => {
		const now = Date.now()
		prune(now)

		if (action === 'promote') {
			for (const p of participants) {
				const aliasKeys = aliasesOf(p).map(a => recordKey(id, a))
				const rec: PromotionRecord = {
					promotedAt: now,
					promotedBy: author,
					participantDisplay: p.id,
					messageCount: 0,
					aliasKeys
				}
				for (const k of aliasKeys) {
					promotions.set(k, rec)
				}
			}

			return
		}

		if (action === 'demote' || action === 'remove') {
			// Same-record dedupe: a single physical user is indexed
			// under multiple alias keys, so iterating `p` aliases would
			// emit one event per alias if we naively kept finding the
			// same record. Track seen records and emit at most once.
			const seen = new Set<PromotionRecord>()
			for (const p of participants) {
				let rec: PromotionRecord | undefined
				for (const a of aliasesOf(p)) {
					rec = promotions.get(recordKey(id, a))
					if (rec) break
				}

				if (!rec || seen.has(rec)) {
					continue
				}

				seen.add(rec)

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

				// Evict EVERY alias-key for this record — the demote
				// event may have addressed only one alias, but we need
				// to make sure a later messages.upsert under a different
				// alias does not still bump messageCount on a stale rec.
				for (const k of rec.aliasKeys) {
					promotions.delete(k)
				}
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

			// Try `participant` first, then `participantAlt` (the
			// LID/PN counterpart upstream surfaces on the key) — same
			// alias-tolerant lookup as the demote path.
			let rec = promotions.get(recordKey(jid, participant))
			if (!rec && msg.key?.participantAlt) {
				rec = promotions.get(recordKey(jid, msg.key.participantAlt))
			}

			if (rec) {
				rec.messageCount++
			}
		}
	})
}
