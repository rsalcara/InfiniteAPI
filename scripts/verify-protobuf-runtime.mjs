import { proto } from '../WAProto/index.js'

const input = {
	key: { remoteJid: '5511000000000@s.whatsapp.net', fromMe: true, id: 'PROTO-SMOKE' },
	message: { imageMessage: { caption: 'protobuf runtime smoke test', fileLength: 42 } }
}

const message = proto.WebMessageInfo.fromObject(input)
message.message.imageMessage.fileLength = '1234567890123456789'
const json = proto.WebMessageInfo.toObject(message, { longs: String })
const wire = proto.WebMessageInfo.encode(message).finish()
const decoded = proto.WebMessageInfo.decode(wire)
const decodedJson = proto.WebMessageInfo.toObject(decoded, { longs: String })

if (
	json.message?.imageMessage?.fileLength !== '1234567890123456789' ||
	decodedJson.message?.imageMessage?.fileLength !== '1234567890123456789' ||
	decoded.key?.remoteJid !== input.key.remoteJid ||
	decoded.key?.fromMe !== input.key.fromMe ||
	decoded.key?.id !== input.key.id ||
	decoded.message?.imageMessage?.caption !== input.message.imageMessage.caption
) {
	throw new Error('generated protobuf runtime failed its WebMessageInfo round trip')
}

console.log('Generated protobuf runtime smoke test passed')
