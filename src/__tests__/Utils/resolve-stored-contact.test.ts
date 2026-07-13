import { resolveStoredContact, type StoredWaContactRow } from '../../Utils/multi-db-sqlite/wa-contacts-backend'

// #630: getStoredContact resolved a LID to its PN and looked up ONLY the PN
// row, returning null when that row was absent — even though the contact was
// stored under its LID row. resolveStoredContact must fall back to the original
// jid so a LID-only contact is still found.
describe('resolveStoredContact (#630 PN→LID fallback)', () => {
	const LID = '123456789@lid'
	const PN = '5511999999999@s.whatsapp.net'

	const rowFor = (jid: string): StoredWaContactRow => ({
		jid,
		is_whatsapp_user: 1,
		wa_name: `notify-${jid}`,
		display_name: `name-${jid}`,
		status: null,
		username: null
	})

	const table = (jids: string[]) => {
		const set = new Set(jids)
		return (jid: string): StoredWaContactRow | null => (set.has(jid) ? rowFor(jid) : null)
	}

	const noMapping = async () => undefined
	const mapsTo = (pn: string) => async () => pn

	it('non-LID jid: returns the PN row directly', async () => {
		const c = await resolveStoredContact(PN, table([PN]), noMapping)
		expect(c).toMatchObject({ id: PN, name: `name-${PN}`, notify: `notify-${PN}` })
	})

	it('non-LID jid with no stored row: returns null (no redundant fallback)', async () => {
		let calls = 0
		const getByJid = (jid: string) => {
			calls++
			return table([])(jid)
		}
		expect(await resolveStoredContact(PN, getByJid, noMapping)).toBeNull()
		expect(calls).toBe(1) // pn === id, so the fallback lookup is skipped
	})

	it('LID mapped to PN, PN row present: returns the PN row with id=PN', async () => {
		const c = await resolveStoredContact(LID, table([PN]), mapsTo(PN))
		expect(c).toMatchObject({ id: PN, name: `name-${PN}` })
	})

	it('LID mapped to PN but PN row ABSENT: falls back to the LID row (#630)', async () => {
		const c = await resolveStoredContact(LID, table([LID]), mapsTo(PN))
		// data comes from the LID row, but the canonical id is still the known PN
		expect(c).toMatchObject({ id: PN, name: `name-${LID}`, notify: `notify-${LID}` })
	})

	it('LID with NO mapping but a LID row exists: returns the LID row with id=LID', async () => {
		const c = await resolveStoredContact(LID, table([LID]), noMapping)
		expect(c).toMatchObject({ id: LID, name: `name-${LID}` })
	})

	it('LID with no mapping and no LID row: returns null', async () => {
		expect(await resolveStoredContact(LID, table([]), noMapping)).toBeNull()
	})
})
