package com.microforge.merlin

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.util.zip.ZipInputStream

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var splash: View
    private lateinit var msg: TextView
    private var server: LocalServer? = null
    private var started = false
    private val port = 18791 // fixed on purpose: VS Code keeps settings/state per origin (host:port)
    private val diagLog = StringBuilder()

    private fun note(s: String) {
        Log.d("Merlin", s)
        if (diagLog.length < 8000) diagLog.append(s).append('\n')
    }

    private fun hasStorage() = Build.VERSION.SDK_INT < 23 ||
        checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        window.statusBarColor = Color.parseColor("#181818")
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.webview)
        splash = findViewById(R.id.splash)
        msg = findViewById(R.id.splash_text)
        WebView.setWebContentsDebuggingEnabled(true)
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true
            allowFileAccess = false; textZoom = 100; setSupportZoom(false)
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR || m.messageLevel() == ConsoleMessage.MessageLevel.WARNING)
                    note("[${m.messageLevel()}] ${m.message()} @ ${m.sourceId()}:${m.lineNumber()}")
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(v: WebView, url: String) { splash.postDelayed({ splash.visibility = View.GONE }, 600) }
            override fun onRenderProcessGone(v: WebView, d: RenderProcessGoneDetail): Boolean {
                // Without this Android kills the whole app when the web renderer dies (typically out of memory on 3 GB phones).
                val why = if (d.didCrash()) "crashed" else "was killed by Android (probably out of memory)"
                getSharedPreferences("merlin", 0).edit().putString("lastCrash", "The web view $why").apply()
                runOnUiThread { (v.parent as? FrameLayout)?.removeView(v); v.destroy(); recreate() }
                return true
            }
            override fun onReceivedHttpError(v: WebView, r: WebResourceRequest, e: WebResourceResponse) { note("HTTP ${e.statusCode} ${r.url}") }
            override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) { note("ERR ${e.description} ${r.url}") }
        }
        getSharedPreferences("merlin", 0).let { pr ->
            pr.getString("lastCrash", null)?.let { c ->
                note("Previous session: $c")
                Toast.makeText(this, "Merlin restarted: $c", Toast.LENGTH_LONG).show()
                pr.edit().remove("lastCrash").apply()
            }
        }
        if (Build.VERSION.SDK_INT >= 23 && !hasStorage())
            requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE, Manifest.permission.READ_EXTERNAL_STORAGE), 1)
        else startAll()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) { startAll() }

    /** Workspace = /storage/emulated/0/Merlin when storage is allowed, otherwise the app's private folder. */
    private fun workspaceDir(): File {
        val ext = File(Environment.getExternalStorageDirectory(), "Merlin")
        val dir = if (hasStorage() && (ext.isDirectory || ext.mkdirs())) ext else File(filesDir, "workspace")
        dir.mkdirs()
        if (dir.list().isNullOrEmpty()) File(dir, "hello.sh").writeText("echo \"Hello from Merlin\"\nuname -a\n")
        return dir
    }

    private fun startAll() {
        if (started) return
        started = true
        Thread {
            try {
                val root = prepareWeb { runOnUiThread { msg.text = "Merlin - preparing (first run)..." } }
                val ws = workspaceDir()
                val packUrl = try { JSONObject(assets.open("packs.json").bufferedReader().use { it.readText() }).optString("pythonUrl") } catch (e: Exception) { "" }
                server = LocalServer(root, ws, cacheDir, Packs(this, packUrl), port).also { it.start() }
                runOnUiThread {
                    web.loadUrl("http://127.0.0.1:$port/")
                    // If VS Code never started, its fallback message is still on the page: show what went wrong.
                    web.postDelayed({
                        web.evaluateJavascript("!!document.getElementById('vscode-startup-fallback')") { r -> if (r == "true") showDiag() }
                    }, 20000)
                }
            } catch (e: Exception) {
                Log.e("Merlin", "startup failed", e)
                runOnUiThread { msg.text = "Startup failed: ${e.message}" }
            }
        }.start()
    }

    private fun showDiag() {
        val pkg = if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } else null
        val t = TextView(this).apply {
            text = "Merlin diagnostics\nWebView: $pkg\nAndroid: ${Build.VERSION.RELEASE}\n\n$diagLog\n(tap to close)"
            setTextColor(Color.parseColor("#d4d4d4")); textSize = 11f; typeface = Typeface.MONOSPACE; setPadding(24, 24, 24, 24)
        }
        val sv = ScrollView(this)
        sv.setBackgroundColor(Color.parseColor("#E6000000"))
        sv.addView(t)
        sv.setOnClickListener { (web.parent as FrameLayout).removeView(sv) }
        (web.parent as FrameLayout).addView(sv, FrameLayout.LayoutParams(-1, -1))
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
