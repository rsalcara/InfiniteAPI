/**
 * Regression tests for makeLtHashGenerator REMOVE-without-prevOp silent return.
 *
 * Previously, a REMOVE mutation with no corresponding previous entry would throw
 * a Boom error, causing the entire patch decode to fail. The fix returns silently,
 * allowing the rest of the patch to be processed normally.
 */

import { describe, expect, it, jest, beforeEach } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'

// Mock the wasm-bridge module so tests don't require native binaries
jest.mock('../../Utils/wasm-bridge.js', () => ({
	getLTHashAntiTampering: () => ({
		subtractThenAdd: (_hash: Uint8Array, adds: Uint8Array[], _subs: Uint8Array[]) => {
			// Simple mock: return the first add buffer or original hash
			return adds[0] ?? _hash
		}
	})
}))

import {
	newLTHashState,
	decodeSyncdMutations,
	ensureLTHashStateVersion
} from '../../Utils/chat-utils.js'

describe('LTHashState helpers', () => {
	it('newLTHashState returns a valid initial state', () => {
		const state = newLTHashState()
		expect(state.version).toBe(0)
		expect(state.hash).toBeInstanceOf(Buffer)
		expect(state.hash.length).toBe(128)
		expect(state.indexValueMap).toEqual({})
	})

	it('ensureLTHashStateVersion fixes NaN version', () => {
		const state = { version: NaN, hash: Buffer.alloc(128), indexValueMap: {} }
		const fixed = ensureLTHashStateVersion(state)
		expect(fixed.version).toBe(0)
	})

	it('ensureLTHashStateVersion fixes string version', () => {
		const state = { version: 'bad' as any, hash: Buffer.alloc(128), indexValueMap: {} }
		const fixed = ensureLTHashStateVersion(state)
		expect(fixed.version).toBe(0)
	})

	it('ensureLTHashStateVersion preserves valid version', () => {
		const state = { version: 42, hash: Buffer.alloc(128), indexValueMap: {} }
		const fixed = ensureLTHashStateVersion(state)
		expect(fixed.version).toBe(42)
	})
})

describe('makeLtHashGenerator REMOVE without prevOp', () => {
	it('decodeSyncdMutations does not throw when a REMOVE has no corresponding previous entry', async () => {
		// Build a minimal SyncdRecord for a REMOVE operation with a key not in the index
		const keyId = Buffer.from('test-key-id')
		const indexBlob = Buffer.from(JSON.stringify(['test', 'index']))
		const valueMac = Buffer.alloc(32, 0xab)

		// Construct a REMOVE mutation for an index that has no prior entry
		const mutation: proto.ISyncdMutation = {
			operation: proto.SyncdMutation.SyncdOperation.REMOVE,
			record: {
				index: { blob: indexBlob },
				value: { blob: valueMac },
				keyId: { id: keyId }
			}
		}

		// getCachedAppStateSyncKey that returns a valid key stub
		const mockKeyData = Buffer.alloc(32, 0xff)
		const getKey = async (_keyId: string) => ({
			keyData: mockKeyData
		})

		const initialState = newLTHashState()

		// This should NOT throw even though the REMOVE has no previous op
		// Previously it would throw: 'tried remove, but no previous op'
		await expect(
			decodeSyncdMutations([mutation], initialState, getKey as any, undefined, false)
		).resolves.toBeDefined()
	})
})
