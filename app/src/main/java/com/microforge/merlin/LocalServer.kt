package com.microforge.merlin

import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger

// Serves the VS Code Web build (static) and the /api used by the built-in Merlin extension: files + shell.
class LocalServer(private val web: File, private val workspace: File, private val tmp: File, port: Int) : NanoHTTPD("127.0.0.1", port) {
    private val mime = mapOf(
        "html" to "text/html; charset=utf-8", "js" to "text/javascript; charset=utf-8", "mjs" to "text/javascript; charset=utf-8",
        "css" to "text/css; charset=utf-8", "json" to "application/json; charset=utf-8", "svg" to "image/svg+xml",
        "png" to "image/png", "ico" to "image/x-icon", "ttf" to "font/ttf", "woff" to "font/woff", "woff2" to "font/woff2",
        "wasm" to "application/wasm", "txt" to "text/plain; charset=utf-8", "md" to "text/markdown; charset=utf-8")
    private val terms = ConcurrentHashMap<String, Term>()
    private val nextId = AtomicInteger(0)

    override fun serve(session: IHTTPSession): Response {
        if (session.uri.startsWith("/api/")) {
            val r = try { api(session) } catch (e: Exception) { text(Response.Status.INTERNAL_ERROR, e.message ?: "error") }
            r.addHeader("Access-Control-Allow-Origin", "*")
            r.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            r.addHeader("Access-Control-Allow-Headers", "*")
            return r
        }
        var p = session.uri.substringBefore('?')
        p = if (p == "/") "/index.html" else if (p.startsWith("/s/")) p.substring(2) else p
        val f = File(web, p).canonicalFile
        if (!f.path.startsWith(web.canonicalPath) || !f.isFile)
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404")
        val r = newFixedLengthResponse(Response.Status.OK, mime[f.extension.lowercase()] ?: "application/octet-stream", FileInputStream(f), f.length())
        r.addHeader("Cache-Control", "no-cache")
        return r
    }

    private fun text(st: Response.IStatus, msg: String) = newFixedLengthResponse(st, "text/plain; charset=utf-8", msg)
    private fun json(o: Any) = newFixedLengthResponse(Response.Status.OK, "application/json; charset=utf-8", o.toString())

    private fun resolve(p: String?): File {
        val base = workspace.canonicalFile
        val f = File(base, (p ?: "/").trimStart('/')).canonicalFile
        require(f.path == base.path || f.path.startsWith(base.path + File.separator)) { "outside workspace" }
        return f
    }

    private fun body(s: IHTTPSession): ByteArray {
        val len = s.headers["content-length"]?.toIntOrNull() ?: 0
        val buf = ByteArray(len)
        var n = 0
        while (n < len) { val r = s.inputStream.read(buf, n, len - n); if (r < 0) break; n += r }
        return buf
    }

    private fun api(s: IHTTPSession): Response {
        if (s.method == Method.OPTIONS) return text(Response.Status.OK, "")
        val path = s.uri.removePrefix("/api/")
        val q = s.parms
        if (path == "info") return json(JSONObject().put("root", workspace.canonicalPath))
        if (path.startsWith("fs/")) return fs(path.removePrefix("fs/"), q, s)
        if (path == "term/start") {
            val id = nextId.incrementAndGet().toString()
            terms[id] = Term(workspace.canonicalFile)
            return json(JSONObject().put("id", id))
        }
        if (path.startsWith("term/")) {
            val parts = path.split('/')
            val t = terms[parts.getOrNull(1)] ?: return text(Response.Status.NOT_FOUND, "no such terminal")
            when (parts.getOrNull(2)) {
                "out" -> return newChunkedResponse(Response.Status.OK, "application/x-ndjson", QueueStream(t.events))
                "in" -> t.input(String(body(s), Charsets.UTF_8))
                "kill" -> t.kill()
                "pyin" -> t.pyLines.put(String(body(s), Charsets.UTF_8))
                "pystdin" -> {
                    t.waiters.incrementAndGet()
                    try { return text(Response.Status.OK, t.pyLines.take()) } finally { t.waiters.decrementAndGet() }
                }
                "pyreset" -> { val n = t.waiters.get(); t.pyLines.clear(); repeat(n) { t.pyLines.put("\u0000") } }
                "close" -> { t.kill(); t.events.put(ByteArray(0)); terms.remove(parts[1]) }
            }
            return text(Response.Status.OK, "ok")
        }
        return text(Response.Status.NOT_FOUND, "unknown api")
    }

    private fun fs(op: String, q: Map<String, String>, s: IHTTPSession): Response {
        val nf = Response.Status.NOT_FOUND
        when (op) {
            "stat" -> {
                val f = resolve(q["p"]); if (!f.exists()) return text(nf, "nf")
                return json(JSONObject().put("type", if (f.isDirectory) 2 else 1).put("size", f.length()).put("mtime", f.lastModified()).put("ctime", f.lastModified()))
            }
            "list" -> {
                val f = resolve(q["p"]); if (!f.isDirectory) return text(nf, "nf")
                val a = JSONArray()
                f.listFiles()?.sortedBy { it.name }?.forEach { a.put(JSONArray().put(it.name).put(if (it.isDirectory) 2 else 1)) }
                return json(a)
            }
            "read" -> {
                val f = resolve(q["p"]); if (!f.isFile) return text(nf, "nf")
                return newFixedLengthResponse(Response.Status.OK, "application/octet-stream", FileInputStream(f), f.length())
            }
            "write" -> {
                val f = resolve(q["p"]); val data = body(s)
                if (f.isDirectory) return text(Response.Status.FORBIDDEN, "is a directory")
                if (q["create"] == "0" && !f.exists()) return text(nf, "nf")
                if (q["overwrite"] == "0" && f.exists()) return text(Response.Status.FORBIDDEN, "exists")
                f.parentFile?.mkdirs(); f.writeBytes(data)
            }
            "delete" -> { val f = resolve(q["p"]); if (!f.exists()) return text(nf, "nf"); f.deleteRecursively() }
            "mkdir" -> { resolve(q["p"]).mkdirs() }
            "rename" -> {
                val a = resolve(q["from"]); val b = resolve(q["to"])
                if (!a.exists()) return text(nf, "nf")
                if (b.exists() && q["overwrite"] != "1") return text(Response.Status.FORBIDDEN, "exists")
                b.parentFile?.mkdirs()
                if (!a.renameTo(b)) { a.copyRecursively(b, true); a.deleteRecursively() }
            }
            else -> return text(nf, "unknown fs op")
        }
        return text(Response.Status.OK, "ok")
    }

    /** One shell session: each line is a command (sh -c); lines typed while a command runs go to its stdin. */
    inner class Term(var cwd: File) {
        val events = LinkedBlockingQueue<ByteArray>()
        val pyLines = LinkedBlockingQueue<String>()   // lines typed while a Python script runs (its stdin)
        val waiters = AtomicInteger(0)
        @Volatile private var proc: Process? = null

        init { done(0) }

        private fun emit(o: JSONObject) { events.put((o.toString() + "\n").toByteArray(Charsets.UTF_8)) }
        private fun done(code: Int) { emit(JSONObject().put("t", "x").put("code", code).put("cwd", cwd.path)) }
        private fun out(d: String) { emit(JSONObject().put("t", "o").put("d", d)) }

        fun input(line: String) {
            val p = proc
            if (p != null) { try { p.outputStream.write((line + "\n").toByteArray()); p.outputStream.flush() } catch (e: Exception) { } ; return }
            val cmd = line.trim()
            if (cmd.isEmpty()) { done(0); return }
            if (cmd == "cd" || cmd.startsWith("cd ")) {
                val arg = cmd.removePrefix("cd").trim().trim('"', '\'')
                val t = if (arg.isEmpty()) workspace else File(arg).let { if (it.isAbsolute) it else File(cwd, arg) }
                if (t.isDirectory) { cwd = t.canonicalFile; done(0) } else { out("cd: no such directory: $arg\n"); done(1) }
                return
            }
            run(cmd)
        }

        private fun run(cmd: String) {
            try {
                val pb = ProcessBuilder("/system/bin/sh", "-c", cmd).directory(cwd).redirectErrorStream(true)
                pb.environment().apply {
                    put("HOME", workspace.path); put("TMPDIR", tmp.path); put("PWD", cwd.path)
                    put("PATH", "/system/bin:/system/xbin:" + (System.getenv("PATH") ?: ""))
                }
                val p = pb.start(); proc = p
                Thread {
                    val r = p.inputStream.reader(Charsets.UTF_8); val buf = CharArray(4096)
                    while (true) { val n = r.read(buf); if (n < 0) break; out(String(buf, 0, n)) }
                    val code = p.waitFor(); proc = null; done(code)
                }.start()
            } catch (e: Exception) { out("error: ${e.message}\n"); done(127) }
        }

        fun kill() { proc?.destroy() }
    }

    /** Blocking stream over the queue; an empty array marks the end. */
    class QueueStream(private val q: LinkedBlockingQueue<ByteArray>) : InputStream() {
        private var cur = ByteArray(0)
        private var pos = 0
        override fun read(): Int { val b = ByteArray(1); return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xff }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (pos >= cur.size) { cur = q.take(); pos = 0; if (cur.isEmpty()) return -1 }
            val n = minOf(len, cur.size - pos)
            System.arraycopy(cur, pos, b, off, n); pos += n
            return n
        }
    }
}
