/**
 * Side-effect module evaluated BEFORE the Socket/libsignal module graph.
 *
 * In native ESM the module body of index.ts runs only after ALL static
 * imports (and their transitive deps) have been evaluated. Placing the
 * suppressLibsignalLogs call in the index.ts body therefore installs the
 * filter too late — libsignal has already loaded. This prelude module has
 * no dependency on Socket/index so the ESM loader evaluates it first,
 * guaranteeing the console filter is active before libsignal initialises.
 *
 * Import order in index.ts must keep `./prelude` as the FIRST static
 * import to preserve this guarantee.
 */
import { suppressLibsignalLogs } from './Utils/suppress-libsignal-logs.js'

if (process.env.INFINITEAPI_DISABLE_LIBSIGNAL_LOG_FILTER !== 'true') {
	suppressLibsignalLogs()
}
