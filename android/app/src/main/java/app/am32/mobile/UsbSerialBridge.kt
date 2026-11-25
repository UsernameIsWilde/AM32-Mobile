package app.am32.mobile

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import com.hoho.android.usbserial.driver.Ch34xSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * Native half of the `navigator.serial` polyfill (assets/bridge/bridge.js).
 *
 * Android's WebView has no Web Serial API, so the page talks to this object instead and
 * the USB work is done by usb-serial-for-android: CDC-ACM (STM32 / AT32 flight
 * controllers), CH34x, FTDI, CP210x and Prolific adapters.
 *
 * Methods marked @JavascriptInterface run on the WebView's bridge thread. They report
 * failures as a non-empty string, because exceptions do not cross the bridge usefully.
 */
class UsbSerialBridge(private val activity: Activity, private val webView: WebView) {

    companion object {
        const val JS_NAME = "AM32Usb"
        private const val TAG = "AM32Usb"
        private const val WRITE_TIMEOUT_MS = 2000
    }

    private class Connection(val port: UsbSerialPort, val io: SerialInputOutputManager)

    private class PendingRequest(val id: Int, val device: UsbDevice)

    private val usbManager = activity.getSystemService(Context.USB_SERVICE) as UsbManager

    private val prober = UsbSerialProber(
        UsbSerialProber.getDefaultProbeTable().apply {
            // old WCH vendor id used by some CH340/CH341 boards, on the configurator's adapter list
            addProduct(0x4348, 0x5523, Ch34xSerialDriver::class.java)
        }
    )

    private val lock = Any()
    private val connections = HashMap<String, Connection>() // guarded by lock, keyed by UsbDevice.deviceName

    private val permissionAction = "${activity.packageName}.USB_PERMISSION"
    private var pending: PendingRequest? = null // main thread only
    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                permissionAction -> onPermissionResult()
                UsbManager.ACTION_USB_DEVICE_DETACHED -> dropLostConnections()
            }
        }
    }

    fun start() {
        val filter = IntentFilter(permissionAction).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            activity.registerReceiver(receiver, filter)
        }
        registered = true
    }

    fun destroy() {
        if (registered) {
            activity.unregisterReceiver(receiver)
            registered = false
        }
        val keys = synchronized(lock) { connections.keys.toList() }
        keys.forEach { closeConnection(it) }
    }

    // --- called from JavaScript ----------------------------------------------------------

    /** Serial capable devices the user has already granted access to, as a JSON array. */
    @JavascriptInterface
    fun listPorts(): String {
        val ports = JSONArray()
        try {
            for (device in usbManager.deviceList.values) {
                if (prober.probeDevice(device) != null && usbManager.hasPermission(device)) {
                    ports.put(describe(device))
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "listPorts failed", e)
        }
        return ports.toString()
    }

    /**
     * Android's version of the browser's port chooser. Answers through
     * `__am32serial.onPortGranted(id, port)` / `onPortDenied(id, message)`.
     */
    @JavascriptInterface
    fun requestPort(requestId: Int, vendorIdsJson: String) {
        val vendorIds = try {
            val array = JSONArray(vendorIdsJson)
            (0 until array.length()).map { array.getInt(it) }.toSet()
        } catch (e: Exception) {
            emptySet()
        }

        activity.runOnUiThread {
            val serialDevices = try {
                usbManager.deviceList.values.filter { prober.probeDevice(it) != null }
            } catch (e: Exception) {
                emptyList()
            }
            // Prefer what the page asked for, but a phone rarely has more than one USB
            // device attached: offering an unlisted serial adapter beats showing nothing.
            val candidates = serialDevices
                .filter { vendorIds.isEmpty() || it.vendorId in vendorIds }
                .ifEmpty { serialDevices }

            when (candidates.size) {
                0 -> {
                    toast(activity.getString(R.string.usb_none_found))
                    deny(requestId)
                }
                1 -> grant(requestId, candidates[0])
                else -> AlertDialog.Builder(activity)
                    .setTitle(R.string.usb_choose_device)
                    .setItems(candidates.map { label(it) }.toTypedArray()) { _, which ->
                        grant(requestId, candidates[which])
                    }
                    .setNegativeButton(R.string.cancel) { _, _ -> deny(requestId) }
                    .setOnCancelListener { deny(requestId) }
                    .show()
            }
        }
    }

    /** Returns "" on success, otherwise the reason the port could not be opened. */
    @JavascriptInterface
    fun open(key: String, baudRate: Int, dataBits: Int, stopBits: Int, parity: String): String {
        synchronized(lock) {
            if (connections.containsKey(key)) {
                return "The port is already open."
            }
            val device = usbManager.deviceList[key] ?: return "The USB device is no longer connected."
            val driver = prober.probeDevice(device) ?: return "No serial driver for this USB device."
            if (!usbManager.hasPermission(device)) {
                return "No permission to access the USB device."
            }
            val usbConnection = usbManager.openDevice(device)
                ?: return "Android refused to open the USB device."

            val port = driver.ports[0]
            try {
                port.open(usbConnection)
                port.setParameters(
                    baudRate,
                    if (dataBits == 7) UsbSerialPort.DATABITS_7 else UsbSerialPort.DATABITS_8,
                    if (stopBits == 2) UsbSerialPort.STOPBITS_2 else UsbSerialPort.STOPBITS_1,
                    when (parity) {
                        "even" -> UsbSerialPort.PARITY_EVEN
                        "odd" -> UsbSerialPort.PARITY_ODD
                        else -> UsbSerialPort.PARITY_NONE
                    }
                )
                // Chrome asserts both lines when it opens a port, and a CDC flight
                // controller stays silent until DTR is up.
                try {
                    port.dtr = true
                    port.rts = true
                } catch (e: Exception) {
                    Log.d(TAG, "control lines not supported: ${e.message}")
                }

                val io = SerialInputOutputManager(port, Listener(key))
                connections[key] = Connection(port, io)
                io.start()
                Log.i(TAG, "opened ${label(device)} at $baudRate baud (${driver.javaClass.simpleName})")
                return ""
            } catch (e: Exception) {
                Log.w(TAG, "open failed", e)
                connections.remove(key)
                try {
                    port.close()
                } catch (ignored: Exception) {
                }
                usbConnection.close()
                return e.message ?: e.toString()
            }
        }
    }

    /** Returns "" on success. Blocks until the bytes are handed to the USB stack. */
    @JavascriptInterface
    fun write(key: String, base64: String): String {
        val connection = synchronized(lock) { connections[key] } ?: return "The port is closed."
        return try {
            connection.port.write(Base64.decode(base64, Base64.DEFAULT), WRITE_TIMEOUT_MS)
            ""
        } catch (e: Exception) {
            Log.w(TAG, "write failed", e)
            e.message ?: e.toString()
        }
    }

    @JavascriptInterface
    fun close(key: String): String {
        closeConnection(key)
        return ""
    }

    /** Each argument: 1 = assert, 0 = clear, -1 = leave alone. */
    @JavascriptInterface
    fun setSignals(key: String, dtr: Int, rts: Int, brk: Int): String {
        val connection = synchronized(lock) { connections[key] } ?: return "The port is closed."
        return try {
            if (dtr >= 0) connection.port.dtr = dtr == 1
            if (rts >= 0) connection.port.rts = rts == 1
            if (brk >= 0) connection.port.setBreak(brk == 1)
            ""
        } catch (e: Exception) {
            e.message ?: e.toString()
        }
    }

    @JavascriptInterface
    fun getSignals(key: String): String {
        val signals = JSONObject()
        val port = synchronized(lock) { connections[key] }?.port
        fun read(name: String, getter: (UsbSerialPort) -> Boolean) {
            signals.put(name, try { port != null && getter(port) } catch (e: Exception) { false })
        }
        read("dataCarrierDetect") { it.cd }
        read("clearToSend") { it.cts }
        read("ringIndicator") { it.ri }
        read("dataSetReady") { it.dsr }
        return signals.toString()
    }

    // --- permission flow (main thread) ---------------------------------------------------

    private fun grant(requestId: Int, device: UsbDevice) {
        if (usbManager.hasPermission(device)) {
            js("window.__am32serial&&window.__am32serial.onPortGranted($requestId,${describe(device)})")
            return
        }
        pending?.let { deny(it.id) }
        pending = PendingRequest(requestId, device)

        val intent = Intent(permissionAction).setPackage(activity.packageName)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        try {
            usbManager.requestPermission(device, PendingIntent.getBroadcast(activity, 0, intent, flags))
        } catch (e: Exception) {
            Log.w(TAG, "requestPermission failed", e)
            pending = null
            deny(requestId)
        }
    }

    private fun onPermissionResult() {
        val request = pending ?: return
        pending = null
        // Ask the system instead of trusting the broadcast extras.
        if (usbManager.hasPermission(request.device)) {
            grant(request.id, request.device)
        } else {
            toast(activity.getString(R.string.usb_permission_denied))
            deny(request.id)
        }
    }

    private fun deny(requestId: Int) {
        js("window.__am32serial&&window.__am32serial.onPortDenied($requestId)")
    }

    // --- connection handling -------------------------------------------------------------

    private inner class Listener(private val key: String) : SerialInputOutputManager.Listener {
        override fun onNewData(data: ByteArray) {
            if (data.isEmpty()) {
                return
            }
            val payload = Base64.encodeToString(data, Base64.NO_WRAP)
            js("window.__am32serial&&window.__am32serial.onData(${JSONObject.quote(key)},'$payload')")
        }

        override fun onRunError(e: Exception) {
            // Also fires after a deliberate close on some drivers: only a connection that
            // is still registered was really lost.
            if (closeConnection(key)) {
                Log.w(TAG, "connection lost: ${e.message}")
                notifyLost(key)
            }
        }
    }

    /** Closes ports whose device has been unplugged. */
    private fun dropLostConnections() {
        val attached = try {
            usbManager.deviceList.keys
        } catch (e: Exception) {
            emptySet<String>()
        }
        val lost = synchronized(lock) { connections.keys.filter { it !in attached } }
        for (key in lost) {
            if (closeConnection(key)) {
                notifyLost(key)
            }
        }
    }

    private fun notifyLost(key: String) {
        activity.runOnUiThread { toast(activity.getString(R.string.usb_disconnected)) }
        js("window.__am32serial&&window.__am32serial.onLost(${JSONObject.quote(key)})")
    }

    /** True when there was an open connection to close. */
    private fun closeConnection(key: String): Boolean {
        val connection = synchronized(lock) { connections.remove(key) } ?: return false
        try {
            connection.io.stop()
        } catch (e: Exception) {
            Log.d(TAG, "io.stop: ${e.message}")
        }
        try {
            connection.port.close()
        } catch (e: Exception) {
            Log.d(TAG, "port.close: ${e.message}")
        }
        return true
    }

    // --- helpers -------------------------------------------------------------------------

    private fun describe(device: UsbDevice): JSONObject = JSONObject()
        .put("key", device.deviceName)
        .put("vid", device.vendorId)
        .put("pid", device.productId)
        .put("name", label(device))

    private fun label(device: UsbDevice): String {
        val id = "%04X:%04X".format(device.vendorId, device.productId)
        val name = try {
            listOfNotNull(device.manufacturerName, device.productName).joinToString(" ").trim()
        } catch (e: Exception) {
            ""
        }
        return if (name.isEmpty()) id else "$name ($id)"
    }

    private fun js(script: String) {
        webView.post { webView.evaluateJavascript(script, null) }
    }

    private fun toast(message: String) {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
    }
}
