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

export default makeWASocket
