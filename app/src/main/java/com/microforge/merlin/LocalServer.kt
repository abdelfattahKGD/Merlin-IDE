package com.microforge.merlin

import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream

// Serves the extracted VS Code Web build on 127.0.0.1. Step 2 adds the files and terminal API here.
class LocalServer(private val root: File, port: Int) : NanoHTTPD("127.0.0.1", port) {
    private val mime = mapOf(
        "html" to "text/html; charset=utf-8", "js" to "text/javascript; charset=utf-8", "mjs" to "text/javascript; charset=utf-8",
        "css" to "text/css; charset=utf-8", "json" to "application/json; charset=utf-8", "svg" to "image/svg+xml",
        "png" to "image/png", "ico" to "image/x-icon", "ttf" to "font/ttf", "woff" to "font/woff", "woff2" to "font/woff2",
        "wasm" to "application/wasm", "txt" to "text/plain; charset=utf-8", "md" to "text/markdown; charset=utf-8")

    override fun serve(session: IHTTPSession): Response {
        var p = session.uri.substringBefore('?')
        p = if (p == "/") "/index.html" else if (p.startsWith("/s/")) p.substring(2) else p
        val f = File(root, p).canonicalFile
        if (!f.path.startsWith(root.canonicalPath) || !f.isFile)
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404")
        val r = newFixedLengthResponse(Response.Status.OK, mime[f.extension.lowercase()] ?: "application/octet-stream", FileInputStream(f), f.length())
        r.addHeader("Cache-Control", "public, max-age=3600")
        return r
    }
}
