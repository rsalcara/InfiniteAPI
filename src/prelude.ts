/**
 * Side-effect module evaluated BEFORE the Socket/libsignal module graph.
 *
 * In native ESM the module body of index.ts runs only after ALL static
 * imports (and their transitive deps) have been evaluated. Placing the
 * a diagnostics installer call in the index.ts body would therefore run too
 * late — libsignal has already loaded. This prelude module has no dependency
 * on Socket/index so the ESM loader evaluates it first, guaranteeing capture
 * is active before libsignal initialises. The environment flag disables only
 * output filtering, never diagnostic capture.
 *
 * Import order in index.ts must keep `./prelude` as the FIRST static
 * import to preserve this guarantee.
 */
import { installLibsignalDiagnostics } from './Utils/suppress-libsignal-logs.js'

installLibsignalDiagnostics({
	suppressLogs: process.env.INFINITEAPI_DISABLE_LIBSIGNAL_LOG_FILTER !== 'true'
})
