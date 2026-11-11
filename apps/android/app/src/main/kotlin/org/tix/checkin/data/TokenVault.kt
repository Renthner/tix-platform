package org.tix.checkin.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import org.tix.checkin.core.contract.TokenUnavailableException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypts the device token with an AES-256/GCM key that lives in the Android Keystore (never
 * leaves the secure hardware/OS store). Only the ciphertext is written to the database.
 */
object TokenVault {
    private const val ALIAS = "tix_device_token_v1"
    private const val PROVIDER = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    /** @throws TokenUnavailableException when the Keystore key cannot be created or used. */
    fun encrypt(plain: String): String = try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        Base64.encodeToString(cipher.iv + ct, Base64.NO_WRAP)
    } catch (e: Exception) {
        throw TokenUnavailableException("device key unavailable (encrypt)", e)
    }

    /**
     * @throws TokenUnavailableException when the key is gone, locked or the data is corrupt. This is NOT a
     * server answer: callers must never unpair or wipe because of it (the scan journal stays), they tell the
     * operator to restart the app or to pair again.
     */
    fun decrypt(encoded: String): String = try {
        val all = Base64.decode(encoded, Base64.NO_WRAP)
        val iv = all.copyOfRange(0, 12)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(all, 12, all.size - 12), Charsets.UTF_8)
    } catch (e: Exception) {
        throw TokenUnavailableException("device key unavailable (decrypt)", e)
    }

    fun deleteKey() {
        runCatching { KeyStore.getInstance(PROVIDER).apply { load(null) }.deleteEntry(ALIAS) }
    }
}
