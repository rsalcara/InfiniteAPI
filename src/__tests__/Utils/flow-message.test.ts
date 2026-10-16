import { buildFlowMessage, type FlowMessageParams, simpleFlowForm } from '../../Utils/flow-message'

describe('flow message construction (wire parity W4B 2.26.36.72, captured 2026-10-15)', () => {
	const capturedParams: FlowMessageParams = {
		flow_message_version: '4',
		flow_id: '2403191210495400',
		flow_action_payload: {
			screen: 'contact_details',
			data: {
				full_name_visible: false,
				email_visible: false,
				phone_number_visible: false,
				delivery_address_visible: false,
				cpf_or_cnpj_visible: false,
				citizenship_card_visible: false,
				custom_fields: [
					{ type: 'TEXT_INPUT', label: 'Nome completo' },
					{ type: 'TEXT_INPUT', label: 'CEP' },
					{ type: 'TEXT_INPUT', label: 'Pix' }
				]
			}
		},
		well_version: 'V700',
		flow_cta: '__localize:FLOWS_COMPLETE_FORM_BUTTON_TITLE',
		flow_action: 'navigate',
		flow_token: Buffer.from('CUSTOMER_INFO').toString('base64'),
		form_type: 'ai_form_attachment_tray'
	}

	it('builds the exact interactiveMessage structure captured on the wire', () => {
		const result = buildFlowMessage({
			bodyText: 'Por favor, forneça as seguintes informações',
			flowParams: capturedParams
		})

		expect(result.interactiveMessage).toBeDefined()
		expect(result.interactiveMessage.body.text).toBe('Por favor, forneça as seguintes informações')
		expect(result.interactiveMessage.nativeFlowMessage).toBeDefined()
		expect(result.interactiveMessage.nativeFlowMessage.messageVersion).toBe(3)
		expect(result.interactiveMessage.nativeFlowMessage.messageParamsJson).toBe('{}')
	})

	it('serializes buttonParamsJson as valid JSON matching the captured shape', () => {
		const result = buildFlowMessage({
			bodyText: 'Formulário de teste',
			flowParams: capturedParams
		})

		const button = result.interactiveMessage.nativeFlowMessage.buttons[0]!
		expect(button.name).toBe('galaxy_message')

		const parsed = JSON.parse(button.buttonParamsJson) as FlowMessageParams
		expect(parsed.flow_message_version).toBe('4')
		expect(parsed.flow_id).toBe('2403191210495400')
		expect(parsed.flow_action_payload.screen).toBe('contact_details')
		expect(parsed.well_version).toBe('V700')
		expect(parsed.flow_action).toBe('navigate')
		expect(parsed.flow_token).toBe(Buffer.from('CUSTOMER_INFO').toString('base64'))
	})

	it('preserves custom fields in the serialized JSON', () => {
		const result = buildFlowMessage({
			bodyText: 'Teste',
			flowParams: capturedParams
		})

		const parsed = JSON.parse(result.interactiveMessage.nativeFlowMessage.buttons[0]!.buttonParamsJson)
		const fields = parsed.flow_action_payload!.data!.custom_fields
		expect(fields).toHaveLength(3)
		expect(fields![0]!.label).toBe('Nome completo')
		expect(fields![2]!.label).toBe('Pix')
		expect(fields!.every((f: { type: string }) => f.type === 'TEXT_INPUT')).toBe(true)
	})

	it('simpleFlowForm generates the captured defaults with the given fields', () => {
		const result = simpleFlowForm('Complete seus dados', '2403191210495400', [
			{ label: 'Nome' },
			{ label: 'Email', type: 'TEXT_INPUT' },
			{ label: 'Data de nascimento', type: 'DATE' }
		])

		const button = result.interactiveMessage.nativeFlowMessage.buttons[0]!
		const parsed = JSON.parse(button.buttonParamsJson) as FlowMessageParams

		expect(parsed.flow_message_version).toBe('4')
		expect(parsed.flow_id).toBe('2403191210495400')
		expect(parsed.well_version).toBe('V700')
		expect(parsed.flow_cta).toBe('__localize:FLOWS_COMPLETE_FORM_BUTTON_TITLE')
		expect(parsed.flow_action).toBe('navigate')
		expect(parsed.flow_token).toBe('Q1VTVE9NRVJfSU5GTw==')

		const fields = parsed.flow_action_payload.data.custom_fields
		expect(fields!).toHaveLength(3)
		expect(fields![0]!.type).toBe('TEXT_INPUT')
		expect(fields![2]!.type).toBe('DATE')
	})

	it('sets all standard visibility toggles to false (captured default)', () => {
		const result = simpleFlowForm('Teste', '1234567890123456', [{ label: 'Campo' }])
		const parsed = JSON.parse(result.interactiveMessage.nativeFlowMessage.buttons[0]!.buttonParamsJson)

		expect(parsed.flow_action_payload!.data!.full_name_visible).toBe(false)
		expect(parsed.flow_action_payload!.data!.email_visible).toBe(false)
		expect(parsed.flow_action_payload!.data!.phone_number_visible).toBe(false)
	})

	it('produces output compatible with sock.sendMessage (interactiveMessage key)', () => {
		const result = simpleFlowForm('Teste', '1234567890123456', [{ label: 'X' }])

		// The shape must be a valid sendMessage content: interactiveMessage at top level
		expect(result).toHaveProperty('interactiveMessage')
		expect(result.interactiveMessage).toHaveProperty('body')
		expect(result.interactiveMessage).toHaveProperty('nativeFlowMessage')
		expect(result.interactiveMessage.nativeFlowMessage).toHaveProperty('buttons')
		expect(result.interactiveMessage.nativeFlowMessage.buttons).toHaveLength(1)
	})
})
