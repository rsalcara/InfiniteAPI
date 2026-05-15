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
		void user
		return null
	}

	parser(node: BinaryNode): string | null {
		if (node.tag === 'username') {
			assertNodeErrorFree(node)
			if (typeof node.content === 'string') {
				return node.content
			}

			// Username may arrive as Uint8Array/Buffer — decode like other text fields do
			if (node.content && typeof (node.content as { toString?: () => string }).toString === 'function') {
				const decoded = (node.content as Uint8Array | Buffer).toString()
				return decoded.length > 0 ? decoded : null
			}
		}

		return null
	}
}
