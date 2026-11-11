import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Pure Kotlin/JVM library: no Android dependencies. Everything that must be unit-testable
// (QR payload verification, scan decisions, URL policy) lives here.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    // Lightweight API only: platform Ed25519 needs API 33+, the app supports API 26+.
    implementation(libs.bouncycastle)
    // DTOs and the sync/scan logic are part of the public surface of :core.
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)

    testImplementation(platform(libs.junit5.bom))
    testImplementation(libs.junit5.jupiter)
    testImplementation(libs.kotlin.test)
    testRuntimeOnly(libs.junit5.launcher)
}

tasks.test {
    useJUnitPlatform()
}
