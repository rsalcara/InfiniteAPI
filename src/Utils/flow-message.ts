/**
 * Native flow message construction — typed helpers for the
 * `interactiveMessage.nativeFlowMessage` wire format.
 *
 * Wire parity (W4B 2.26.36.72, captured 2026-10-15 via frida hook on the
 * proto serialization inside the official app, pre-encryption):
 *
 *   Message
 *   └── interactiveMessage
 *       ├── body.text = "..."
 *       └── nativeFlowMessage
 *           ├── messageVersion  = 3
 *           ├── messageParamsJson = "{}"
 *           └── buttons[0]
 *               ├── name = "galaxy_message"
 *               └── buttonParamsJson = <JSON do flow> (FlowMessageParams)
 *
 * The proto schema (WAProto.proto:3202) already carries all fields
 * (buttons, messageParamsJson, messageVersion). These helpers add the
 * TypeScript surface for the JSON payload that rides inside
 * `buttonParamsJson` — the "well" of the native flow form.
 */

/**
 * A single field in a flow form's `custom_fields` array.
 * Captured types: TEXT_INPUT (others: SELECT, DATE, etc. — extend as captured).
 */
export type FlowFormField = {
	/** Field input type (e.g. "TEXT_INPUT"). */
	type: string
	/** Display label shown to the user. */
	label: string
	/** Optional pre-filled value. */
	value?: string
	/** Optional: field is required. */
	required?: boolean
}

/**
 * The `flow_action_payload.data` object — configures which standard fields
 * are visible and what custom fields the form renders.
 */
export type FlowFormData = {
	/** Standard field visibility toggles (all default to false in the capture). */
	full_name_visible?: boolean
	email_visible?: boolean
	phone_number_visible?: boolean
	delivery_address_visible?: boolean
	cpf_or_cnpj_visible?: boolean
	citizenship_card_visible?: boolean
	/** Custom form fields rendered by the well. */
	custom_fields?: FlowFormField[]
}

/**
 * The `flow_action_payload` — what screen to navigate to and what data to
 * pre-populate.
 */
export type FlowActionPayload = {
	/** Target screen (e.g. "contact_details"). */
	screen: string
	/** Data payload for the screen. */
	data: FlowFormData
}

/**
 * The complete JSON structure that rides inside
 * `nativeFlowMessage.buttons[0].buttonParamsJson` when `name` is
 * `"galaxy_message"`. This is the "well" — the native flow form definition.
 *
 * Captured verbatim from the official W4B 2.26.36.72 (2026-10-15).
 */
export type FlowMessageParams = {
	/** Flow protocol version (captured: "4"). */
	flow_message_version: string
	/** 16-digit flow identifier (captured: "2403191210495400"). */
	flow_id: string
	/** Screen navigation + form data. */
	flow_action_payload: FlowActionPayload
	/** Well version — the form renderer engine (captured: "V700"). */
	well_version: string
	/** CTA button label (localization key, not literal text). */
	flow_cta: string
	/** Flow action type (captured: "navigate"). */
	flow_action: string
	/** Base64-encoded flow token (captured: base64("CUSTOMER_INFO")). */
	flow_token: string
	/** Form origin indicator (captured: "ai_form_attachment_tray"). */
	form_type?: string
}

/**
 * Input for {@link buildFlowMessage} — the caller-facing shape.
 */
export type FlowMessageInput = {
	/** Body text above the form (captured: "Por favor, forneça as seguintes informações"). */
	bodyText: string
	/** The flow form parameters (or use {@link simpleFlowForm} for a shortcut). */
	flowParams: FlowMessageParams
}

/**
 * Builds a ready-to-send `interactiveMessage` payload carrying a native
 * flow form. The result goes directly into `sock.sendMessage(jid, result)`
 * (or wrapped in `viewOnceMessageV2` for the recommended modern format).
 *
 * Wire parity: `messageVersion: 3` and `messageParamsJson: "{}"` are the
 * values captured from the official app; `name: "galaxy_message"` is the
 * button type for native flow forms.
 */
export const buildFlowMessage = (input: FlowMessageInput) => ({
	interactiveMessage: {
		body: { text: input.bodyText },
		nativeFlowMessage: {
			messageVersion: 3,
			messageParamsJson: '{}',
			buttons: [
				{
					name: 'galaxy_message',
					buttonParamsJson: JSON.stringify(input.flowParams)
				}
			]
		}
	}
})

/**
 * Convenience: builds a flow form from a simple field list. Generates the
 * flow token from a label and uses sensible defaults for well_version, CTA,
 * and action — matching the captured wire.
 *
 * The `flowId` must be a valid 16-digit flow identifier (provisioned
 * server-side or reused from an existing form).
 */
export const simpleFlowForm = (bodyText: string, flowId: string, fields: Array<{ label: string; type?: string }>) =>
	buildFlowMessage({
		bodyText,
		flowParams: {
			flow_message_version: '4',
			flow_id: flowId,
			flow_action_payload: {
				screen: 'contact_details',
				data: {
					full_name_visible: false,
					email_visible: false,
					phone_number_visible: false,
					delivery_address_visible: false,
					cpf_or_cnpj_visible: false,
					citizenship_card_visible: false,
					custom_fields: fields.map(field => ({
						type: field.type ?? 'TEXT_INPUT',
						label: field.label
					}))
				}
			},
			well_version: 'V700',
			flow_cta: '__localize:FLOWS_COMPLETE_FORM_BUTTON_TITLE',
			flow_action: 'navigate',
			flow_token: Buffer.from('CUSTOMER_INFO').toString('base64')
		}
	})
