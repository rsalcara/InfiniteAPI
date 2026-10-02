import { jest } from '@jest/globals'
import { createHmac } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import type { BaileysEventEmitter, ChatMutation } from '../../Types'
import { abPropsRequestAttrs, applyAbPropsResponse, isAbPropEnabled, readAbPropsResponse } from '../../Utils/ab-props'
import { isMissingKeyError, processSyncAction } from '../../Utils/chat-utils'
import { aesEncrypt } from '../../Utils/crypto'
import { BufferJSON } from '../../Utils/generics'
import { processHistoryMessage } from '../../Utils/history'
import {
	buildCsTokenNode,
	buildNctSaltSnapshotQuery,
	computeCsToken,
	findNctSaltInSnapshot,
	NCT_TOKEN_AB_PROP,
	resolveCsTokenMode
} from '../../Utils/nct-token'
import { emitProcessedHistorySync } from '../../Utils/process-message'
import { expandAppStateKeys } from '../../Utils/wasm-bridge'
import { S_WHATSAPP_NET } from '../../WABinary'

const salt = Buffer.alloc(32, 3)
const recipient = '127496221651050@lid'

const makeEv = () => {
	const emitted: Array<{ event: string; data: { nctSalt?: Uint8Array } & Record<string, unknown> }> = []
	const ev = {
		emit: jest.fn((event: string, data: unknown) => {
			emitted.push({ event, data: data as { nctSalt?: Uint8Array } & Record<string, unknown> })
			return true
		})
	} as unknown as BaileysEventEmitter
	return { ev, emitted }
}

describe('NCT cstoken', () => {
	it('is HMAC-SHA256 keyed by the salt over the UTF-8 recipient JID', () => {
		const expected = createHmac('sha256', salt).update(Buffer.from(recipient, 'utf8')).digest()
		expect(computeCsToken(salt, recipient).equals(expected)).toBe(true)
	})

	it('defaults to the app gate on native Android and to the salt alone on web', () => {
		expect(resolveCsTokenMode('native_android')).toBe('ab-prop')
		expect(resolveCsTokenMode('web')).toBe('salt')
		expect(resolveCsTokenMode('web', 'off')).toBe('off')
	})

	it('signs only a recipient LID, without device, and honours the mode', () => {
		const on = { [NCT_TOKEN_AB_PROP]: 'true' }
		const node = { tag: 'cstoken', attrs: {}, content: computeCsToken(salt, recipient) }
		expect(buildCsTokenNode(recipient, salt, 'salt', undefined)).toEqual(node)
		expect(buildCsTokenNode('127496221651050:12@lid', salt, 'salt', undefined)).toEqual(node)
		expect(buildCsTokenNode(recipient, salt, 'ab-prop', on)).toEqual(node)
		expect(buildCsTokenNode(recipient, salt, 'ab-prop', { [NCT_TOKEN_AB_PROP]: '1' })).toBeDefined()
		expect(buildCsTokenNode(recipient, salt, 'ab-prop', { [NCT_TOKEN_AB_PROP]: 'false' })).toBeUndefined()
		expect(buildCsTokenNode(recipient, salt, 'ab-prop', undefined)).toBeUndefined()
		expect(buildCsTokenNode(recipient, salt, 'off', on)).toBeUndefined()
		expect(buildCsTokenNode(recipient, undefined, 'salt', on)).toBeUndefined()
		expect(buildCsTokenNode(recipient, new Uint8Array(), 'salt', on)).toBeUndefined()
		// PN, bot and empty recipients: no LID to sign.
		expect(buildCsTokenNode('5511000000002@s.whatsapp.net', salt, 'salt', on)).toBeUndefined()
		expect(buildCsTokenNode('718584497008509@bot', salt, 'salt', on)).toBeUndefined()
		expect(buildCsTokenNode(null, salt, 'salt', on)).toBeUndefined()
	})
})

describe('NCT salt backfill from regular_high', () => {
	const keyData = Buffer.alloc(32, 5)
	const getKey = async () => ({ keyData })

	const record = (index: string[], value: proto.ISyncActionValue): proto.ISyncdRecord => {
		const { valueEncryptionKey } = expandAppStateKeys(keyData)
		const plaintext = proto.SyncActionData.encode({ index: Buffer.from(JSON.stringify(index)), value }).finish()
		const encrypted = aesEncrypt(Buffer.from(plaintext), valueEncryptionKey)
		return {
			keyId: { id: Buffer.from('key-1') },
			value: { blob: Buffer.concat([encrypted, Buffer.alloc(32, 9)]) },
			index: { blob: Buffer.from(JSON.stringify(index)).subarray(0, 16) }
		}
	}

	const snapshot = (records: proto.ISyncdRecord[]): proto.ISyncdSnapshot => ({
		version: { version: 7 },
		records,
		keyId: { id: Buffer.from('key-1') },
		mac: Buffer.alloc(32)
	})

	it('asks for a regular_high snapshot at the stored version', () => {
		expect(buildNctSaltSnapshotQuery(42)).toEqual({
			tag: 'iq',
			attrs: { to: S_WHATSAPP_NET, xmlns: 'w:sync:app:state', type: 'set' },
			content: [
				{
					tag: 'sync',
					attrs: {},
					content: [{ tag: 'collection', attrs: { name: 'regular_high', version: '42', return_snapshot: 'true' } }]
				}
			]
		})
	})

	it('reads only the nct_salt_sync record of the snapshot', async () => {
		const found = await findNctSaltInSnapshot(
			snapshot([
				record(['mute', 'chat@s.whatsapp.net'], { muteAction: { muted: true } }),
				record(['nct_salt_sync'], { nctSaltSyncAction: { salt } }),
				record(['deleteChat', 'other@s.whatsapp.net'], { deleteChatAction: {} })
			]),
			getKey,
			false
		)
		expect(Buffer.from(found!).equals(salt)).toBe(true)
	})

	it('returns nothing for an account without a salt', async () => {
		const found = await findNctSaltInSnapshot(
			snapshot([record(['mute', 'chat@s.whatsapp.net'], { muteAction: { muted: true } })]),
			getKey,
			false
		)
		expect(found).toBeUndefined()
	})

	it('surfaces a missing app-state key so the backfill retries on the next connection', async () => {
		const error = await findNctSaltInSnapshot(
			snapshot([record(['nct_salt_sync'], { nctSaltSyncAction: { salt } })]),
			async () => null,
			true
		).catch(err => err)
		expect(isMissingKeyError(error)).toBe(true)
	})
})

describe('applyAbPropsResponse (ABPropsManager semantics)', () => {
	const stored = { '24941': 'false', '100': 'x' }

	it('replaces the stored set when the response carries a hash', () => {
		expect(applyAbPropsResponse(stored, { hash: 'h2', deltaUpdate: false, props: { '24941': 'true' } })).toEqual({
			'24941': 'true'
		})
	})

	it('merges a delta update into the stored set', () => {
		expect(applyAbPropsResponse(stored, { hash: 'h2', deltaUpdate: true, props: { '24941': 'true' } })).toEqual({
			'24941': 'true',
			'100': 'x'
		})
	})

	it('keeps the stored set when the server reports no change', () => {
		expect(applyAbPropsResponse(stored, { deltaUpdate: false, props: {} })).toBe(stored)
		expect(isAbPropEnabled(applyAbPropsResponse(undefined, { deltaUpdate: false, props: {} }), '24941')).toBe(false)
	})

	const persisted = { tracked: ['24941'], values: { '24941': 'false' } }
	const fullResponse = {
		tag: 'props',
		attrs: { protocol: '1', hash: 'h2' },
		content: [
			{ tag: 'prop', attrs: { config_code: '24941', config_value: 'true' } },
			{ tag: 'prop', attrs: { config_code: '100', config_value: 'a long untracked value' } }
		]
	}

	it('asks for changes since the hash only when the stored props cover every tracked code', () => {
		// Sessions that kept only the hash (before props were stored) must get the full set back.
		expect(abPropsRequestAttrs({ lastPropHash: 'h1', abProps: undefined })).toEqual({ protocol: '1' })
		expect(abPropsRequestAttrs({ lastPropHash: undefined, abProps: persisted })).toEqual({ protocol: '1' })
		expect(abPropsRequestAttrs({ lastPropHash: 'h1', abProps: persisted })).toEqual({ protocol: '1', hash: 'h1' })
		// A newly tracked code is missing from what was stored: full fetch again.
		expect(abPropsRequestAttrs({ lastPropHash: 'h1', abProps: persisted }, ['24941', '24915'])).toEqual({
			protocol: '1'
		})
	})

	it('persists the hash and only the tracked props of a full response', () => {
		const response = readAbPropsResponse({ abProps: undefined }, fullResponse, { requestedHash: false })
		expect(response.received).toBe(2)
		expect(response.update).toEqual({
			lastPropHash: 'h2',
			abProps: { tracked: ['24941'], values: { '24941': 'true' } }
		})
		expect(isAbPropEnabled(response.abProps, NCT_TOKEN_AB_PROP)).toBe(true)
	})

	it('merges a delta response into the stored tracked props', () => {
		const response = readAbPropsResponse(
			{ abProps: { tracked: ['24941', '24915'], values: { '24941': 'false', '24915': 'true' } } },
			{
				tag: 'props',
				attrs: { protocol: '1', hash: 'h3', delta_update: 'true' },
				content: [{ tag: 'prop', attrs: { config_code: '24941', config_value: 'true' } }]
			},
			{ requestedHash: true, tracked: ['24941', '24915'] }
		)
		expect(response.update?.abProps?.values).toEqual({ '24941': 'true', '24915': 'true' })
	})

	it('keeps a full set the server sent without a hash when the query had none', () => {
		// The app always asks with a hash, so "no hash" means "unchanged" there.
		// A query without a hash has nothing to be unchanged from.
		const attrs = { protocol: fullResponse.attrs.protocol }
		const response = readAbPropsResponse({ abProps: undefined }, { ...fullResponse, attrs }, { requestedHash: false })
		expect(response.update).toEqual({ abProps: { tracked: ['24941'], values: { '24941': 'true' } } })
		// An empty answer to that query carries nothing to store.
		expect(
			readAbPropsResponse(
				{ abProps: undefined },
				{ tag: 'props', attrs: { protocol: '1' }, content: [] },
				{ requestedHash: false }
			).update
		).toBeUndefined()
	})

	it('survives the BufferJSON round trip every auth state uses for creds', () => {
		// The reviver turns all-numeric-key objects with numeric values into
		// Buffers; prop values are strings, so `values` must stay an object.
		const creds = { abProps: { tracked: ['24941'], values: { '24941': 'true' } }, nctSalt: salt }
		const restored = JSON.parse(JSON.stringify(creds, BufferJSON.replacer), BufferJSON.reviver)
		expect(restored.abProps).toEqual(creds.abProps)
		expect(Buffer.isBuffer(restored.nctSalt) && restored.nctSalt.equals(salt)).toBe(true)
	})

	it('persists nothing when the server reports no change', () => {
		const response = readAbPropsResponse(
			{ abProps: persisted },
			{ tag: 'props', attrs: { protocol: '1' }, content: [] },
			{ requestedHash: true }
		)
		expect(response.update).toBeUndefined()
		expect(response.abProps).toBe(persisted.values)
	})
})

describe('NCT salt sources', () => {
	it('reads the salt from the initial bootstrap only', () => {
		const bootstrap = processHistoryMessage({
			syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
			nctSalt: salt
		})
		expect(Buffer.from(bootstrap.nctSalt!).equals(salt)).toBe(true)

		const recent = processHistoryMessage({ syncType: proto.HistorySync.HistorySyncType.RECENT, nctSalt: salt })
		expect(recent.nctSalt).toBeUndefined()
	})

	it('stores the history salt as credentials and keeps it out of the history event', () => {
		const { ev, emitted } = makeEv()
		const data = processHistoryMessage({
			syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
			nctSalt: salt
		})
		emitProcessedHistorySync(data, ev, { isLatest: true })

		const creds = emitted.find(entry => entry.event === 'creds.update')
		expect(Buffer.from(creds!.data.nctSalt!).equals(salt)).toBe(true)
		const history = emitted.find(entry => entry.event === 'messaging-history.set')
		expect(history?.data).toBeDefined()
		expect('nctSalt' in history!.data).toBe(false)
	})

	const saltMutation = (operation?: proto.SyncdMutation.SyncdOperation): ChatMutation => ({
		syncAction: { value: { nctSaltSyncAction: { salt } } },
		index: ['nct_salt_sync'],
		operation
	})

	it('stores the salt from a SET nct_salt_sync mutation', () => {
		const { ev, emitted } = makeEv()
		processSyncAction(saltMutation(proto.SyncdMutation.SyncdOperation.SET), ev, { id: 'me@s.whatsapp.net' })

		expect(emitted).toHaveLength(1)
		expect(emitted[0]!.event).toBe('creds.update')
		expect(Buffer.from(emitted[0]!.data.nctSalt!).equals(salt)).toBe(true)
	})

	it('ignores a REMOVE nct_salt_sync mutation, as the app does', () => {
		const { ev, emitted } = makeEv()
		processSyncAction(saltMutation(proto.SyncdMutation.SyncdOperation.REMOVE), ev, { id: 'me@s.whatsapp.net' })

		expect(emitted).toHaveLength(0)
	})
})
