import type { NativeAndroidRequestCodeEnvironment } from './native-android-registration-protocol'

/**
 * Ambiente estático EXATO da captura oficial de 2026-09-24 (17 requests com
 * `status: ok` naquele contexto): app-prefs e valores de device que o runtime
 * do consumidor não consegue coletar saem daqui, e o que o aparelho/bridge
 * reporta ao vivo (gpia, blobs WAMSYS, pid, RAM…) deve SOBRESCREVER estes
 * defaults. Compartilhado pelo runner de laboratório e pelo worker da
 * platform para que qualquer caminho de registro fale o mesmo dialeto.
 */
export const NATIVE_ANDROID_REGISTRATION_CAPTURE_ENVIRONMENT: NativeAndroidRequestCodeEnvironment = {
	recaptcha: '{"stage":"ABPROP_DISABLED"}',
	db: 1,
	hasav: 2,
	mistyped: 7,
	feo2_query_status: 'error_security_exception',
	hasinrc: 1,
	simnum: 0,
	prefer_sms_over_flash: false,
	education_screen_displayed: false,
	backup_token_error: 'null_token',
	read_phone_permission_granted: 0,
	is_foa_fdid_app_installed: false,
	language_selector_time_spent: 0,
	language_selector_clicked_count: 0,
	offline_ab:
		'{"exposure":["android_eula_content_update|android_eula_content_update_prod|test"],"exp_hash":["7060|android_eula_content_update"],"metrics":{}}',
	rc: 0,
	// Persona do dispositivo da captura (emu64xa / T-Mobile / LTE).
	mcc: '310',
	mnc: '260',
	sim_mcc: '310',
	sim_mnc: '260',
	sim_type: 1,
	sim_state: 5,
	airplane_mode_type: 0,
	cellular_strength: 4,
	roaming_type: 0,
	network_radio_type: 1,
	device_ram: 2.42,
	device_name: 'emu64xa',
	network_operator_name: 'T-Mobile',
	pid: 9703,
	// FCM do instalador da captura.
	push_token:
		'dM_R5BYSRn-LnQUTmChw1L:APA91bFEvoF-5hpjJDGcLf7VZph2CKeiXr3bysAdNia0lVwdEkb0Cod2hWpUHttURtCRJwBJQqE2zLuQ2WhzMvpw_DZnxPye7'
}

/**
 * `client_metrics` do `/v2/exist`: o APK usa um produtor diferente do /v2/code
 * (observado `{"GMSVersion":263234032}` contra `{"attempts":N,...}`).
 */
export const NATIVE_ANDROID_REGISTRATION_EXIST_CLIENT_METRICS = '{"GMSVersion":263234032}'

/**
 * `client_metrics` do `/v2/code`: `{"attempts":N,"app_campaign_download_source"
 * :"google-play|unknown","was_activated_from_stub":false}` com N crescendo a
 * cada tentativa (19/37/38 na captura oficial).
 */
export const buildNativeAndroidRegistrationCodeClientMetrics = (attempts: number): string =>
	JSON.stringify({ attempts, app_campaign_download_source: 'google-play|unknown', was_activated_from_stub: false })

/**
 * Ambiente pronto para o flow: defaults da captura + client_metrics do attempt
 * atual, com `overrides` do operador/dispositivo por cima (ex.:
 * `NATIVE_ANDROID_REGISTRATION_ENVIRONMENT` da platform, ou o ambiente coletado
 * ao vivo pela bridge).
 */
export const createNativeAndroidRegistrationCaptureEnvironment = (
	attempts: number,
	overrides?: NativeAndroidRequestCodeEnvironment
): NativeAndroidRequestCodeEnvironment => ({
	...NATIVE_ANDROID_REGISTRATION_CAPTURE_ENVIRONMENT,
	client_metrics: buildNativeAndroidRegistrationCodeClientMetrics(attempts),
	...overrides
})
