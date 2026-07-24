package com.rsalcara.infiniteapi.attestation

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		startForegroundService(Intent(this, AttestationProviderService::class.java))

		val status = if (BuildConfig.CLIENT_APP_ID.isBlank()) {
			"Provider blocked: build with -PINFINITEAPI_ANDROID_CLIENT_APP_ID=<your-authorized-id>"
		} else {
			"Provider ready on Android loopback port ${LocalBridgeServer.PORT}"
		}

		setContentView(
			LinearLayout(this).apply {
				orientation = LinearLayout.VERTICAL
				setPadding(48, 96, 48, 48)
				addView(TextView(context).apply {
					textSize = 22f
					text = "InfiniteAPI Android Provider"
				})
				addView(TextView(context).apply {
					textSize = 16f
					setPadding(0, 32, 0, 0)
					text = "$status\n\n" +
						"Package: ${BuildConfig.APPLICATION_ID}\n" +
						"ADB bridge: adb forward tcp:${LocalBridgeServer.PORT} tcp:${LocalBridgeServer.PORT}\n\n" +
						"The private key never leaves Android Keystore."
				})
			}
		)
	}
}
