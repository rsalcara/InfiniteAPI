import { Boom } from '@hapi/boom'
import {
	buildNativeAndroidGpiaResponseNode,
	containsNativeAndroidIntegrityMaterial,
	createNativeAndroidIntegrityState,
	getNativeAndroidIntegrityGatedEgress,
	getNativeAndroidIntegrityNonce,
	isNativeAndroidIntegrityCleared,
	markNativeAndroidIntegrityCleared,
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
		expect(getNativeAndroidIntegrityNonce('safetynet', challengeNode('safetynet', safetynetNonce))).toBe(safetynetNonce)

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

	it('never retains nonce material across the full enforce lifecycle', () => {
		const nonce = 'leak-test-nonce-abc123-def456'
		const persistedSnapshots: string[] = []

		const state = createNativeAndroidIntegrityState({
			enabled: true,
			policy: 'enforce',
			now: () => 100,
			onPersist: value => {
				persistedSnapshots.push(JSON.stringify(value))
			}
		})

		// Simulate the full lifecycle: challenge observed → provider invoked → response sent
		expect(getNativeAndroidIntegrityNonce('gpia', challengeNode('gpia', nonce))).toBe(nonce)
		const { observedAt } = state.begin('gpia', 'pending')
		state.transition('gpia', 'response_sent', { observedAt })

		// Simulate failure path with a new challenge
		state.begin('gpia', 'pending')
		state.transition('gpia', 'failed', { observedAt: 200 })

		// Simulate unavailable path (no provider configured)
		state.begin('gpia', 'unavailable')

		// Simulate unsupported path (safetynet wire not proven)
		state.begin('safetynet', 'unsupported')

		// Every persisted snapshot across every transition must not contain
		// the nonce material, its fragments, or the word "nonce" as a value
		expect(persistedSnapshots.length).toBeGreaterThan(0)
		for (const snapshot of persistedSnapshots) {
			expect(snapshot).not.toContain(nonce)
			expect(snapshot).not.toContain('leak-test')
			expect(snapshot).not.toContain('abc123')
			expect(snapshot).not.toContain('def456')
		}

		// The live snapshot must also be free of nonce material
		expect(JSON.stringify(state.snapshot())).not.toContain(nonce)
		expect(JSON.stringify(state.snapshot())).not.toContain('leak-test')

		// The persisted schema is structurally incapable of storing a nonce:
		// it only has status, timestamps, policy, and schemaVersion
		for (const snapshot of persistedSnapshots) {
			const parsed = JSON.parse(snapshot) as PersistedNativeAndroidIntegrityState
			const allowedKeys = ['schemaVersion', 'gpia', 'safetynet']
			const challengeKeys = ['status', 'observedAt', 'updatedAt', 'responseSentAt', 'policyApplied']
			for (const key of Object.keys(parsed)) {
				expect(allowedKeys).toContain(key)
			}

			for (const kind of ['gpia', 'safetynet'] as const) {
				if (parsed[kind]) {
					for (const key of Object.keys(parsed[kind])) {
						expect(challengeKeys).toContain(key)
					}
				}
			}
		}
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

	it('does not re-block a 1:1 retry stanza marked as cleared by the relay guard', () => {
		const stanza = {
			tag: 'message',
			attrs: { to: '5511999999999:0@s.whatsapp.net' },
			content: [{ tag: 'enc', attrs: {}, content: new Uint8Array([1, 2, 3]) }]
		}

		// Before marking: the wire classifier sees it as fresh user egress
		expect(getNativeAndroidIntegrityGatedEgress(stanza)).toBe('message')
		expect(isNativeAndroidIntegrityCleared(stanza)).toBe(false)

		// After the relay path marks it as cleared (retry/peer recovery):
		markNativeAndroidIntegrityCleared(stanza)
		expect(isNativeAndroidIntegrityCleared(stanza)).toBe(true)

		// The sendNode caller must consult the cleared marker in addition to
		// the classifier; a 1:1 retry is wire-identical to a fresh message.
		const gatedEgress = getNativeAndroidIntegrityGatedEgress(stanza)
		const shouldBlock = Boolean(gatedEgress) && !isNativeAndroidIntegrityCleared(stanza)
		expect(shouldBlock).toBe(false)
	})

	it('requires reference identity between the marked stanza and the sent stanza', () => {
		const original = {
			tag: 'message',
			attrs: { to: '5511999999999:0@s.whatsapp.net' },
			content: [{ tag: 'enc', attrs: {}, content: new Uint8Array([1, 2, 3]) }]
		}

		markNativeAndroidIntegrityCleared(original)
		expect(isNativeAndroidIntegrityCleared(original)).toBe(true)

		// A wire-identical clone is NOT cleared — the marker is reference-based.
		// This is intentional: only the object classified by the relay guard is
		// exempt, not any stanza that happens to look like a retry.
		const clone = {
			tag: original.tag,
			attrs: { ...original.attrs },
			content: original.content.map(child => ({ ...child, attrs: { ...child.attrs } }))
		}
		expect(clone).toEqual(original)
		expect(isNativeAndroidIntegrityCleared(clone)).toBe(false)

		// The relay-to-wire contract requires the same reference to survive
		// from mark to sendNode. If a refactor clones the stanza between
		// markNativeAndroidIntegrityCleared and sendNode, the wire guard
		// correctly blocks the clone as fresh user egress. This test pins
		// that invariant: a refactor must either preserve reference identity
		// or propagate the classification explicitly.
		const gatedEgress = getNativeAndroidIntegrityGatedEgress(clone)
		const shouldBlock = Boolean(gatedEgress) && !isNativeAndroidIntegrityCleared(clone)
		expect(shouldBlock).toBe(true)
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
