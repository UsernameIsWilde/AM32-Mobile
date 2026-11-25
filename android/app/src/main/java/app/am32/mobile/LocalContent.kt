package app.am32.mobile

import android.content.Context
import android.net.Uri
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * Stands in for the am32.ca web server.
 *
 * The WebView loads everything from [ORIGIN] and every request ends up here:
 *
 *  - the configurator itself (the generated Nuxt site) is served from `assets/www`, so the
 *    app starts and ESC settings can be edited with no network at all;
 *  - the `/api/...` routes the configurator calls for firmware are answered from am32.ca
 *    through [RemoteCache]: new releases show up as soon as the phone is online, and what
 *    has been downloaded once stays available offline;
 *  - requests to any other host are refused.
 */
class LocalContent(context: Context) {

    companion object {
        private const val TAG = "AM32Content"

        /** Reserved by Google for exactly this purpose, it never resolves to a real server. */
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"

        const val BRIDGE_PATH = "/__android/bridge.js"
        const val MOBILE_CSS_PATH = "/__android/mobile.css"
        private const val BRIDGE_TAG =
            "<script src=\"$BRIDGE_PATH\"></script><link rel=\"stylesheet\" href=\"$MOBILE_CSS_PATH\">"

        private const val WWW = "www"

        /** How long a firmware listing is trusted before the server is asked again. */
        private const val LISTING_MAX_AGE_MS = 5 * 60 * 1000L
        private const val SPONSORS_MAX_AGE_MS = 6 * 60 * 60 * 1000L
        private const val MAX_FILE_BYTES = 16 * 1024 * 1024

        /**
         * Sections of /api/files worth showing on a phone. The server also lists the
         * desktop ESC config tool and the unlocker executables, which cannot run here.
         */
        private val SECTIONS = setOf("releases", "kiss-ultra-releases", "bootloader")

        private val MIME_TYPES = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "mjs" to "text/javascript",
            "css" to "text/css",
            "json" to "application/json",
            "webmanifest" to "application/manifest+json",
            "map" to "application/json",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "gif" to "image/gif",
            "webp" to "image/webp",
            "avif" to "image/avif",
            "ico" to "image/x-icon",
            "woff" to "font/woff",
            "woff2" to "font/woff2",
            "ttf" to "font/ttf",
            "otf" to "font/otf",
            "wasm" to "application/wasm",
            "txt" to "text/plain",
            "hex" to "text/plain",
            "md" to "text/markdown",
            "xml" to "application/xml",
        )

        private val TEXT_TYPES = setOf(
            "text/html", "text/javascript", "text/css", "application/json", "text/plain",
            "image/svg+xml", "application/manifest+json", "text/markdown", "application/xml",
        )

        fun isAppUrl(uri: Uri): Boolean = uri.scheme == "https" && uri.host == HOST

        private fun mimeOf(name: String): String =
            MIME_TYPES[name.substringAfterLast('/').substringAfterLast('.', "").lowercase()]
                ?: "application/octet-stream"
    }

    private val assets = context.assets
    private val remote = RemoteCache(context)

    /** True when the generated site made it into the APK. */
    fun hasWebApp(): Boolean = try {
        assets.open("$WWW/index.html").close()
        true
    } catch (e: IOException) {
        false
    }

    /**
     * A request that cannot be answered is answered with an error; nothing is ever passed
     * on to the WebView's own network stack.
     */
    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        when (uri.scheme) {
            "http", "https" -> Unit
            else -> return null // blob:, data:, about: are handled by the WebView itself
        }
        if (uri.host != HOST) {
            Log.d(TAG, "blocked: $uri")
            return error(403, "Blocked")
        }
        return try {
            serve(uri)
        } catch (e: Exception) {
            Log.e(TAG, "failed to serve $uri", e)
            error(500, "Internal Error")
        }
    }

    /** Opens the content behind an app URL (used for saving files to Downloads). */
    fun open(uri: Uri): InputStream? {
        val response = try {
            serve(uri)
        } catch (e: Exception) {
            return null
        }
        return if (response.statusCode == 200) response.data else null
    }

    private fun serve(uri: Uri): WebResourceResponse {
        val path = cleanPath(uri.path ?: "/") ?: return error(400, "Bad Request")

        return when {
            path == BRIDGE_PATH -> asset("bridge/bridge.js") ?: error(404, "Not Found")
            path == MOBILE_CSS_PATH -> asset("bridge/mobile.css") ?: error(404, "Not Found")
            path == "/api/files" -> json(listFiles(uri))
            path.startsWith("/api/file/") -> remoteFile(path, "files/${path.removePrefix("/api/file/")}", download = true)
            path.startsWith("/api/eeprom/") -> eepromDefault(path.removePrefix("/api/eeprom/"), uri)
            path == "/api/sponsors" -> json(sponsors())
            path == "/eeprom" -> eepromSchema()
            path.startsWith("/uploads/") -> remoteFile(path, path.removePrefix("/"), download = false)
            path.startsWith("/api/") -> error(404, "Not Found")
            else -> staticFile(path)
        }
    }

    // --- static site ---------------------------------------------------------------------

    private fun staticFile(path: String): WebResourceResponse {
        val relative = path.trim('/')
        if (relative.isNotEmpty()) {
            asset("$WWW/$relative")?.let { return it }
            asset("$WWW/$relative/index.html")?.let { return it }
        }
        // Client side routes (/configurator, /downloads) have no file behind them: hand
        // out the SPA shell and let the router sort it out. A missing asset stays a 404.
        if (relative.substringAfterLast('/').contains('.')) {
            return error(404, "Not Found")
        }
        return asset("$WWW/200.html") ?: asset("$WWW/index.html") ?: error(404, "Not Found")
    }

    // --- /api/files ----------------------------------------------------------------------

    /**
     * Same contract as server/api/files.ts: `filter` picks the sections, and release
     * candidates (tag ending in -rc) are hidden unless `prereleases` is present.
     *
     * One complete listing is kept and every variant is derived from it, so they all work
     * offline. Without a connection the listing is narrowed down to the files that are
     * actually on the phone: offering firmware that cannot be fetched helps nobody.
     */
    private fun listFiles(uri: Uri): String {
        val wanted = uri.getQueryParameter("filter")?.split(',')?.map { it.trim() }?.toSet()
        val includePrereleases = uri.queryParameterNames.contains("prereleases")

        val raw = remote.refreshable("listing.json", "/api/files?prereleases", LISTING_MAX_AGE_MS) { body ->
            try {
                JSONObject(String(body, Charsets.UTF_8)).optJSONArray("data") != null
            } catch (e: Exception) {
                false
            }
        }
        val all = try {
            raw?.let { JSONObject(String(it, Charsets.UTF_8)).optJSONArray("data") } ?: JSONArray()
        } catch (e: Exception) {
            JSONArray()
        }
        val onlyStored = !remote.canReachServer()

        val result = JSONArray()
        for (i in 0 until all.length()) {
            val section = all.optJSONObject(i) ?: continue
            val name = section.optString("name")
            if (name !in SECTIONS || (wanted != null && name !in wanted)) {
                continue
            }
            val hidePrereleases = name == "releases" && !includePrereleases
            result.put(copyFolder(section, onlyStored, hidePrereleases))
        }
        return JSONObject().put("data", result).toString()
    }

    private fun copyFolder(folder: JSONObject, onlyStored: Boolean, hidePrereleases: Boolean): JSONObject {
        val files = JSONArray()
        val sourceFiles = folder.optJSONArray("files") ?: JSONArray()
        for (i in 0 until sourceFiles.length()) {
            val file = sourceFiles.optJSONObject(i) ?: continue
            if (!onlyStored || isStored(file.optString("url"))) {
                files.put(file)
            }
        }
        val children = JSONArray()
        val sourceChildren = folder.optJSONArray("children") ?: JSONArray()
        for (i in 0 until sourceChildren.length()) {
            val child = sourceChildren.optJSONObject(i) ?: continue
            if (hidePrereleases && child.optString("name").endsWith("-rc")) {
                continue
            }
            val copy = copyFolder(child, onlyStored, false)
            // offline, a release with nothing downloaded from it is not worth listing
            if (!onlyStored || copy.getJSONArray("files").length() > 0 || copy.getJSONArray("children").length() > 0) {
                children.put(copy)
            }
        }
        return JSONObject()
            .put("name", folder.optString("name"))
            .put("files", files)
            .put("children", children)
    }

    private fun isStored(url: String): Boolean {
        val prefix = "/api/file/"
        if (!url.startsWith(prefix)) {
            return false
        }
        val path = cleanPath(Uri.decode(url.removePrefix(prefix))) ?: return false
        return remote.has("files$path")
    }

    // --- files -----------------------------------------------------------------------------

    /**
     * A file that lives on the server: taken from the phone when it is already there,
     * downloaded (and kept) otherwise. Firmware images are checked before they are stored.
     */
    private fun remoteFile(path: String, cachePath: String, download: Boolean): WebResourceResponse {
        val isHex = path.endsWith(".hex", ignoreCase = true)
        val response = remote.immutable(cachePath, remote.encodePath(path), MAX_FILE_BYTES) { body ->
            !isHex || RemoteCache.isIntelHex(body)
        }
        val body = response.body
        if (response.status != 200 || body == null) {
            return when (response.status) {
                RemoteCache.UNREACHABLE -> error(504, "Offline")
                404 -> error(404, "Not Found")
                else -> error(502, "Bad Gateway")
            }
        }
        val name = path.substringAfterLast('/')
        val mime = mimeOf(name)
        val headers = mutableMapOf("Cache-Control" to "no-cache")
        if (download) {
            headers["Content-Disposition"] = "attachment; filename=\"$name\""
        }
        return WebResourceResponse(mime, if (mime in TEXT_TYPES) "utf-8" else null, 200, "OK", headers, ByteArrayInputStream(body))
    }

    // --- /api/eeprom/<name>?version=N ----------------------------------------------------

    /**
     * Answers with the URL of a default settings image, not with the image itself (see
     * server/api/eeprom/[name].ts). The server's answer is remembered; when there is none,
     * the reply is the server's own fallback: the images bundled with the web app. The
     * configurator validates whatever it ends up downloading before writing it to an ESC.
     */
    private fun eepromDefault(name: String, uri: Uri): WebResourceResponse {
        if (name.isEmpty() || name.contains('/')) {
            return error(404, "Not Found")
        }
        val version = uri.getQueryParameter("version")?.toIntOrNull() ?: 2
        val isUrl = { body: ByteArray ->
            val text = String(body, Charsets.UTF_8).trim()
            text.length < 300 && text.startsWith("/") && !text.contains('\n')
        }
        val answer = remote.refreshable(
            "eeprom/$name/v$version.txt",
            "/api/eeprom/${Uri.encode(name)}?version=$version",
            LISTING_MAX_AGE_MS,
            isUrl
        )
        val url = answer?.let { String(it, Charsets.UTF_8).trim() } ?: "/eeprom-defaults/$name/v$version.bin"
        return text(url, "text/html")
    }

    private fun eepromSchema(): WebResourceResponse {
        val schema = remote.refreshable("schemas/eeprom.json", "/eeprom", SPONSORS_MAX_AGE_MS) { body ->
            try {
                JSONObject(String(body, Charsets.UTF_8))
                true
            } catch (e: Exception) {
                false
            }
        } ?: return error(504, "Offline")
        return json(String(schema, Charsets.UTF_8))
    }

    private fun sponsors(): String {
        val body = remote.refreshable("sponsors.json", "/api/sponsors", SPONSORS_MAX_AGE_MS) { body ->
            try {
                JSONObject(String(body, Charsets.UTF_8)).optJSONArray("data") != null
            } catch (e: Exception) {
                false
            }
        }
        return body?.let { String(it, Charsets.UTF_8) } ?: """{"data":[]}"""
    }

    // --- helpers -------------------------------------------------------------------------

    /** Decoded, normalised path; null when it tries to climb out of its folder. */
    private fun cleanPath(raw: String): String? {
        val segments = raw.split('/').filter { it.isNotEmpty() && it != "." }
        if (segments.any { it == ".." || it.contains('\\') || it.contains('\u0000') }) {
            return null
        }
        return "/" + segments.joinToString("/")
    }

    private fun asset(assetPath: String): WebResourceResponse? {
        val stream = try {
            assets.open(assetPath)
        } catch (e: IOException) {
            return null // missing file, or a directory
        }
        val mime = mimeOf(assetPath)
        val body: InputStream = if (mime == "text/html") {
            ByteArrayInputStream(injectBridge(stream.use { it.readBytes() }.toString(Charsets.UTF_8)).toByteArray())
        } else {
            stream
        }
        // Hashed build output never changes; everything else must be re-read after an update.
        val immutable = assetPath.startsWith("$WWW/_nuxt/") && !assetPath.contains("/builds/")
        val headers = mapOf("Cache-Control" to if (immutable) "public, max-age=31536000, immutable" else "no-cache")
        return WebResourceResponse(mime, if (mime in TEXT_TYPES) "utf-8" else null, 200, "OK", headers, body)
    }

    /** The serial polyfill has to be in place before the first line of the app runs. */
    private fun injectBridge(html: String): String {
        val head = Regex("<head[^>]*>", RegexOption.IGNORE_CASE).find(html)
            ?: return BRIDGE_TAG + html
        return html.substring(0, head.range.last + 1) + BRIDGE_TAG + html.substring(head.range.last + 1)
    }

    private fun json(body: String) = text(body, "application/json")

    private fun text(body: String, mime: String) = WebResourceResponse(
        mime, "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(body.toByteArray())
    )

    private fun error(status: Int, reason: String) = WebResourceResponse(
        "text/plain", "utf-8", status, reason, mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(reason.toByteArray())
    )
}
