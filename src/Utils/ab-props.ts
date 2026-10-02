import type { AuthenticationCreds } from '../Types'
import { type BinaryNode, reduceBinaryNodeToDictionary } from '../WABinary'

export type AbProps = { [code: string]: string }

/** AB props the engine reads. Only these are persisted (see `StoredAbProps`). */
export const TRACKED_AB_PROPS: readonly string[] = [
	// NctTokenMessageSendStanzaContributor gate (`X/C30120DHe.java`).
	'24941'
]

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

const coversTrackedProps = (stored: StoredAbProps | undefined, tracked: readonly string[]): stored is StoredAbProps =>
	!!stored && tracked.every(code => stored.tracked.includes(code))

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
	const values = applyAbPropsResponse(stored, { hash, deltaUpdate, props, fullSet })
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
