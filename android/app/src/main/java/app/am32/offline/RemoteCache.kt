package app.am32.offline

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Everything the app gets from the am32.ca server (firmware listings, firmware files,
 * default settings images) goes through here and is kept on the phone, so whatever was
 * fetched once keeps working without a network.
 *
 * Only [REMOTE] is ever contacted, always over https. Calls block: use from a worker thread
 * (WebView's request interception already runs on one).
 */
class RemoteCache(context: Context) {

    companion object {
        private const val TAG = "AM32Remote"
        const val REMOTE = "https://am32.ca"

        private const val CONNECT_TIMEOUT_MS = 6000
        private const val READ_TIMEOUT_MS = 30000

        /** Result of [download] when the server could not be reached at all. */
        const val UNREACHABLE = 0

        /**
         * A complete Intel HEX file: every record well formed with a correct checksum, and
         * the end-of-file record present. A truncated download or an error page cannot pass,
         * which matters because these bytes end up in an ESC's flash.
         */
        fun isIntelHex(data: ByteArray): Boolean {
            val lines = String(data, Charsets.ISO_8859_1).split('\n').map { it.trim() }.filter { it.isNotEmpty() }
            if (lines.size < 2 || !lines.last().equals(":00000001FF", ignoreCase = true)) {
                return false
            }
            for (line in lines) {
                if (line[0] != ':' || line.length < 11 || line.length % 2 == 0) {
                    return false
                }
                var sum = 0
                var index = 1
                while (index < line.length) {
                    sum += line.substring(index, index + 2).toIntOrNull(16) ?: return false
                    index += 2
                }
                val count = line.substring(1, 3).toInt(16)
                if ((line.length - 1) / 2 != count + 5 || (sum and 0xFF) != 0) {
                    return false
                }
            }
            return true
        }
    }

    class Response(val status: Int, val body: ByteArray?)

    private val root = File(context.filesDir, "am32.ca")
    private val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val userAgent = "AM32-Offline-Android/${BuildConfig.VERSION_NAME}"

    /** When each refreshable entry was last fetched in this run of the app. */
    private val refreshed = ConcurrentHashMap<String, Long>()
    private val locks = ConcurrentHashMap<String, Any>()

    /** False after a request failed on the network level; true again after one that worked. */
    @Volatile
    var serverReachable = true
        private set

    /** Phone has a network that claims internet access (says nothing about am32.ca itself). */
    fun isOnline(): Boolean = try {
        val network = connectivity.activeNetwork
        val capabilities = network?.let { connectivity.getNetworkCapabilities(it) }
        capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (e: Exception) {
        false
    }

    /** True when the server can be expected to answer right now. */
    fun canReachServer(): Boolean = isOnline() && serverReachable

    fun file(relativePath: String): File = File(root, relativePath)

    fun has(relativePath: String): Boolean = file(relativePath).let { it.isFile && it.length() > 0 }

    /**
     * For content that changes on the server (listings): fetch it when it has not been
     * fetched for [maxAgeMs], fall back to the stored copy otherwise or when offline.
     * Returns null when there is neither a network nor a stored copy.
     */
    fun refreshable(
        relativePath: String,
        remotePath: String,
        maxAgeMs: Long,
        accept: (ByteArray) -> Boolean
    ): ByteArray? = synchronized(lockFor(relativePath)) {
        val target = file(relativePath)
        val last = refreshed[relativePath] ?: 0L
        val stale = System.currentTimeMillis() - last > maxAgeMs
        if ((stale || !target.isFile) && isOnline()) {
            val response = download(remotePath, 4 * 1024 * 1024)
            val body = response.body
            if (response.status == 200 && body != null && accept(body)) {
                store(target, body)
                refreshed[relativePath] = System.currentTimeMillis()
                return@synchronized body
            }
            if (target.isFile) {
                // Server trouble: do not make every request wait for the timeout again,
                // serve the stored copy and retry in half a minute.
                refreshed[relativePath] = System.currentTimeMillis() - maxAgeMs + 30_000
            }
        }
        if (target.isFile) target.readBytes() else null
    }

    /**
     * For content that never changes once published (a release asset): the stored copy
     * wins, the network is only used the first time. Status 200 with the bytes, the
     * server's error status, or [UNREACHABLE].
     */
    fun immutable(
        relativePath: String,
        remotePath: String,
        maxBytes: Int,
        accept: (ByteArray) -> Boolean
    ): Response = synchronized(lockFor(relativePath)) {
        val target = file(relativePath)
        if (target.isFile && target.length() > 0) {
            return@synchronized Response(200, target.readBytes())
        }
        if (!isOnline()) {
            return@synchronized Response(UNREACHABLE, null)
        }
        val response = download(remotePath, maxBytes)
        val body = response.body
        if (response.status != 200 || body == null) {
            return@synchronized response
        }
        if (!accept(body)) {
            Log.w(TAG, "rejected $remotePath: content failed validation")
            return@synchronized Response(502, null)
        }
        store(target, body)
        response
    }

    /** One GET to the server. Never throws. */
    fun download(remotePath: String, maxBytes: Int): Response {
        var connection: HttpURLConnection? = null
        try {
            connection = URL(REMOTE + remotePath).openConnection() as HttpURLConnection
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("User-Agent", userAgent)

            val status = connection.responseCode
            serverReachable = true
            if (status != 200) {
                Log.d(TAG, "$remotePath -> HTTP $status")
                return Response(status, null)
            }
            val buffer = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val chunk = ByteArray(16 * 1024)
                while (true) {
                    val read = input.read(chunk)
                    if (read < 0) break
                    buffer.write(chunk, 0, read)
                    if (buffer.size() > maxBytes) {
                        throw IOException("larger than $maxBytes bytes")
                    }
                }
            }
            return Response(200, buffer.toByteArray())
        } catch (e: Exception) {
            Log.w(TAG, "$remotePath failed: $e")
            serverReachable = false
            return Response(UNREACHABLE, null)
        } finally {
            connection?.disconnect()
        }
    }

    /** "/api/file/a b/c" -> "/api/file/a%20b/c" */
    fun encodePath(path: String): String =
        path.split('/').joinToString("/") { Uri.encode(it) }

    // Written through a temp file: a file that exists in the cache is always complete.
    private fun store(target: File, body: ByteArray) {
        try {
            target.parentFile?.mkdirs()
            val temp = File(target.parentFile, target.name + ".part")
            temp.writeBytes(body)
            if (!temp.renameTo(target)) {
                target.delete()
                if (!temp.renameTo(target)) {
                    temp.delete()
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "cannot store ${target.name}: $e")
        }
    }

    private fun lockFor(key: String): Any = locks.getOrPut(key) { Any() }
}
