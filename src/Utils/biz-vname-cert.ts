import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild } from '../WABinary'

export type BizVNameCert = {
	/** Certificate serial — the value W4B stamps on outbound `<message verified_name>`. */
	serial: string
	verifiedLevel?: string | null
	verifiedName?: string | null
}

/**
 * Build the `sendGetBizVNameCert` IQ exactly as `X/C28989Cmn.A01`:
 * `<iq id xmlns='w:biz' type='get'><verified_name jid='USER'/></iq>`.
 * The app sets no `to` on the IQ — the query layer only adds the id.
 */
export const buildGetBizVNameCertIq = (userJid: string): BinaryNode => ({
	tag: 'iq',
	attrs: {
		type: 'get',
		xmlns: 'w:biz'
	},
	content: [{ tag: 'verified_name', attrs: { jid: userJid } }]
})

/**
 * Parse the `<verified_name …>` response the way `DIX.C7i` case 0 does:
 * require v='1' and a non-null `verified_level`; take `serial` from the Long
 * attribute, overridden by the certificate blob when present
 * (`C26034Bc1` → `C26125Bdi{serial_, issuer_, verifiedName_}`).
 *
 * Scope note: the blob's `signature`/`issuer` are NOT verified — the details
 * are parsed exactly as the server delivered them. What rides the outbound
 * envelope is the serial alone (`verified_name`), so the unverified fields
 * only reach consumers that surface `verifiedName`.
 */
export const parseVerifiedNameNode = (node: BinaryNode): BizVNameCert | undefined => {
	if (node.attrs?.v !== '1') return undefined
	const verifiedLevel = node.attrs.verified_level
	if (!verifiedLevel) return undefined

	let serial = node.attrs.serial ? String(node.attrs.serial) : undefined
	let verifiedName: string | null | undefined

	const content = node.content
	const blob = content instanceof Uint8Array ? content : undefined
	if (blob?.length) {
		try {
			const cert = proto.VerifiedNameCertificate.decode(blob)
			if (cert.details) {
				const details = proto.VerifiedNameCertificate.Details.decode(cert.details)
				// An unset serial decodes as a zero Long (a truthy object): it must
				// never override the stanza attribute the app falls back to.
				const certSerial = details.serial ? details.serial.toString() : undefined
				if (certSerial && certSerial !== '0') {
					serial = certSerial
				}

				verifiedName = details.verifiedName
			}
		} catch {
			// Malformed certificate blob: the app catches the same way (`DIX.java`)
			// and keeps the stanza attribute serial, so the attr value stays.
		}
	}

	if (!serial) return undefined
	return { serial, verifiedLevel, verifiedName }
}

/** Query the server for `userJid`'s verified-name certificate and parse it. */
export const fetchBizVNameCert = async (
	query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>,
	userJid: string
): Promise<BizVNameCert | undefined> => {
	const result = await query(buildGetBizVNameCertIq(userJid))
	const node = getBinaryNodeChild(result, 'verified_name')
	if (!node) {
		throw new Boom('verified_name iq returned no certificate', { data: { userJid } })
	}

	return parseVerifiedNameNode(node)
}
