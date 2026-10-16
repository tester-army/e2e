plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "dev.e2e.examples.kmp"
    compileSdk = 37

    defaultConfig {
        // The package the tests open: app.bundleId in e2e/e2e.config.ts.
        applicationId = "dev.e2e.examples.kmp"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    implementation(projects.shared)
    implementation(libs.androidx.activity.compose)
    implementation(libs.compose.foundation)
}
