import org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kotlin.multiplatform.library)
    alias(libs.plugins.compose.multiplatform)
    alias(libs.plugins.kotlin.compose)
}

kotlin {
    android {
        namespace = "dev.e2e.examples.kmp.shared"
        compileSdk = 37
        minSdk = 26
        androidResources {
            enable = true
        }
    }

    iosArm64()
    iosSimulatorArm64()

    // The iOS app links this framework; iosApp's build phase runs embedAndSignAppleFrameworkForXcode.
    targets.withType<KotlinNativeTarget>().configureEach {
        binaries.framework {
            baseName = "Shared"
            isStatic = true
        }
    }

    sourceSets {
        commonMain.dependencies {
            implementation(libs.compose.foundation)
            implementation(libs.compose.components.resources)
        }
    }
}

compose.resources {
    packageOfResClass = "dev.e2e.examples.kmp.resources"
}
