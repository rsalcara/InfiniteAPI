import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { aesDecryptGCM, aesEncryptGCM, hmacSign } from './crypto'

const AES_IV_LENGTH = 12
const MESSAGE_SECRET_LENGTH = 32

export type MessageSecretEnvelopeContext = {
	/** Raw user (without device/domain) of the author of the parent message. */
	targetAuthorRaw: string
	/** Raw user of the sender of the dependent envelope. */
	senderRaw: string
	/** Client-visible ID of the parent message. */
	targetMessageId: string
}

/**
 * Reproduces Android's `MessageSecretCryptoHelper` derivation:
 *
 * base = HMAC-SHA256(key = 0x00 * 32, input = secret)
 * key  = HKDF-Expand-SHA256(base, targetId || targetAuthor || sender || purpose || 0x01, 32)
 *
 * Android's helper uses HMAC-SHA256 as the PRF and a single 32-byte output block,
 * which is exactly this two-step construction. Poll votes and event responses use
 * the same shape and those paths predate this helper.
 */
export const deriveMessageSecretKey = (
	messageSecret: Uint8Array,
	purpose: 'Enc Comment' | 'Enc Reaction',
	{ targetAuthorRaw, senderRaw, targetMessageId }: MessageSecretEnvelopeContext
): Buffer => {
	assertMessageSecret(messageSecret)
	const base = hmacSign(messageSecret, new Uint8Array(MESSAGE_SECRET_LENGTH), 'sha256')
	const info = Buffer.concat([
		Buffer.from(targetMessageId, 'utf8'),
		Buffer.from(targetAuthorRaw, 'utf8'),
		Buffer.from(senderRaw, 'utf8'),
		Buffer.from(purpose, 'utf8'),
		Buffer.from([1])
	])
	return hmacSign(info, base, 'sha256')
}

export const assertMessageSecret = (messageSecret: Uint8Array | undefined | null): void => {
	if (messageSecret?.length !== MESSAGE_SECRET_LENGTH) {
		throw new Boom('parentMessageSecret must be a 32-byte messageContextInfo.messageSecret', { statusCode: 400 })
	}
}

export const requireRawUser = (jid: string): string => {
	const raw = jid.split('@')[0]
	if (!raw) throw new Boom('Message-secret identity has no raw user', { statusCode: 400 })
	return raw
}

export const encryptWithMessageSecretKey = (plaintext: Uint8Array, key: Uint8Array) => {
	const iv = randomBytes(AES_IV_LENGTH)
	// FE9.ASx() is null for both "Enc Comment" and "Enc Reaction": these
	// envelopes carry no additional authenticated data.
	return { iv, payload: aesEncryptGCM(plaintext, key, iv, new Uint8Array(0)) }
}

export const decryptWithMessageSecretKey = (ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array) =>
	aesDecryptGCM(ciphertext, key, iv, new Uint8Array(0))

const assertEncIv = (iv: Uint8Array | undefined | null): iv is Uint8Array => {
	if (iv?.length !== AES_IV_LENGTH) {
		throw new Boom('encrypted message-secret envelope requires a 12-byte IV', { statusCode: 400 })
	}

	return true
}

/** Android decodes an E2E.Message and reads `commentMessage`; not a bare comment. */
export const decryptEncComment = (
	envelope: proto.Message.IEncCommentMessage,
	key: Uint8Array
): proto.Message.ICommentMessage => {
	if (!envelope.encPayload || !envelope.encIv) {
		throw new Boom('encCommentMessage requires encPayload and encIv', { statusCode: 400 })
	}

	assertEncIv(envelope.encIv)
	const plaintext = decryptWithMessageSecretKey(envelope.encPayload, key, envelope.encIv)
	const outer = proto.Message.decode(plaintext)
	if (!outer.commentMessage) {
		throw new Boom('decrypted comment envelope does not contain commentMessage', { statusCode: 400 })
	}

	return outer.commentMessage
}

/** Unlike comments, Android stores a bare ReactionMessage in this envelope. */
export const decryptEncReaction = (
	envelope: proto.Message.IEncReactionMessage,
	key: Uint8Array
): proto.Message.IReactionMessage => {
	if (!envelope.encPayload || !envelope.encIv) {
		throw new Boom('encReactionMessage requires encPayload and encIv', { statusCode: 400 })
	}

	assertEncIv(envelope.encIv)
	return proto.Message.ReactionMessage.decode(decryptWithMessageSecretKey(envelope.encPayload, key, envelope.encIv))
}
