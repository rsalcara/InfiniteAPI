import { proto } from '../../../WAProto/index.js'
import { parseVerifiedNameNode } from '../../Utils/biz-vname-cert'
import type { BinaryNode } from '../../WABinary'

const detailsBlob = (details: Record<string, unknown>): Uint8Array =>
	proto.VerifiedNameCertificate.encode({
		details: proto.VerifiedNameCertificate.Details.encode(details as never).finish()
	} as never).finish()

const certNode = (attrs: Record<string, string>, content?: Uint8Array): BinaryNode => ({
	tag: 'verified_name',
	attrs,
	content
})

describe('parseVerifiedNameNode (DIX.C7i case 0)', () => {
	it('takes the serial from the certificate blob and carries the verified name', () => {
		const node = certNode(
			{ v: '1', verified_level: 'UNKNOWN', serial: '111' },
			detailsBlob({
				serial: 456,
				verifiedName: 'Acme'
			})
		)

		expect(parseVerifiedNameNode(node)).toEqual({
			serial: '456',
			verifiedLevel: 'UNKNOWN',
			verifiedName: 'Acme'
		})
	})

	it('keeps the stanza attribute serial when the blob is malformed', () => {
		// Truncated length-delimited field: the decoder throws. The app catches
		// (`DIX.java`) and falls back to the attribute serial — a bad blob must
		// never take the whole send path down.
		const node = certNode({ v: '1', verified_level: 'UNKNOWN', serial: '111' }, new Uint8Array([0x0a, 0xff]))

		expect(parseVerifiedNameNode(node)).toEqual({
			serial: '111',
			verifiedLevel: 'UNKNOWN',
			verifiedName: undefined
		})
	})

	it('never lets an unset blob serial override the attribute serial', () => {
		// An absent int64 decodes as a zero Long — a truthy object whose
		// toString() is '0'. That is not a serial.
		const node = certNode(
			{ v: '1', verified_level: 'UNKNOWN', serial: '111' },
			detailsBlob({
				verifiedName: 'Acme'
			})
		)

		expect(parseVerifiedNameNode(node)).toMatchObject({ serial: '111', verifiedName: 'Acme' })
	})

	it('uses the attribute serial when there is no blob', () => {
		const node = certNode({ v: '1', verified_level: 'UNKNOWN', serial: '111' })

		expect(parseVerifiedNameNode(node)).toEqual({
			serial: '111',
			verifiedLevel: 'UNKNOWN',
			verifiedName: undefined
		})
	})

	it('requires v=1 and a verified_level', () => {
		expect(parseVerifiedNameNode(certNode({ v: '2', verified_level: 'UNKNOWN', serial: '111' }))).toBeUndefined()
		expect(parseVerifiedNameNode(certNode({ v: '1', serial: '111' }))).toBeUndefined()
	})
})
