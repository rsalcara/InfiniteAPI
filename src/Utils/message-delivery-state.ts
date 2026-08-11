import type { BaileysEventEmitter, MessageDeliveryState, MessageDeliveryStateUpdate, WAMessageKey } from '../Types'
import type { ILogger } from './logger'

export type MessageDeliveryStateInput = Omit<MessageDeliveryStateUpdate, 'timestamp' | 'state' | 'key'> & {
	key: WAMessageKey
	state: MessageDeliveryState
	observedAt?: number
}

/** Builds the public delivery event with a local observation clock. */
export const buildMessageDeliveryState = ({
	key,
	state,
	observedAt = Date.now(),
	...metadata
}: MessageDeliveryStateInput): MessageDeliveryStateUpdate => ({
	key,
	state,
	timestamp: observedAt,
	...metadata
})

/** Emits the same delivery contract from every outbound/inbound call site. */
export const emitMessageDeliveryState = (
	ev: BaileysEventEmitter,
	input: MessageDeliveryStateInput,
	logger?: ILogger
): MessageDeliveryStateUpdate => {
	const update = buildMessageDeliveryState(input)
	try {
		ev.emit('message.delivery-state', update)
	} catch (error) {
		logger?.warn(
			{ error, state: update.state, messageId: update.key.id },
			'message.delivery-state listener failed; message processing continues'
		)
	}

	return update
}
