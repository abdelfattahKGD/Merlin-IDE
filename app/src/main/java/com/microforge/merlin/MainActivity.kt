package com.microforge.merlin

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import java.io.File
import java.util.zip.ZipInputStream

class MainActivity : Activity() {
    private lateinit var web: WebView
    private var server: LocalServer? = null
    private val port = 18791 // fixed on purpose: VS Code keeps settings/state per origin (host:port)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        window.statusBarColor = Color.parseColor("#181818")
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.webview)
        val splash = findViewById<View>(R.id.splash)
        val msg = findViewById<TextView>(R.id.splash_text)
        WebView.setWebContentsDebuggingEnabled(true)
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
            allowFileAccess = false; textZoom = 100; setSupportZoom(false)
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { Log.d("Merlin", "${m.message()} (${m.sourceId()}:${m.lineNumber()})"); return true }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(v: WebView, url: String) { splash.postDelayed({ splash.visibility = View.GONE }, 600) }
        }
        Thread {
            try {
                val root = prepareWeb { runOnUiThread { msg.text = "Merlin - preparing (first run)..." } }
                server = LocalServer(root, port).also { it.start() }
                runOnUiThread { web.loadUrl("http://127.0.0.1:$port/") }
            } catch (e: Exception) {
                Log.e("Merlin", "startup failed", e)
                runOnUiThread { msg.text = "Startup failed: ${e.message}" }
            }
        }.start()
    }

    /** Unpacks assets/merlin-web.zip into filesDir/web-<versionCode> once per build. */
    private fun prepareWeb(onFirstRun: () -> Unit): File {
        @Suppress("DEPRECATION") val ver = packageManager.getPackageInfo(packageName, 0).versionCode
        val dir = File(filesDir, "web-$ver")
        if (File(dir, ".ok").exists()) return dir
        onFirstRun()
        filesDir.listFiles { f -> f.name.startsWith("web-") }?.forEach { it.deleteRecursively() }
        dir.mkdirs()
        ZipInputStream(assets.open("merlin-web.zip").buffered()).use { z ->
            var e = z.nextEntry
            while (e != null) {
                val out = File(dir, e.name).canonicalFile
                if (!out.path.startsWith(dir.canonicalPath)) throw SecurityException("bad zip entry")
                if (e.isDirectory) out.mkdirs() else { out.parentFile?.mkdirs(); out.outputStream().use { z.copyTo(it) } }
                e = z.nextEntry
            }
        }
        File(dir, ".ok").writeText("1")
        return dir
    }

    override fun onDestroy() { server?.stop(); super.onDestroy() }
}
