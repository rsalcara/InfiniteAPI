import { Boom } from '@hapi/boom'
import { proto } from '../../../WAProto/index.js'
import {
	decodeSyncdMutations,
	decodeSyncdPatch,
	decodeSyncdSnapshot,
	isAppStateSyncIrrecoverable,
	isMissingKeyError,
	MAX_SYNC_ATTEMPTS,
	newLTHashState
} from '../../Utils/chat-utils'
import { aesEncrypt } from '../../Utils/crypto'
import { expandAppStateKeys } from '../../Utils/wasm-bridge'

const missingKeyFn = async () => null

describe('App State Sync', () => {
	describe('missing key errors are marked with isMissingKey (Blocked in WA Web)', () => {
		it('decodeSyncdPatch throws with isMissingKey on missing key', async () => {
			const msg: proto.ISyncdPatch = {
				keyId: { id: Buffer.from('missing-key') },
				mutations: [],
				version: { version: 1 as any },
				snapshotMac: Buffer.alloc(32),
				patchMac: Buffer.alloc(32)
			}

			try {
				await decodeSyncdPatch(msg, 'regular_low', newLTHashState(), missingKeyFn, () => {}, true)
				fail('should have thrown')
			} catch (error: any) {
				expect(isMissingKeyError(error)).toBe(true)
			}
		})

		it('decodeSyncdSnapshot throws with isMissingKey on missing snapshot key', async () => {
			const snapshot: proto.ISyncdSnapshot = {
				version: { version: 1 as any },
				records: [],
				keyId: { id: Buffer.from('missing-key') },
				mac: Buffer.alloc(32)
			}

			try {
				await decodeSyncdSnapshot('regular_low', snapshot, missingKeyFn, undefined, true)
				fail('should have thrown')
			} catch (error: any) {
				expect(isMissingKeyError(error)).toBe(true)
			}
		})

		it('decodeSyncdMutations throws with isMissingKey on missing mutation key', async () => {
			const records: proto.ISyncdRecord[] = [
				{
					keyId: { id: Buffer.from('missing-key') },
					value: { blob: Buffer.alloc(64) },
					index: { blob: Buffer.alloc(32) }
				}
			]

			try {
				await decodeSyncdMutations(records, newLTHashState(), missingKeyFn, () => {}, true)
				fail('should have thrown')
			} catch (error: any) {
				expect(isMissingKeyError(error)).toBe(true)
			}
		})

		it('missing key errors are NOT irrecoverable on first attempt', async () => {
			const error = new Boom('missing key', { data: { isMissingKey: true } })
			expect(isMissingKeyError(error)).toBe(true)
			expect(isAppStateSyncIrrecoverable(error, 1)).toBe(false)
		})
	})

	describe('isAppStateSyncIrrecoverable', () => {
		it('should NOT be irrecoverable for status 400 (dead code path removed)', () => {
			expect(isAppStateSyncIrrecoverable(new Boom('test', { statusCode: 400 }), 1)).toBe(false)
		})

		it('should NOT be irrecoverable for status 404 (missing key is Blocked, not Fatal)', () => {
			expect(isAppStateSyncIrrecoverable(new Boom('test', { statusCode: 404 }), 1)).toBe(false)
		})

		it('should NOT be irrecoverable for status 405', () => {
			expect(isAppStateSyncIrrecoverable(new Boom('test', { statusCode: 405 }), 1)).toBe(false)
		})

		it('should NOT be irrecoverable for status 406', () => {
			expect(isAppStateSyncIrrecoverable(new Boom('test', { statusCode: 406 }), 1)).toBe(false)
		})

		it('should be irrecoverable for TypeError', () => {
			expect(isAppStateSyncIrrecoverable(new TypeError('WASM crash'), 1)).toBe(true)
		})

		it('should be irrecoverable when attempts >= MAX_SYNC_ATTEMPTS', () => {
			expect(isAppStateSyncIrrecoverable(new Error('generic'), MAX_SYNC_ATTEMPTS)).toBe(true)
		})

		it('should NOT be irrecoverable for generic error below max attempts', () => {
			expect(isAppStateSyncIrrecoverable(new Error('generic'), 1)).toBe(false)
		})

		it('should NOT be irrecoverable for non-fatal status codes', () => {
			expect(isAppStateSyncIrrecoverable(new Boom('server error', { statusCode: 500 }), 1)).toBe(false)
		})

		it('should handle null/undefined error gracefully', () => {
			expect(isAppStateSyncIrrecoverable(null, MAX_SYNC_ATTEMPTS)).toBe(true)
			expect(isAppStateSyncIrrecoverable(undefined, 1)).toBe(false)
		})
	})

	describe('onRawMutation wiring (Phase 9.7 — sync.db mirror)', () => {
		// validateMacs=false (InfiniteAPI's own default) skips MAC verification,
		// so the index/value MACs below can be arbitrary bytes — only the AES
		// encryption of the value blob needs to be real, since aesDecrypt must
		// actually succeed for decodeSyncdMutations to reach onMutation/onRawMutation.
		const keyData = Buffer.alloc(32, 7)
		const getKey = async () => ({ keyData })

		it('decodeSyncdMutations calls onRawMutation with the decoded mutation + raw MACs', async () => {
			const { valueEncryptionKey } = expandAppStateKeys(keyData)
			const syncAction: proto.ISyncActionData = {
				index: Buffer.from(JSON.stringify(['mute', 'chat@s.whatsapp.net'])),
				value: { muteAction: { muted: true } }
			}
			const plaintext = proto.SyncActionData.encode(syncAction).finish()
			const encrypted = aesEncrypt(Buffer.from(plaintext), valueEncryptionKey)
			const fakeValueMac = Buffer.alloc(32, 9)
			const fakeIndexMac = Buffer.alloc(16, 3)

			const records: proto.ISyncdRecord[] = [
				{
					keyId: { id: Buffer.from('key-1') },
					value: { blob: Buffer.concat([encrypted, fakeValueMac]) },
					index: { blob: fakeIndexMac }
				}
			]

			const rawMutations: any[] = []
			await decodeSyncdMutations(
				records,
				newLTHashState(),
				getKey,
				() => {},
				false,
				raw => rawMutations.push(raw)
			)

			expect(rawMutations).toHaveLength(1)
			expect(rawMutations[0].operation).toBe(proto.SyncdMutation.SyncdOperation.SET)
			expect(Buffer.from(rawMutations[0].indexMac)).toEqual(fakeIndexMac)
			expect(Buffer.from(rawMutations[0].valueMac)).toEqual(fakeValueMac)
			expect(rawMutations[0].mutation.index).toEqual(['mute', 'chat@s.whatsapp.net'])
			expect(rawMutations[0].mutation.syncAction.value?.muteAction?.muted).toBe(true)
		})

		it('decodePatches threads onRawMutation through with the patch version attached', async () => {
			const { valueEncryptionKey } = expandAppStateKeys(keyData)
			const syncAction: proto.ISyncActionData = {
				index: Buffer.from(JSON.stringify(['archive', 'chat@s.whatsapp.net'])),
				value: { archiveChatAction: { archived: true } }
			}
			const plaintext = proto.SyncActionData.encode(syncAction).finish()
			const encrypted = aesEncrypt(Buffer.from(plaintext), valueEncryptionKey)

			const syncd: proto.ISyncdPatch = {
				keyId: { id: Buffer.from('key-1') },
				version: { version: 42 as any },
				mutations: [
					{
						operation: proto.SyncdMutation.SyncdOperation.SET,
						record: {
							keyId: { id: Buffer.from('key-1') },
							value: { blob: Buffer.concat([encrypted, Buffer.alloc(32, 9)]) },
							index: { blob: Buffer.alloc(16, 3) }
						}
					}
				],
				snapshotMac: Buffer.alloc(32),
				patchMac: Buffer.alloc(32)
			}

			const rawMutations: any[] = []
			const { decodePatches } = await import('../../Utils/chat-utils')
			await decodePatches('regular_high', [syncd], newLTHashState(), getKey, {}, undefined, undefined, false, raw =>
				rawMutations.push(raw)
			)

			expect(rawMutations).toHaveLength(1)
			expect(rawMutations[0].version).toBe(42)
			expect(rawMutations[0].mutation.index).toEqual(['archive', 'chat@s.whatsapp.net'])
		})
	})
})
