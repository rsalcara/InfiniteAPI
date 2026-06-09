/**
 * `SignalingBridge` barrel. Mirrors the wasm-engine layout — importers
 * use `from './signaling'`, never `from './signaling/bridge'` directly.
 */
export { SignalingBridge } from './bridge'
