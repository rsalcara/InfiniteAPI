import { describe, expect, it } from '@jest/globals'
import { resolveSignalAddressIdForTests } from '../../Signal/libsignal'
import type { LIDMappingStore } from '../../Signal/lid-mapping'

describe('Signal address resolution call site', () => {
	it('maps the Meta AI FBID before PN-to-LID session resolution', async () => {
		const requestedPns: string[] = []
		const lidMapping = {
			getLIDForPN: async (pn: string) => {
				requestedPns.push(pn)
				return pn === '13135550202:2@s.whatsapp.net' ? '100000000000001:2@s.whatsapp.net' : undefined
			}
		} as unknown as LIDMappingStore

		await expect(resolveSignalAddressIdForTests('718584497008509.2', lidMapping)).resolves.toBe('100000000000001.2')
		expect(requestedPns).toEqual(['13135550202:2@s.whatsapp.net'])
	})

	it('maps the Meta AI FBID on the device-0 path, before the early return', async () => {
		const requestedPns: string[] = []
		const lidMapping = {
			getLIDForPN: async (pn: string) => {
				requestedPns.push(pn)
				return undefined
			}
		} as unknown as LIDMappingStore

		// No dot means device 0 — the primary device, which leaves the function
		// through `if (!id.includes('.')) return id`. If the mapping ever moves
		// below that return, this address escapes as the raw FBID.
		await expect(resolveSignalAddressIdForTests('718584497008509', lidMapping)).resolves.toBe('13135550202')
		expect(requestedPns).toEqual([])
	})

	it('preserves unrelated Signal addresses', async () => {
		const lidMapping = {
			getLIDForPN: async () => undefined
		} as unknown as LIDMappingStore

		await expect(resolveSignalAddressIdForTests('5511000000001.2', lidMapping)).resolves.toBe('5511000000001.2')
	})
})
