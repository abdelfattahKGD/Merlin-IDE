package com.microforge.merlin

import android.content.Context
import android.system.Os
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Optional runtime packs: downloaded on demand (from this repo's GitHub release), checked with SHA-256, unpacked into the app's private folder. */
class Packs(ctx: Context, private val pythonUrl: String) {
    private val root = File(ctx.filesDir, "packs")
    private val cache = ctx.cacheDir
    val pythonHome = File(root, "python")
    @Volatile private var state = "idle"
    @Volatile private var percent = 0
    @Volatile private var error: String? = null

    fun pythonInstalled() = File(root, "python.ok").exists() && File(pythonHome, "bin/python3").exists()

    fun status(): JSONObject = JSONObject()
        .put("installed", pythonInstalled()).put("state", state).put("percent", percent)
        .put("error", error ?: JSONObject.NULL)

    fun removePython() {
        File(root, "python.ok").delete()
        pythonHome.deleteRecursively()
        state = "idle"; percent = 0; error = null
    }

    fun installPython() {
        if (state == "downloading" || state == "extracting") return
        state = "downloading"; percent = 0; error = null
        Thread {
            try {
                if (pythonUrl.isEmpty()) throw IOException("no pack source configured in this build")
                val tgz = File(cache, "python-pack.tar.gz")
                val want = httpText("$pythonUrl.sha256").trim().split(Regex("\\s+"))[0].lowercase()
                download(pythonUrl, tgz) { percent = it }
                if (sha256(tgz) != want) throw IOException("checksum mismatch - download corrupted")
                state = "extracting"; percent = 0
                val tmp = File(root, "python.tmp")
                tmp.deleteRecursively(); root.mkdirs()
                TarExtract.extract(tgz, tmp, { target, link -> Os.symlink(target, link.path) }) { percent = it }
                File(root, "python.ok").delete()
                pythonHome.deleteRecursively()
                if (!File(tmp, "python").renameTo(pythonHome)) throw IOException("could not move the pack into place")
                tmp.deleteRecursively()
                File(root, "python.ok").writeText("1")
                tgz.delete()
                state = "done"; percent = 100
            } catch (e: Exception) {
                state = "error"; error = e.message ?: e.toString()
            }
        }.start()
    }

    private fun open(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 20000; c.readTimeout = 60000; c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", "Merlin-Android")
        if (c.responseCode !in 200..299) throw IOException("HTTP ${c.responseCode} for $url")
        return c
    }
    private fun httpText(url: String): String { val c = open(url); return c.inputStream.bufferedReader().use { it.readText() } }
    private fun download(url: String, dest: File, progress: (Int) -> Unit) {
        val c = open(url)
        val total = c.contentLengthLong
        c.inputStream.use { ins ->
            FileOutputStream(dest).use { out ->
                val buf = ByteArray(65536)
                var done = 0L
                while (true) {
                    val r = ins.read(buf)
                    if (r < 0) break
                    out.write(buf, 0, r); done += r
                    if (total > 0) progress((done * 100 / total).toInt().coerceIn(0, 100))
                }
            }
        }
    }
    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { i -> val b = ByteArray(65536); while (true) { val r = i.read(b); if (r < 0) break; md.update(b, 0, r) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
