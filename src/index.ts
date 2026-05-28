// Install the libsignal log filter BEFORE any other imports so it captures
// console calls from libsignal's first load. Opt-out via env var for
// downstream consumers that want full unfiltered console output.
// Implementation lives in `./Utils/suppress-libsignal-logs`; this is just
// the wiring that preserves the previous default-on behavior.
import { suppressLibsignalLogs } from './Utils/suppress-libsignal-logs'

if (process.env.INFINITEAPI_DISABLE_LIBSIGNAL_LOG_FILTER !== 'true') {
	suppressLibsignalLogs()
}

import makeWASocket, { makeWASocketAutoVersion } from './Socket/index'

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

export default makeWASocket
