package com.microforge.merlin

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.util.zip.GZIPInputStream

/** Minimal tar.gz reader (GNU long names, symlinks, hard links, exec bit) so packs can be unpacked without extra libraries. */
object TarExtract {
    private class Counting(i: InputStream) : FilterInputStream(i) {
        var count = 0L
        override fun read(): Int { val r = super.read(); if (r >= 0) count++; return r }
        override fun read(b: ByteArray, off: Int, len: Int): Int { val r = super.read(b, off, len); if (r > 0) count += r; return r }
    }

    private fun fill(i: InputStream, b: ByteArray): Boolean {
        var n = 0
        while (n < b.size) {
            val r = i.read(b, n, b.size - n)
            if (r < 0) { if (n == 0) return false; throw IOException("truncated tar") }
            n += r
        }
        return true
    }
    private fun cstr(b: ByteArray, off: Int, len: Int): String {
        var e = off
        while (e < off + len && b[e] != 0.toByte()) e++
        return String(b, off, e - off, Charsets.UTF_8)
    }
    private fun octal(b: ByteArray, off: Int, len: Int): Long {
        val s = String(b, off, len, Charsets.US_ASCII).trim { it == ' ' || it == '\u0000' }
        return if (s.isEmpty()) 0L else s.toLong(8)
    }
    private fun pad(size: Long) = (512 - size % 512) % 512
    private fun skip(i: InputStream, n: Long) {
        var left = n
        val buf = ByteArray(8192)
        while (left > 0) {
            val r = i.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) throw IOException("truncated tar")
            left -= r
        }
    }
    private fun readString(i: InputStream, size: Long): String {
        val b = ByteArray(size.toInt())
        var n = 0
        while (n < b.size) {
            val r = i.read(b, n, b.size - n)
            if (r < 0) throw IOException("truncated tar")
            n += r
        }
        skip(i, pad(size))
        var e = b.size
        while (e > 0 && b[e - 1] == 0.toByte()) e--
        return String(b, 0, e, Charsets.UTF_8)
    }

    fun extract(file: File, dest: File, symlink: (target: String, link: File) -> Unit, progress: (Int) -> Unit) {
        val total = maxOf(file.length(), 1L)
        val counting = Counting(FileInputStream(file))
        dest.mkdirs()
        val base = dest.canonicalFile
        GZIPInputStream(BufferedInputStream(counting, 1 shl 16)).use { ins ->
            val hdr = ByteArray(512)
            var longName: String? = null
            var longLink: String? = null
            while (fill(ins, hdr)) {
                if (hdr.all { it == 0.toByte() }) break
                var name = cstr(hdr, 0, 100)
                val mode = octal(hdr, 100, 8).toInt()
                val size = octal(hdr, 124, 12)
                val type = (hdr[156].toInt() and 0xff).toChar()
                val link = cstr(hdr, 157, 100)
                if (String(hdr, 257, 5, Charsets.US_ASCII) == "ustar") {
                    val prefix = cstr(hdr, 345, 155)
                    if (prefix.isNotEmpty()) name = "$prefix/$name"
                }
                if (type == 'L') { longName = readString(ins, size); continue }
                if (type == 'K') { longLink = readString(ins, size); continue }
                if (type == 'x' || type == 'g') { skip(ins, size + pad(size)); continue }
                val path = (longName ?: name).trimEnd('/')
                val target = longLink ?: link
                longName = null; longLink = null
                val out = File(base, path)
                val parent = out.parentFile!!.canonicalFile.path
                if (parent != base.path && !parent.startsWith(base.path + File.separator)) throw SecurityException("bad tar entry: $path")
                when (type) {
                    '5' -> out.mkdirs()
                    '2' -> { out.parentFile?.mkdirs(); out.delete(); symlink(target, out) }
                    '1' -> { out.parentFile?.mkdirs(); File(base, target).copyTo(out, true); if ((mode and 73) != 0) out.setExecutable(true, false) }
                    else -> {
                        out.parentFile?.mkdirs()
                        FileOutputStream(out).use { o ->
                            var left = size
                            val buf = ByteArray(65536)
                            while (left > 0) {
                                val r = ins.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                                if (r < 0) throw IOException("truncated tar")
                                o.write(buf, 0, r)
                                left -= r
                            }
                        }
                        if ((mode and 73) != 0) out.setExecutable(true, false)
                    }
                }
                skip(ins, pad(size))
                progress((counting.count * 100 / total).toInt().coerceIn(0, 100))
            }
        }
    }
}
