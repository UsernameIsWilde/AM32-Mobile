package app.am32.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

/**
 * One full screen WebView showing the bundled AM32 configurator.
 *
 * The page is the unmodified web app; what makes it work on a phone without internet is
 * wired up here: [LocalContent] answers every request, [UsbSerialBridge] provides
 * `navigator.serial`, [FileBridge] handles downloads.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "AM32"
        private const val REQUEST_PICK_FILE = 1
        private const val START_URL = "${LocalContent.ORIGIN}/"
    }

    private lateinit var webView: WebView
    private lateinit var content: LocalContent
    private lateinit var usb: UsbSerialBridge
    private lateinit var files: FileBridge

    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // A dimmed-then-locked screen suspends the page's timers, which is the last thing
        // you want halfway through flashing an ESC.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        content = LocalContent(this)
        webView = WebView(this)
        webView.setBackgroundColor(getColor(R.color.app_background))
        setContentView(
            webView,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage + IndexedDB (settings, cached firmware)
            // nothing outside the bundled site is reachable from the page
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            // the configurator is laid out for wide screens: let the user pinch-zoom
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            textZoom = 100
        }

        usb = UsbSerialBridge(this, webView)
        files = FileBridge(this, content)
        webView.addJavascriptInterface(usb, UsbSerialBridge.JS_NAME)
        webView.addJavascriptInterface(files, FileBridge.JS_NAME)

        webView.webViewClient = Client()
        webView.webChromeClient = Chrome()
        webView.setDownloadListener { url, _, _, _, _ ->
            // bridge.js normally catches downloads first; this covers what it does not see
            files.saveUrl(url, Uri.parse(url).lastPathSegment ?: "")
        }

        usb.start()

        if (!content.hasWebApp()) {
            Toast.makeText(this, R.string.load_failed, Toast.LENGTH_LONG).show()
        }
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    // webView.onPause() is deliberately not called: the page must keep running when the
    // app is briefly in the background, otherwise an ongoing flash would stall.

    override fun onDestroy() {
        usb.destroy()
        files.shutdown()
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            // keep the page (and an open USB connection) alive instead of finishing
            moveTaskToBack(true)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PICK_FILE) {
            return
        }
        val callback = fileCallback ?: return
        fileCallback = null

        var result: Array<Uri>? = null
        if (resultCode == RESULT_OK && data != null) {
            val clip = data.clipData
            result = when {
                clip != null && clip.itemCount > 0 -> Array(clip.itemCount) { clip.getItemAt(it).uri }
                data.data != null -> arrayOf(data.data!!)
                else -> null
            }
        }
        // must always be called, with null on cancel, or the next file input stays dead
        callback.onReceiveValue(result)
    }

    private fun openExternally(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, getString(R.string.no_browser, uri.toString()), Toast.LENGTH_LONG).show()
        }
    }

    private inner class Client : WebViewClient() {

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            content.intercept(request)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            if (LocalContent.isAppUrl(uri)) {
                return false
            }
            // Discord, Patreon, GitHub...: not ours to show, and they need a network anyway
            if (uri.scheme == "http" || uri.scheme == "https" || uri.scheme == "mailto") {
                openExternally(uri)
            }
            return true
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The renderer was killed (usually low memory). The WebView is unusable after
            // that, so start over with a fresh activity instead of crashing the app.
            Log.e(TAG, "WebView renderer gone, didCrash=${detail.didCrash()}")
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback

            // .hex, .amj and .bin have no registered MIME type: filtering by the input's
            // accept attribute would grey the files out, so every file is selectable.
            val intent = Intent(Intent.ACTION_GET_CONTENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            return try {
                @Suppress("DEPRECATION")
                startActivityForResult(
                    Intent.createChooser(intent, getString(R.string.file_chooser_title)),
                    REQUEST_PICK_FILE
                )
                true
            } catch (e: ActivityNotFoundException) {
                fileCallback = null
                Toast.makeText(this@MainActivity, R.string.file_chooser_missing, Toast.LENGTH_LONG).show()
                false
            }
        }

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            Log.d(TAG, "js ${message.messageLevel()}: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
            return true
        }
    }
}
