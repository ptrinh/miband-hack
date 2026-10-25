plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Not in git: Xiaomi's SDK (./fetch-sdk.sh) and the keystore made from the repo's demo key (./make-keystore.sh).
val xmsSdk = file("libs/xms-wearable-lib_1.4_release.aar")
val demoKeystore = rootProject.file("keystore/demo-key.p12")

android {
    namespace = "uk.trinh.miband.remote"
    compileSdk = 35

    defaultConfig {
        // Must equal "package" in ../band/src/manifest.json, or interconnect will not link the two.
        applicationId = "uk.trinh.miband.remote"
        // 29: BluetoothHidDevice (28) and saving photos through MediaStore without a storage permission (29).
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        // Same certificate as the band rpk; interconnect checks it.
        create("demo") {
            storeFile = demoKeystore
            storeType = "pkcs12"
            storePassword = "miband-demo"
            keyAlias = "demo"
            keyPassword = "miband-demo"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("demo")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("demo")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

tasks.named("preBuild") {
    doFirst {
        if (!xmsSdk.exists()) throw GradleException("Missing ${xmsSdk.name}: run ./fetch-sdk.sh first")
        if (!demoKeystore.exists()) throw GradleException("Missing keystore/demo-key.p12: run ./make-keystore.sh first")
    }
}

dependencies {
    implementation(files(xmsSdk))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)

    testImplementation(libs.junit)
    testImplementation(libs.json)
}
