import { jidNormalizedUser } from '../WABinary'

/**
 * Android keys a 1:1 chat by the bare user JID and stores the originating
 * device separately in receipt_device.
 */
export const canonicalizeReceiptChatJid = (jid: string): string => jidNormalizedUser(jid) || jid
