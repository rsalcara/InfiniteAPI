import { canonicalizeReceiptChatJid } from '../../Utils/receipt-jid'

describe('canonicalizeReceiptChatJid', () => {
	it('removes the PN device suffix while leaving the device available to the receipt caller', () => {
		const resolvedPnDevice = '5515991426667:46@s.whatsapp.net'
		const deviceJid = resolvedPnDevice

		expect(canonicalizeReceiptChatJid(resolvedPnDevice)).toBe('5515991426667@s.whatsapp.net')
		expect(deviceJid).toBe('5515991426667:46@s.whatsapp.net')
	})

	it('canonicalizes an unresolved LID device instead of creating a device-scoped chat', () => {
		expect(canonicalizeReceiptChatJid('238315571802285:12@lid')).toBe('238315571802285@lid')
	})
})
