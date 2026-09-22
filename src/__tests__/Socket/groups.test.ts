/* eslint-disable @typescript-eslint/no-explicit-any */
import { extractGroupMetadata } from '../../Socket/groups'
import type { BinaryNode } from '../../WABinary'

const makeGroupNode = (overrides: { attrs?: Record<string, string>; children?: BinaryNode[] }): BinaryNode => ({
	tag: 'group',
	attrs: { id: '123456789@g.us', subject: 'Test Group', ...overrides.attrs },
	content: overrides.children
})

const makeResult = (group: BinaryNode): BinaryNode => ({
	tag: 'iq',
	attrs: {},
	content: [group]
})

describe('extractGroupMetadata — tri-state parsing', () => {
	const cases: {
		field: string
		positive: string
		negative: string
	}[] = [
		{ field: 'noFrequentlyForwarded', positive: 'no_frequently_forwarded', negative: 'frequently_forwarded' },
		{ field: 'allowAdminReports', positive: 'allow_admin_reports', negative: 'not_allow_admin_reports' },
		{ field: 'groupHistoryVisible', positive: 'group_history', negative: 'no_group_history' },
		{ field: 'limitSharingEnabled', positive: 'limit_sharing_enabled', negative: 'limit_sharing_disabled' },
		{ field: 'growthLocked', positive: 'growth_locked', negative: 'growth_unlocked' }
	]

	for (const { field, positive, negative } of cases) {
		it(`${field}: positive tag -> true`, () => {
			const meta = extractGroupMetadata(makeResult(makeGroupNode({ children: [{ tag: positive, attrs: {} }] }))) as any
			expect(meta[field]).toBe(true)
		})

		it(`${field}: negative tag -> false`, () => {
			const meta = extractGroupMetadata(makeResult(makeGroupNode({ children: [{ tag: negative, attrs: {} }] }))) as any
			expect(meta[field]).toBe(false)
		})

		it(`${field}: neither tag -> undefined`, () => {
			const meta = extractGroupMetadata(makeResult(makeGroupNode({}))) as any
			expect(meta[field]).toBeUndefined()
		})
	}
})

describe('extractGroupMetadata — memberShareHistoryMode', () => {
	it('retained -> "retained"', () => {
		const meta = extractGroupMetadata(
			makeResult(
				makeGroupNode({
					children: [{ tag: 'member_share_group_history_mode', attrs: {}, content: 'retained' }]
				})
			)
		) as any
		expect(meta.memberShareHistoryMode).toBe('retained')
	})

	it('unavailable -> "unavailable"', () => {
		const meta = extractGroupMetadata(
			makeResult(
				makeGroupNode({
					children: [{ tag: 'member_share_group_history_mode', attrs: {}, content: 'unavailable' }]
				})
			)
		) as any
		expect(meta.memberShareHistoryMode).toBe('unavailable')
	})

	it('absent -> undefined', () => {
		const meta = extractGroupMetadata(makeResult(makeGroupNode({}))) as any
		expect(meta.memberShareHistoryMode).toBeUndefined()
	})
})

describe('extractGroupMetadata — existing fields', () => {
	it('parses subject, id, creation, addressing mode', () => {
		const meta = extractGroupMetadata(
			makeResult(
				makeGroupNode({
					attrs: {
						id: '123456789',
						subject: 'My Group',
						creation: '1700000000',
						addressing_mode: 'lid'
					}
				})
			)
		)
		expect(meta.id).toBe('123456789@g.us')
		expect(meta.subject).toBe('My Group')
		expect(meta.creation).toBe(1700000000)
		expect(meta.addressingMode).toBe('lid')
	})

	it('parses participants with admin types', () => {
		const meta = extractGroupMetadata(
			makeResult(
				makeGroupNode({
					children: [
						{ tag: 'participant', attrs: { jid: '5511000000001@s.whatsapp.net', type: 'admin' } },
						{ tag: 'participant', attrs: { jid: '5511000000002@s.whatsapp.net', type: 'superadmin' } },
						{ tag: 'participant', attrs: { jid: '5511000000003@s.whatsapp.net' } }
					]
				})
			)
		)
		expect(meta.participants).toHaveLength(3)
		expect(meta.participants[0]!.admin).toBe('admin')
		expect(meta.participants[1]!.admin).toBe('superadmin')
		expect(meta.participants[2]!.admin).toBeNull()
	})

	it('throws Boom on error node', () => {
		const result: BinaryNode = {
			tag: 'iq',
			attrs: {},
			content: [{ tag: 'error', attrs: { code: '403', text: 'not authorized' } }]
		}
		expect(() => extractGroupMetadata(result)).toThrow('not authorized')
	})

	it('throws Boom on missing group node', () => {
		const result: BinaryNode = { tag: 'iq', attrs: {}, content: [] }
		expect(() => extractGroupMetadata(result)).toThrow('missing <group> node')
	})
})
