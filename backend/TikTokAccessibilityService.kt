
package com.mercado.auto

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast
import android.util.Log

class TikTokAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "MercadoAuto"
        private const val PREFS = "mercado_auto"
        private const val KEY_NEEDS_ATTENTION = "needs_attention"

        @Volatile
        var needsHumanAttention: Boolean = false
            private set

        private val securityPhrases = listOf(
            "captcha",
            "verify it's you",
            "verify your identity",
            "security check",
            "verification required",
            "confirm your identity",
            "unusual activity",
            "two-step verification",
            "vérifiez votre identité",
            "vérification de sécurité",
            "confirmez votre identité",
            "activité inhabituelle",
            "code de vérification",
            "confirmer votre compte",
            "mot de passe",
            "enter password",
            "sign in",
            "log in",
            "se connecter",
            "connectez-vous"
        )
    }

    override fun onServiceConnected() {
        super.onServiceConnected()

        Log.i(TAG, "Service d'accessibilité connecté.")

        Toast.makeText(
            this,
            "MERCADO AUTO : service connecté",
            Toast.LENGTH_SHORT
        ).show()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return

        val packageName = event.packageName?.toString() ?: return

        // Observer TikTok uniquement.
        if (packageName != "com.zhiliaoapp.musically" &&
            packageName != "com.ss.android.ugc.trill"
        ) {
            return
        }

        val visibleText = buildString {
            event.text?.forEach { text ->
                append(text)
                append(' ')
            }

            event.contentDescription?.let {
                append(it)
                append(' ')
            }

            event.source?.let { node ->
                try {
                    append(node.text ?: "")
                    append(' ')
                    append(node.contentDescription ?: "")
                } finally {
                    node.recycle()
                }
            }
        }.lowercase()

        val detectedPhrase = securityPhrases.firstOrNull {
            visibleText.contains(it)
        }

        if (detectedPhrase != null) {
            pauseForHumanIntervention(
                "Écran potentiellement sensible détecté : $detectedPhrase"
            )
        }
    }

    private fun pauseForHumanIntervention(reason: String) {
        if (needsHumanAttention) return

        needsHumanAttention = true

        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_NEEDS_ATTENTION, true)
            .putString("attention_reason", reason)
            .apply()

        Log.w(TAG, reason)

        Toast.makeText(
            this,
            "MERCADO AUTO en pause. Vérifie TikTok manuellement.",
            Toast.LENGTH_LONG
        ).show()
    }

    override fun onInterrupt() {
        Log.w(TAG, "Service interrompu.")
    }

    override fun onDestroy() {
        Log.i(TAG, "Service arrêté.")
        super.onDestroy()
    }
}
