/**
 * `WasmEngine` barrel. Re-exports the core class from `./instance` and
 * any future helper modules that want to extend it (`./group-call`,
 * `./video-frames`, etc.). Importers should always go through this
 * barrel — never reach into `./instance` directly.
 */
export { WasmEngine } from './instance'
