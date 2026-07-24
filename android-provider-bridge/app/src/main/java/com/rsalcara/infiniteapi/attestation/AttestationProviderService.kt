package com.rsalcara.infiniteapi.attestation

import android.app.NotificationChannel
import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder

class AttestationProviderService : Service() {
	private var server: LocalBridgeServer? = null

	override fun onCreate() {
		super.onCreate()
		val channelId = "infiniteapi-attestation-provider"
		getSystemService(NotificationManager::class.java).createNotificationChannel(
			NotificationChannel(channelId, "InfiniteAPI Android Provider", NotificationManager.IMPORTANCE_LOW)
		)
		startForeground(
			1,
			Notification.Builder(this, channelId)
				.setSmallIcon(android.R.drawable.stat_sys_upload_done)
				.setContentTitle("InfiniteAPI Android Provider")
				.setContentText("Attestation bridge is running on loopback")
				.setOngoing(true)
				.build()
		)
		server = LocalBridgeServer(this, AttestationRepository(this)).also { it.start() }
	}

	override fun onDestroy() {
		server?.close()
		server = null
		super.onDestroy()
	}

	override fun onBind(intent: Intent?): IBinder? = null
}
