plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

fun quotedBuildConfig(value: String): String =
	"\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val clientAppId = providers.gradleProperty("INFINITEAPI_ANDROID_CLIENT_APP_ID").orElse("").get()
val providerToken = providers.gradleProperty("INFINITEAPI_ANDROID_PROVIDER_TOKEN").orElse("").get()

android {
	namespace = "com.rsalcara.infiniteapi.attestation"
	compileSdk = 34

	defaultConfig {
		applicationId = "com.rsalcara.infiniteapi.attestation"
		minSdk = 28
		targetSdk = 34
		versionCode = 1
		versionName = "0.1.0"

		buildConfigField("String", "CLIENT_APP_ID", quotedBuildConfig(clientAppId))
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
