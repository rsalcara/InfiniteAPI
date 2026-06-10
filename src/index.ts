// ./prelude MUST be the first import: it installs the libsignal log filter
// as a module side-effect. In native ESM all static imports are evaluated
// before the module body runs, so a call in the body would fire too late
// (libsignal already loaded). The prelude has no Socket dependency, so the
// ESM loader evaluates it — and its filter — before the Socket/index graph.
import './prelude'
import makeWASocket, { makeWASocketAutoVersion } from './Socket/index'
import { suppressLibsignalLogs } from './Utils/suppress-libsignal-logs'

export * from '../WAProto/index.js'
export * from './Utils/index'
export * from './Types/index'
export * from './Defaults/index'
export * from './WABinary/index'
export * from './WAM/index'
export * from './WAUSync/index'

export type WASocket = ReturnType<typeof makeWASocket>
export { makeWASocket, makeWASocketAutoVersion, suppressLibsignalLogs }

// Alias de compatibilidade para zpro.io
// isJidUser é um alias para isPersonJid (mantém retrocompatibilidade)
export { isPersonJid as isJidUser } from './Utils/history'

// VoIP (voice calls) — outbound 1:1 calls via WhatsApp Web's WASM stack.
// Peer deps `@roamhq/wrtc` and `qrcode-terminal` are OPTIONAL — only
// consumers placing voice calls need to install them. `ffmpeg` on PATH is
// also required for MP3/WAV source decoding.
export { VoipClient, ActiveCall, CallState } from './Voip/index'
// audit EXP-01: every public surface type of the VoIP module reachable from
// the root entry. Earlier we only exposed a handful, forcing consumers to
// reach into `lib/Voip/types` for `IncomingCallHandle`, `VideoConfig`, etc.
// — fragile once the package gains an `"exports"` map.
export type {
	AcceptOptions,
	ActiveCallHandle,
	AudioConfig,
	CallEvents,
	CallOptions,
	IncomingCallHandle,
	RelayListUpdate,
	VideoConfig,
	VideoFrame,
	VideoFrameFormat,
	VoipClientEvents,
	VoipIncomingCallEvent,
	VoipSdkConfig,
	VoipSocketLike
} from './Voip/types'

export default makeWASocket
