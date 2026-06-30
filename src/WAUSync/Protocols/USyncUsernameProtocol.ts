import type { USyncQueryProtocol } from '../../Types/USync'
import { assertNodeErrorFree, type BinaryNode } from '../../WABinary'
import { USyncUser } from '../USyncUser'

export class USyncUsernameProtocol implements USyncQueryProtocol {
	name = 'username'

	getQueryElement(): BinaryNode {
		return {
			tag: 'username',
			attrs: {}
		}
	}

	getUserElement(user: USyncUser): BinaryNode | null {
		// Resolver `@username → LID` requires emitting the queried handle
		// in the `<user>` payload, otherwise the server receives an empty
		// `<user></user>` and silently returns nothing. Mirrors what WA
		// Web does in `WAWebUsyncUsername.getUserElement`:
		//   `wap("username", { username: CUSTOM_STRING(e) })`
		// Two independent reviewers (P1, confidence 9) flagged the prior
		// `return null` behaviour as a bug — getUserByUsername was a no-op
		// for every input. (This is the fix.)
		if (user.username) {
			return {
				tag: 'username',
				attrs: { username: user.username }
			}
		}

		return null
	}

	parser(node: BinaryNode): string | null {
		if (node.tag === 'username') {
			assertNodeErrorFree(node)
			if (typeof node.content === 'string') {
				return node.content
			}

			// Username may arrive as Uint8Array/Buffer — decode as UTF-8.
			// (Plain Uint8Array.prototype.toString() returns comma-separated byte
			// values like "97,98", not the actual text — use Buffer or TextDecoder.)
			if (node.content instanceof Uint8Array) {
				const decoded = Buffer.from(node.content).toString('utf8')
				return decoded.length > 0 ? decoded : null
			}
		}

		return null
	}
}
