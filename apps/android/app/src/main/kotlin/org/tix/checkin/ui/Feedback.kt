package org.tix.checkin.ui

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import org.tix.checkin.core.contract.ScanColor

/**
 * Distinct sound + haptic pattern per result colour. Tones come from the platform's
 * ToneGenerator (no audio assets). The generator is created once: creating one per scan costs latency.
 * Tones play on the notification stream (sonification usage), so a muted media volume does not silence the scanner
 * while ringer silent/Do-Not-Disturb still does (deliberately not bypassed).
 */
class Feedback(context: Context) {
    private val tone: ToneGenerator? = try {
        ToneGenerator(AudioManager.STREAM_NOTIFICATION, 100)
    } catch (_: RuntimeException) {
        null
    }

    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }

    fun play(color: ScanColor, sound: Boolean, vibrate: Boolean) {
        if (sound) {
            when (color) {
                ScanColor.GREEN -> tone?.startTone(ToneGenerator.TONE_PROP_ACK, 150)
                ScanColor.YELLOW -> tone?.startTone(ToneGenerator.TONE_PROP_PROMPT, 400)
                ScanColor.RED -> tone?.startTone(ToneGenerator.TONE_CDMA_ABBR_ALERT, 700)
            }
        }
        if (vibrate && vibrator?.hasVibrator() == true) {
            val pattern = when (color) {
                ScanColor.GREEN -> longArrayOf(0, 60)
                ScanColor.YELLOW -> longArrayOf(0, 120, 80, 120)
                ScanColor.RED -> longArrayOf(0, 400, 100, 400)
            }
            vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
        }
    }

    /** Neutral information (e.g. "ticket not synced yet"): one soft beep and a short tick, no alarm tone. */
    fun playInfo(sound: Boolean, vibrate: Boolean) {
        if (sound) tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 120)
        if (vibrate && vibrator?.hasVibrator() == true) {
            vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 40), -1))
        }
    }

    fun release() {
        tone?.release()
    }
}
