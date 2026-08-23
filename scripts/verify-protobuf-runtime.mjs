import { proto } from '../WAProto/index.js'

const input = {
	key: { remoteJid: '5511000000000@s.whatsapp.net', fromMe: true, id: 'PROTO-SMOKE' },
	message: { conversation: 'protobuf runtime smoke test' }
}

const message = proto.WebMessageInfo.fromObject(input)
const wire = proto.WebMessageInfo.encode(message).finish()
const decoded = proto.WebMessageInfo.decode(wire)

if (decoded.key?.id !== input.key.id || decoded.message?.conversation !== input.message.conversation) {
	throw new Error('generated protobuf runtime failed its WebMessageInfo round trip')
}

console.log('Generated protobuf runtime smoke test passed')
