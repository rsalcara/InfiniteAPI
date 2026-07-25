plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

fun quotedBuildConfig(value: String): String =
	"\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val providerToken = providers.gradleProperty("INFINITEAPI_ANDROID_PROVIDER_TOKEN").orElse("").get()
// Application-wide identifiers extracted independently from the official
// Business and Messenger APK pairing paths. They are selected only after the
// server identifies the scanner application in pair-success.
val wabaClientAppId = "473039703209605"
val waMessengerClientAppId = "994766073959253"

android {
	namespace = "com.rsalcara.infiniteapi.attestation"
	compileSdk = 34

	defaultConfig {
		applicationId = "com.rsalcara.infiniteapi.attestation"
		minSdk = 28
		targetSdk = 34
		versionCode = 1
		versionName = "0.1.0"

		buildConfigField("String", "CLIENT_APP_ID", quotedBuildConfig(wabaClientAppId))
		buildConfigField("String", "WABA_CLIENT_APP_ID", quotedBuildConfig(wabaClientAppId))
		buildConfigField("String", "WA_MESSENGER_CLIENT_APP_ID", quotedBuildConfig(waMessengerClientAppId))
		buildConfigField("String", "PROVIDER_TOKEN", quotedBuildConfig(providerToken))
		buildConfigField("long", "ATTESTATION_TTL_MS", "600000L")
	}

	buildFeatures {
		buildConfig = true
	}

	buildTypes {
		release {
			isMinifyEnabled = false
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	kotlinOptions {
		jvmTarget = "17"
	}
}
