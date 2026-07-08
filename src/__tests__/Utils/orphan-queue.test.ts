import { OrphanQueue } from '../../Utils/orphan-queue'

const key = (id: string, remoteJid = 'chat@s.whatsapp.net') => ({ remoteJid, id, fromMe: false })

const fakeMessage = (id: string) => ({ key: key(id), message: {} }) as any

describe('OrphanQueue', () => {
	it('drain returns nothing for a parent that was never enqueued', () => {
		const q = new OrphanQueue()
		expect(q.drain(key('never-queued'))).toEqual([])
	})

	it('enqueues and drains a single entry for a parent', () => {
		const q = new OrphanQueue()
		const msg = fakeMessage('dep-1')
		q.enqueue(key('parent-1'), 'revoke', msg)

		const drained = q.drain(key('parent-1'))
		expect(drained).toHaveLength(1)
		expect(drained[0]!.kind).toBe('revoke')
		expect(drained[0]!.message).toBe(msg)
	})

	it('drain removes the entries — a second drain for the same parent is empty', () => {
		const q = new OrphanQueue()
		q.enqueue(key('parent-1'), 'revoke', fakeMessage('dep-1'))

		expect(q.drain(key('parent-1'))).toHaveLength(1)
		expect(q.drain(key('parent-1'))).toEqual([])
	})

	it('accumulates multiple entries (different kinds) for the same still-missing parent', () => {
		const q = new OrphanQueue()
		q.enqueue(key('parent-1'), 'revoke', fakeMessage('dep-1'))
		q.enqueue(key('parent-1'), 'event-response', fakeMessage('dep-2'))

		const drained = q.drain(key('parent-1'))
		expect(drained.map(e => e.kind).sort()).toEqual(['event-response', 'revoke'])
	})

	it('keys by remoteJid+id — same id in a different chat is a different parent', () => {
		const q = new OrphanQueue()
		q.enqueue(key('shared-id', 'chat-a@s.whatsapp.net'), 'revoke', fakeMessage('dep-1'))

		expect(q.drain(key('shared-id', 'chat-b@s.whatsapp.net'))).toEqual([])
		expect(q.drain(key('shared-id', 'chat-a@s.whatsapp.net'))).toHaveLength(1)
	})

	it('caps entries per parent, dropping the oldest on overflow', () => {
		const q = new OrphanQueue()
		for (let i = 0; i < 25; i++) {
			q.enqueue(key('busy-parent'), 'revoke', fakeMessage(`dep-${i}`))
		}

		const drained = q.drain(key('busy-parent'))
		expect(drained.length).toBeLessThanOrEqual(20)
		// oldest entries (dep-0, dep-1, ...) should have been dropped first
		expect(drained[0]!.message.key.id).not.toBe('dep-0')
	})

	it('clear() releases everything pending', () => {
		const q = new OrphanQueue()
		q.enqueue(key('parent-1'), 'revoke', fakeMessage('dep-1'))
		q.enqueue(key('parent-2'), 'event-response', fakeMessage('dep-2'))

		q.clear()

		expect(q.drain(key('parent-1'))).toEqual([])
		expect(q.drain(key('parent-2'))).toEqual([])
	})
})
