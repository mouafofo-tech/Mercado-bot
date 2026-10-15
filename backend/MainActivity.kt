
package com.mercado.auto

import android.app.Activity
import android.os.Bundle
import android.content.Intent
import android.provider.Settings
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.graphics.Color
import android.view.Gravity
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {

    private lateinit var backendInput: EditText
    private lateinit var statusText: TextView

    private val preferences by lazy {
        getSharedPreferences("mercado_auto", MODE_PRIVATE)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(32, 40, 32, 32)
            setBackgroundColor(Color.WHITE)
        }

        val title = TextView(this).apply {
            text = "MERCADO AUTO"
            textSize = 26f
            setTextColor(Color.rgb(30, 30, 30))
            gravity = Gravity.CENTER
        }

        val description = TextView(this).apply {
            text = "Contrôle du backend et du service TikTok"
            textSize = 16f
            setPadding(0, 16, 0, 24)
            setTextColor(Color.DKGRAY)
        }

        backendInput = EditText(this).apply {
            hint = "URL du backend Render"
            textSize = 16f
            singleLine = true
            setText(
                preferences.getString(
                    "backend_url",
                    "https://TON-SERVICE.onrender.com"
                )
            )
        }

        val saveButton = Button(this).apply {
            text = "Enregistrer l'adresse"
            setOnClickListener {
                val address = backendInput.text.toString()
                    .trim()
                    .trimEnd('/')

                if (!address.startsWith("https://")) {
                    statusText.text =
                        "Utilise une adresse HTTPS valide."
                    return@setOnClickListener
                }

                preferences.edit()
                    .putString("backend_url", address)
                    .apply()

                statusText.text = "Adresse enregistrée."
            }
        }

        val testButton = Button(this).apply {
            text = "Tester le backend"
            setOnClickListener {
                testBackend()
            }
        }

        val accessibilityButton = Button(this).apply {
            text = "Configurer le service Android"
            setOnClickListener {
                startActivity(
                    Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                )
            }
        }

        statusText = TextView(this).apply {
            text = "En attente de vérification."
            textSize = 15f
            setTextColor(Color.DKGRAY)
            setPadding(0, 20, 0, 20)
        }

        layout.addView(
            title,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )
        layout.addView(description)
        layout.addView(
            backendInput,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )
        layout.addView(saveButton)
        layout.addView(testButton)
        layout.addView(accessibilityButton)
        layout.addView(statusText)

        setContentView(layout)
    }

    private fun testBackend() {
        val address = backendInput.text.toString()
            .trim()
            .trimEnd('/')

        if (!address.startsWith("https://")) {
            statusText.text = "Entre une URL HTTPS valide."
            return
        }

        preferences.edit()
            .putString("backend_url", address)
            .apply()

        statusText.text = "Connexion en cours…"

        Thread {
            var connection: HttpURLConnection? = null

            try {
                connection = URL("$address/health")
                    .openConnection() as HttpURLConnection

                connection.requestMethod = "GET"
                connection.connectTimeout = 10000
                connection.readTimeout = 10000

                val responseCode = connection.responseCode

                val response = if (responseCode in 200..299) {
                    connection.inputStream.bufferedReader().use {
                        it.readText()
                    }
                } else {
                    connection.errorStream
                        ?.bufferedReader()
                        ?.use { it.readText() }
                        ?: ""
                }

                runOnUiThread {
                    statusText.text = if (
                        responseCode in 200..299 &&
                        response.contains("\"ok\":true")
                    ) {
                        "Backend accessible.\n$response"
                    } else {
                        "Réponse du serveur : HTTP $responseCode\n$response"
                    }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    statusText.text =
                        "Connexion échouée : ${error.localizedMessage}"
                }
            } finally {
                connection?.disconnect()
            }
        }.start()
    }
}
