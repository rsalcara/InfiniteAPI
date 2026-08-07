import type { BaileysEventEmitter, MessageDeliveryState, MessageDeliveryStateUpdate, WAMessageKey } from '../Types'

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
	input: MessageDeliveryStateInput
): MessageDeliveryStateUpdate => {
	const update = buildMessageDeliveryState(input)
	ev.emit('message.delivery-state', update)
	return update
}
