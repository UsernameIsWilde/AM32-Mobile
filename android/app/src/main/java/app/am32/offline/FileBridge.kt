package app.am32.offline

import android.app.Activity
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executors

/**
 * Saves files the page wants to "download" (an ESC config, a firmware .hex from the
 * Downloads page). A WebView has no download manager of its own and cannot hand a blob:
 * URL to Android's, so bridge.js routes every download through here.
 *
 * Files go to Download/AM32 on Android 10+, where no storage permission is needed. Older
 * versions get the app's own external Download folder for the same reason.
 */
class FileBridge(private val activity: Activity, private val content: LocalContent) {

    companion object {
        const val JS_NAME = "AM32Files"
        private const val TAG = "AM32Files"
        private const val FOLDER = "AM32"
    }

    private val executor = Executors.newSingleThreadExecutor()

    @JavascriptInterface
    fun saveBase64(name: String, base64: String) {
        executor.execute {
            val bytes = try {
                Base64.decode(base64, Base64.DEFAULT)
            } catch (e: Exception) {
                report(name, e)
                return@execute
            }
            save(name, ByteArrayInputStream(bytes))
        }
    }

    /** Saves a file served by [LocalContent], e.g. /api/file/releases/v2.22/AM32_X.hex. */
    @JavascriptInterface
    fun saveUrl(url: String, name: String) {
        executor.execute {
            val uri = Uri.parse(url)
            val stream = if (LocalContent.isAppUrl(uri)) content.open(uri) else null
            if (stream == null) {
                report(name, IllegalArgumentException("not found"))
            } else {
                save(name.ifBlank { uri.lastPathSegment ?: "download" }, stream)
            }
        }
    }

    fun shutdown() {
        executor.shutdown()
    }

    private fun save(requestedName: String, input: InputStream) {
        val name = requestedName.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").ifBlank { "download" }
        try {
            val location = input.use {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveToMediaStore(name, it) else saveToAppFolder(name, it)
            }
            activity.runOnUiThread {
                Toast.makeText(activity, activity.getString(R.string.file_saved, location), Toast.LENGTH_LONG).show()
            }
        } catch (e: Exception) {
            report(name, e)
        }
    }

    private fun saveToMediaStore(name: String, input: InputStream): String {
        val resolver = activity.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            // A generic type on purpose: with text/plain MediaStore would rename x.hex to x.hex.txt
            put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("MediaStore refused the file")
        try {
            (resolver.openOutputStream(uri) ?: throw IllegalStateException("cannot open the file")).use { input.copyTo(it) }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
        return "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER/$name"
    }

    private fun saveToAppFolder(name: String, input: InputStream): String {
        val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IllegalStateException("no external storage")
        dir.mkdirs()
        val file = File(dir, name)
        file.outputStream().use { input.copyTo(it) }
        return file.absolutePath
    }

    private fun report(name: String, e: Exception) {
        Log.w(TAG, "saving $name failed", e)
        activity.runOnUiThread {
            Toast.makeText(
                activity,
                activity.getString(R.string.file_save_failed, e.message ?: name),
                Toast.LENGTH_LONG
            ).show()
        }
    }
}
