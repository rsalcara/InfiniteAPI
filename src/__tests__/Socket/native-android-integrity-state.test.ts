import { Boom } from '@hapi/boom'
import {
	buildNativeAndroidGpiaResponseNode,
	containsNativeAndroidIntegrityMaterial,
	createNativeAndroidIntegrityState,
	getNativeAndroidIntegrityGatedEgress,
	getNativeAndroidIntegrityNonce,
	NATIVE_ANDROID_INTEGRITY_MAX_TOKEN_BYTES,
	NATIVE_ANDROID_INTEGRITY_REQUIRED_STATUS
} from '../../Socket/native-android-integrity-state'
import type { PersistedNativeAndroidIntegrityState } from '../../Types'

const challengeNode = (kind: 'gpia' | 'safetynet', nonce: string) => ({
	tag: 'ib',
	attrs: {},
	content: [
		{
			tag: kind,
			attrs: {},
			content: [{ tag: kind === 'gpia' ? 'request' : 'integrity', attrs: { nonce } }]
		}
	]
})

describe('native_android integrity lifecycle', () => {
	it('extracts each challenge nonce without retaining it in state', () => {
		const gpiaNonce = 'gpia-secret-nonce'
		const safetynetNonce = 'safetynet-secret-nonce'
		expect(getNativeAndroidIntegrityNonce('gpia', challengeNode('gpia', gpiaNonce))).toBe(gpiaNonce)
		expect(getNativeAndroidIntegrityNonce('safetynet', challengeNode('safetynet', safetynetNonce))).toBe(
			safetynetNonce
		)

		let persisted: PersistedNativeAndroidIntegrityState | undefined
		const state = createNativeAndroidIntegrityState({
			enabled: true,
			policy: 'audit',
			now: () => 100,
			onPersist: value => {
				persisted = value
			}
		})
		state.begin('gpia', 'pending')
		expect(JSON.stringify(persisted)).not.toContain(gpiaNonce)
		expect(persisted?.gpia).toMatchObject({ status: 'pending', observedAt: 100, policyApplied: 'audit' })
	})

	it('builds only the APK-proven ib/gpia/jws response wire', () => {
		const jws = 'header.payload.signature'
		const node = buildNativeAndroidGpiaResponseNode(jws)
		expect(node).toEqual({
			tag: 'ib',
			attrs: {},
			content: [
				{
					tag: 'gpia',
					attrs: {},
					content: [{ tag: 'jws', attrs: {}, content: Buffer.from(jws) }]
				}
			]
		})
		expect(containsNativeAndroidIntegrityMaterial(node)).toBe(true)
		expect(() => buildNativeAndroidGpiaResponseNode('')).toThrow('empty token')
		expect(() => buildNativeAndroidGpiaResponseNode('x'.repeat(NATIVE_ANDROID_INTEGRITY_MAX_TOKEN_BYTES + 1))).toThrow(
			'safety limit'
		)
	})

	it('keeps audit non-blocking and makes enforce fail closed only after a challenge', () => {
		const audit = createNativeAndroidIntegrityState({ enabled: true, policy: 'audit' })
		audit.begin('safetynet', 'unsupported')
		expect(() => audit.assertUserMessageEgressReady()).not.toThrow()

		const enforce = createNativeAndroidIntegrityState({ enabled: true, policy: 'enforce' })
		expect(() => enforce.assertUserMessageEgressReady()).not.toThrow()
		enforce.begin('gpia', 'pending')
		try {
			enforce.assertUserMessageEgressReady('message')
			throw new Error('expected enforce to block')
		} catch (error) {
			expect(error).toBeInstanceOf(Boom)
			expect((error as Boom).output.statusCode).toBe(NATIVE_ANDROID_INTEGRITY_REQUIRED_STATUS)
			expect((error as Boom).data).toMatchObject({
				category: 'native-android-integrity-required',
				action: 'message-egress-blocked',
				challenges: [{ kind: 'gpia', status: 'pending' }]
			})
		}

		enforce.transition('gpia', 'response_sent')
		expect(() => enforce.assertUserMessageEgressReady()).not.toThrow()
	})

	it('gates fresh raw message/call egress but leaves protocol recovery and active-call signaling open', () => {
		expect(getNativeAndroidIntegrityGatedEgress({ tag: 'message', attrs: { to: '1@lid' } })).toBe('message')
		expect(
			getNativeAndroidIntegrityGatedEgress({ tag: 'message', attrs: { to: '1@lid', participant: '1:2@lid' } })
		).toBeUndefined()
		expect(
			getNativeAndroidIntegrityGatedEgress({ tag: 'message', attrs: { to: '1@lid', category: 'peer' } })
		).toBeUndefined()
		expect(
			getNativeAndroidIntegrityGatedEgress({
				tag: 'call',
				attrs: { to: '1@lid' },
				content: [{ tag: 'offer', attrs: {} }]
			})
		).toBe('call')
		for (const tag of ['accept', 'reject', 'terminate', 'transport']) {
			expect(
				getNativeAndroidIntegrityGatedEgress({
					tag: 'call',
					attrs: { to: '1@lid' },
					content: [{ tag, attrs: {} }]
				})
			).toBeUndefined()
		}
		expect(getNativeAndroidIntegrityGatedEgress(buildNativeAndroidGpiaResponseNode('token'))).toBeUndefined()
	})

	it('restores unsatisfied state across reconnects and never trusts malformed persistence', () => {
		const persisted: PersistedNativeAndroidIntegrityState = {
			schemaVersion: 1,
			gpia: {
				status: 'pending',
				observedAt: 10,
				updatedAt: 11,
				policyApplied: 'audit'
			}
		}
		const reopened = createNativeAndroidIntegrityState({ enabled: true, policy: 'enforce', persisted })
		expect(reopened.snapshot().gpia).toBe('pending')
		expect(() => reopened.assertUserMessageEgressReady()).toThrow('has not been satisfied')

		const malformed = createNativeAndroidIntegrityState({
			enabled: true,
			policy: 'enforce',
			persisted: {
				schemaVersion: 1,
				gpia: {
					status: 'response_sent',
					observedAt: 10,
					updatedAt: 11,
					policyApplied: 'enforce'
				}
			}
		})
		expect(malformed.snapshot().gpia).toBe('failed')
		expect(() => malformed.assertUserMessageEgressReady()).toThrow('has not been satisfied')
	})

	it('ignores a stale provider completion after a newer challenge begins', () => {
		const state = createNativeAndroidIntegrityState({ enabled: true, policy: 'enforce', now: () => 50 })
		const first = state.begin('gpia', 'pending')
		const second = state.begin('gpia', 'pending')
		expect(second.observedAt).toBeGreaterThan(first.observedAt)
		expect(state.isCurrent('gpia', first.generation)).toBe(false)
		expect(state.isCurrent('gpia', second.generation)).toBe(true)
	})
})
