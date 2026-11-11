# R8 rules for the release build (added to AGP's proguard-android-optimize.txt)
# plus the consumer rules shipped by AndroidX, Room, ML Kit, kotlinx and OkHttp.

# ── kotlinx.serialization: generated serializers and companions of the wire DTOs ──
-keepattributes *Annotation*, InnerClasses, Signature, RuntimeVisibleAnnotations, EnclosingMethod
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class org.tix.checkin.**$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class org.tix.checkin.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
    *** $serializer;
}
-keepclasseswithmembers class org.tix.checkin.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Wire enums are looked up by name (valueOf / entries) and persisted as text in Room.
-keepclassmembers enum org.tix.checkin.** { *; }

# ── Ed25519 ticket verification (BouncyCastle lightweight API; used directly, no JCA provider) ──
-keep class org.bouncycastle.crypto.signers.Ed25519Signer { *; }
-keep class org.bouncycastle.crypto.params.Ed25519PublicKeyParameters { *; }
-keep class org.bouncycastle.math.ec.rfc8032.** { *; }
-keep class org.bouncycastle.math.raw.** { *; }
-dontwarn org.bouncycastle.**

# ── Ktor / OkHttp ──
-dontwarn org.slf4j.**
-dontwarn java.lang.management.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.jsse.**
-dontwarn org.openjsse.**
-dontwarn io.netty.**
-dontwarn reactor.blockhound.**
-keep class io.ktor.client.engine.okhttp.OkHttpEngineContainer { *; }
-keepclassmembers class io.ktor.** { volatile <fields>; }

# ── Kotlin coroutines (service loader for the Android main dispatcher) ──
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}

# ── ML Kit / CameraX / Room / WorkManager ship consumer rules. Keep our WorkManager worker. ──
-keep class org.tix.checkin.sync.SyncWorker { *; }

# ML Kit components are registered through manifest meta-data and instantiated reflectively; without
# the registrar constructors BarcodeScanning.getClient() yields null (NPE at the first scanner screen).
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
-keep class com.google.mlkit.common.internal.MlKitComponentDiscoveryService { *; }
-keep class com.google.mlkit.vision.barcode.internal.** { <init>(...); }
-keep class org.tix.checkin.lan.LanMasterService { *; }

# androidx.window (pulled in by Compose/CameraX) references optional vendor extension classes via reflection.
-dontwarn androidx.window.extensions.**
-dontwarn androidx.window.sidecar.**
