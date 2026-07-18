import type { KeyPair } from '../Types/Auth'

// Internal, non-serialized intent carried by object identity from
// getNextPreKeys()'s transaction cache into the multi-db durable write. A
// WeakSet avoids adding metadata to the cryptographic KeyPair or leaking it
// into signal_kv's BufferJSON representation.
const directDistributionIntents = new WeakSet<object>()

export const markPrekeyDirectDistributionIntent = (key: KeyPair): void => {
	directDistributionIntents.add(key)
}

export const hasPrekeyDirectDistributionIntent = (value: unknown): boolean =>
	typeof value === 'object' && value !== null && directDistributionIntents.has(value)
