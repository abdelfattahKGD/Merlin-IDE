plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
val appSuffix = (findProperty("appSuffix") as String?) ?: ""
android {
    namespace = "com.microforge.merlin"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.microforge.merlin"
        minSdk = 24
        targetSdk = 28 // personal build: lets the app run binaries from its own folders (step 2)
        versionCode = (findProperty("verCode") as String?)?.toInt() ?: 1
        versionName = "0.1"
        applicationIdSuffix = appSuffix   // ".slim" installs next to the full app so the two can be compared
        resValue("string", "app_name", if (appSuffix.isEmpty()) "Merlin" else "Merlin Slim")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    androidResources { noCompress += listOf("zip") }
    packaging { jniLibs { useLegacyPackaging = true } }
    lint { abortOnError = false; checkReleaseBuilds = false }
}
dependencies { implementation("org.nanohttpd:nanohttpd:2.3.1") }
