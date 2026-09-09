import { makeLockManager } from '../../Utils/lock-manager'
import { TcTokenAckEligibilityIndex } from '../../Utils/tc-token-utils'

describe('TcTokenAckEligibilityIndex', () => {
	it('consumes PN and LID aliases atomically after the first server ACK', () => {
		const index = new TcTokenAckEligibilityIndex()
		const pn = '5511999999999@s.whatsapp.net'
		const lid = '100000000000001@lid'

		index.remember([pn, lid], 'MESSAGE-1', lid)

		expect(index.consume([pn], 'MESSAGE-1')).toBe(lid)
		expect(index.consume([lid], 'MESSAGE-1')).toBeUndefined()
	})

	it('claims eligibility atomically and releases it after a failed durable enqueue', () => {
		const index = new TcTokenAckEligibilityIndex()
		const jid = '5511999999999@s.whatsapp.net'

		index.remember([jid], 'MESSAGE-1', jid)

		expect(index.claim([jid], 'MESSAGE-1')).toBe(jid)
		expect(index.claim([jid], 'MESSAGE-1')).toBeUndefined()
		index.release([jid], 'MESSAGE-1')
		expect(index.claim([jid], 'MESSAGE-1')).toBe(jid)
		expect(index.consume([jid], 'MESSAGE-1')).toBe(jid)
		expect(index.claim([jid], 'MESSAGE-1')).toBeUndefined()
	})

	it('lets a queued duplicate ACK retry after the first durable enqueue fails', async () => {
		const index = new TcTokenAckEligibilityIndex()
		const locks = makeLockManager()
		const jid = '5511999999999@s.whatsapp.net'
		const id = 'MESSAGE-1'
		const ref = { namespace: '__tc_token_ack__', id }
		let attempts = 0
		let releaseFirst!: () => void
		const firstAttemptStarted = new Promise<void>(resolve => {
			releaseFirst = resolve
		})
		let allowFirstToFail!: () => void
		const firstAttemptBlocked = new Promise<void>(resolve => {
			allowFirstToFail = resolve
		})
		index.remember([jid], id, jid)

		const processAck = () =>
			locks.withLock(ref, async () => {
				const eligibleJid = index.claim([jid], id)
				if (!eligibleJid) return

				attempts++
				try {
					if (attempts === 1) {
						releaseFirst()
						await firstAttemptBlocked
						throw new Error('temporary store failure')
					}

					index.consume([jid], id)
				} catch {
					index.release([jid], id)
				}
			})

		const first = processAck()
		await firstAttemptStarted
		const duplicate = processAck()
		allowFirstToFail()
		await Promise.all([first, duplicate])

		expect(attempts).toBe(2)
		expect(index.claim([jid], id)).toBeUndefined()
	})

	it('expires entries and discards failed transmissions', () => {
		let now = 1_000
		const index = new TcTokenAckEligibilityIndex(() => now, 100)
		const jid = '5511999999999@s.whatsapp.net'

		index.remember([jid], 'EXPIRED', jid)
		now = 1_101
		expect(index.consume([jid], 'EXPIRED')).toBeUndefined()

		index.remember([jid], 'FAILED', jid)
		index.discard([jid], 'FAILED')
		expect(index.consume([jid], 'FAILED')).toBeUndefined()
	})

	it('evicts complete alias groups when the bounded index is full', () => {
		const index = new TcTokenAckEligibilityIndex(Date.now, 60_000, 2)
		const firstPn = '5511000000001@s.whatsapp.net'
		const firstLid = '100000000000001@lid'
		const second = '5511000000002@s.whatsapp.net'

		index.remember([firstPn, firstLid], 'FIRST', firstLid)
		index.remember([second], 'SECOND', second)

		expect(index.consume([firstPn, firstLid], 'FIRST')).toBeUndefined()
		expect(index.consume([second], 'SECOND')).toBe(second)
	})
})
