import type { AuthenticationCreds } from '../Types'
import { type BinaryNode, reduceBinaryNodeToDictionary } from '../WABinary'

export type AbProps = { [code: string]: string }

/** AB props the engine reads. Only these are persisted (see `StoredAbProps`). */
export const TRACKED_AB_PROPS: readonly string[] = [
	// NctTokenMessageSendStanzaContributor gate (`X/C30120DHe.java`).
	'24941',
	// New-chat message capping. The primary creates the account NCT salt only
	// with it on (`NewChatMessageCappingAsyncInit`, `X/C2JP.java:29`); kept to
	// explain an account without a salt, not to gate anything.
	'24915'
]

/**
 * App defaults for the tracked codes, used when a full set from the server
 * leaves one out: the app reads an absent prop as its compiled default
 * (`X/C016407t.java:8405-8406`, `builder.put(24915, false)`, `24941, false`). Storing it makes the
 * code known, so the next request can carry the hash.
 */
const TRACKED_AB_PROP_DEFAULTS: AbProps = { '24941': 'false', '24915': 'false' }

/**
 * Persisted AB props. The server can send thousands of props, some with long
 * values; keeping only the tracked ones keeps every credential write small.
 * `tracked` records which codes `values` covers, so adding a code to
 * `TRACKED_AB_PROPS` makes the next fetch ask for the full set again.
 */
export type StoredAbProps = { tracked: string[]; values: AbProps }

/** Boolean AB prop as the server sends it (`config_value`). */
export const isAbPropEnabled = (props: AbProps | undefined, code: string) => {
	const value = props?.[code]
	return value === 'true' || value === '1'
}

/**
 * Applies an `abt` props response the way the app's `ABPropsManager`
 * (`X/C38001mI.java`) does: a response with a hash and no `delta_update`
 * replaces the stored set, `delta_update="true"` merges into it, and an
 * empty hash without delta means "unchanged since your hash". The app
 * always sends a hash; when the engine asked without one (`fullSet`), there
 * is no "since" to be unchanged from, so a non-empty response is the full set.
 */
export const applyAbPropsResponse = (
	stored: AbProps | undefined,
	response: { hash?: string; deltaUpdate: boolean; props: AbProps; fullSet?: boolean }
): AbProps | undefined => {
	if (response.deltaUpdate) {
		return { ...stored, ...response.props }
	}

	if (response.hash || response.fullSet) {
		return { ...response.props }
	}

	return stored
}

/**
 * Whether the stored set holds a value for every tracked code. Listing a code
 * in `tracked` is not enough: a set saved without it (e.g. `values: {}`)
 * must not send the hash, or the server answers "unchanged" and the code
 * stays unknown for good.
 */
const coversTrackedProps = (stored: StoredAbProps | undefined, tracked: readonly string[]): stored is StoredAbProps =>
	!!stored && tracked.every(code => stored.tracked.includes(code) && stored.values[code] !== undefined)

/**
 * `<props>` attributes for the `abt` query. The hash asks for "changes since";
 * send it only when the stored props cover every tracked code, so a session
 * without them (or one created before they were kept) gets the full set.
 */
export const abPropsRequestAttrs = (
	creds: Pick<AuthenticationCreds, 'lastPropHash' | 'abProps'>,
	tracked: readonly string[] = TRACKED_AB_PROPS
) => ({
	protocol: '1',
	...(creds.lastPropHash && coversTrackedProps(creds.abProps, tracked) ? { hash: creds.lastPropHash } : {})
})

/**
 * Reads a `<props>` response and returns the credential update to persist, if
 * any. `requestedHash` tells whether the query carried a hash (see
 * `abPropsRequestAttrs`).
 */
export const readAbPropsResponse = (
	creds: Pick<AuthenticationCreds, 'abProps'>,
	propsNode: BinaryNode,
	{ requestedHash, tracked = TRACKED_AB_PROPS }: { requestedHash: boolean; tracked?: readonly string[] }
): { received: number; abProps: AbProps | undefined; deltaUpdate: boolean; update?: Partial<AuthenticationCreds> } => {
	const received = reduceBinaryNodeToDictionary(propsNode, 'prop')
	const props = Object.fromEntries(Object.entries(received).filter(([code]) => tracked.includes(code)))
	const hash = propsNode.attrs?.hash
	const deltaUpdate = propsNode.attrs?.delta_update === 'true'
	// A stored set that misses a tracked code cannot be merged into: the
	// request went without hash and this response is the full set.
	const stored = coversTrackedProps(creds.abProps, tracked) ? creds.abProps.values : undefined
	const fullSet = !requestedHash && Object.keys(received).length > 0
	const applied = applyAbPropsResponse(stored, { hash, deltaUpdate, props, fullSet })
	// A full set that leaves a tracked code out means "app default" for it.
	const isFullSet = !deltaUpdate && (!!hash || fullSet)
	const values =
		applied && isFullSet
			? {
					...Object.fromEntries(
						tracked.flatMap(code =>
							TRACKED_AB_PROP_DEFAULTS[code] !== undefined ? [[code, TRACKED_AB_PROP_DEFAULTS[code]]] : []
						)
					),
					...applied
				}
			: applied
	const changed = values !== stored || !coversTrackedProps(creds.abProps, tracked)
	// on some clients, the hash is returning as undefined
	const update =
		hash || (changed && values)
			? {
					...(hash ? { lastPropHash: hash } : {}),
					...(values ? { abProps: { tracked: [...tracked], values } } : {})
				}
			: undefined

	return { received: Object.keys(received).length, abProps: values, deltaUpdate, update }
}
