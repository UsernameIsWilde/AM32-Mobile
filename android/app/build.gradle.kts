import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: scripts\build.ps1 generates signing\keystore.properties + the keystore
// on the first build. Without it the release build falls back to the debug key.
val keystoreProps = Properties().apply {
    val f = rootProject.file("signing/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "app.am32.offline"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.am32.offline"
        minSdk = 24
        // 34 on purpose: targeting 35 forces edge-to-edge and the web UI would end up
        // underneath the status and navigation bars.
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (keystoreProps.containsKey("storeFile")) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    androidResources {
        // The default pattern drops every directory starting with "_", which would
        // silently remove the web app's _nuxt folder from the APK.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:!CVS:!thumbs.db:!picasa.ini:!*~"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation("com.github.mik3y:usb-serial-for-android:3.10.0")
}
