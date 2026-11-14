package org.tix.checkin.ui

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Reads scan results aloud with the platform text-to-speech engine (independent of TalkBack, which door
 * staff do not run). Created once per process: the engine starts asynchronously and the first [speak]
 * before it is ready is dropped rather than queued (a stale result must never be read late).
 *
 * Speech uses the notification usage, the same volume stream as the result tones (STREAM_NOTIFICATION), so
 * the one volume rocker that controls the beeps also controls the voice. A failed engine is reported through
 * [state] (NO_ENGINE) so the container can recreate it ([org.tix.checkin.AppContainer.restartSpeechIfNotReady]).
 */
class Speech(context: Context) {
    enum class State { STARTING, READY, NO_ENGINE, NO_LANGUAGE }

    private val _state = MutableStateFlow(State.STARTING)
    val state: StateFlow<State> = _state

    private val utterances = AtomicInteger()

    /** Utterances spoken to the end (diagnostics and the instrumented check). */
    val completed = AtomicInteger()
    private val locale: Locale = context.resources.configuration.locales[0] ?: Locale.getDefault()
    private var tts: TextToSpeech? = null

    init {
        tts = try {
            TextToSpeech(context.applicationContext) { status -> onInit(status) }
        } catch (_: RuntimeException) {
            _state.value = State.NO_ENGINE
            null
        }
    }

    private fun onInit(status: Int) {
        val engine = tts
        if (status != TextToSpeech.SUCCESS || engine == null) {
            _state.value = State.NO_ENGINE
            return
        }
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) = Unit
            override fun onDone(utteranceId: String?) {
                if (utteranceId?.endsWith("-pause") == false) completed.incrementAndGet()
            }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                Log.w(TAG, "speech failed for $utteranceId")
                _state.value = State.NO_ENGINE
            }
            override fun onError(utteranceId: String?, errorCode: Int) {
                Log.w(TAG, "speech failed for $utteranceId: $errorCode")
                if (errorCode == TextToSpeech.ERROR_SERVICE || errorCode == TextToSpeech.ERROR_NOT_INSTALLED_YET) {
                    _state.value = State.NO_ENGINE
                }
            }
        })
        engine.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        val lang = engine.setLanguage(locale)
        _state.value = if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
            // Fall back to the engine's default voice instead of staying silent.
            if (engine.setLanguage(Locale.getDefault()) >= TextToSpeech.LANG_AVAILABLE) State.READY else State.NO_LANGUAGE
        } else {
            State.READY
        }
    }

    /** Replaces whatever is being spoken; a short pause first lets the result tone finish. */
    fun speak(text: String) {
        val engine = tts ?: return
        if (_state.value != State.READY || text.isBlank()) return
        val id = "scan-${utterances.incrementAndGet()}"
        engine.playSilentUtterance(PAUSE_MS, TextToSpeech.QUEUE_FLUSH, "$id-pause")
        if (engine.speak(text, TextToSpeech.QUEUE_ADD, null, id) == TextToSpeech.ERROR) {
            // The engine service is gone: the next toggle / settings visit recreates this instance.
            _state.value = State.NO_ENGINE
        }
    }

    fun stop() {
        tts?.stop()
    }

    fun release() {
        tts?.shutdown()
        tts = null
    }

    private companion object {
        const val PAUSE_MS = 250L
        const val TAG = "TixSpeech"
    }
}
