package uk.trinh.miband.remote

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothHidDevice
import android.bluetooth.BluetoothHidDeviceAppSdpSettings
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import java.util.concurrent.Executors

/**
 * The phone as a Bluetooth keyboard (HID Device profile, Android 9+), so Prev / Next on the band become
 * Left / Right arrow keys on a laptop that is showing slides. Works with PowerPoint, Keynote, Google Slides
 * and PDF viewers, which all take the arrow keys.
 *
 * Some phone makers ship Android without the HID Device profile; then [start] reports "not supported".
 * Callers must hold BLUETOOTH_CONNECT on Android 12+ (MainActivity asks before starting the service).
 */
@SuppressLint("MissingPermission")
class HidKeyboard(private val context: Context, private val onChange: () -> Unit) {
    private val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    private val prefs = context.getSharedPreferences("hid", Context.MODE_PRIVATE)
    private var hid: BluetoothHidDevice? = null

    var registered = false
        private set
    var host: BluetoothDevice? = null
        private set
    val hostName: String? get() = host?.let { it.name ?: it.address }

    private val callback = object : BluetoothHidDevice.Callback() {
        override fun onAppStatusChanged(pluggedDevice: BluetoothDevice?, registered: Boolean) {
            this@HidKeyboard.registered = registered
            if (registered) reconnectLast(pluggedDevice)
            onChange()
        }

        override fun onConnectionStateChanged(device: BluetoothDevice, state: Int) {
            when (state) {
                BluetoothProfile.STATE_CONNECTED -> {
                    host = device
                    prefs.edit().putString("last", device.address).apply()
                }
                BluetoothProfile.STATE_DISCONNECTED -> if (device == host) host = null
            }
            onChange()
        }
    }

    private val proxyListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            val h = proxy as BluetoothHidDevice
            hid = h
            val sdp = BluetoothHidDeviceAppSdpSettings(
                "MiBand Remote", "Slide clicker", "MiBand Hack",
                BluetoothHidDevice.SUBCLASS1_KEYBOARD, KeyReport.DESCRIPTOR
            )
            h.registerApp(sdp, null, null, Executors.newSingleThreadExecutor(), callback)
        }

        override fun onServiceDisconnected(profile: Int) {
            hid = null
            registered = false
            host = null
            onChange()
        }
    }

    /** False when the phone has no Bluetooth or no HID Device profile. */
    fun start(): Boolean = adapter?.getProfileProxy(context, proxyListener, BluetoothProfile.HID_DEVICE) ?: false

    fun stop() {
        val h = hid ?: return
        host?.let { h.disconnect(it) }
        if (registered) h.unregisterApp()
        adapter?.closeProfileProxy(BluetoothProfile.HID_DEVICE, h)
        hid = null
        registered = false
        host = null
    }

    /** Connect to a computer that is already paired with the phone. */
    fun connect(address: String): Boolean {
        val h = hid ?: return false
        val device = adapter?.bondedDevices?.firstOrNull { it.address == address } ?: return false
        return h.connect(device)
    }

    fun disconnect() {
        val h = hid ?: return
        host?.let { h.disconnect(it) }
        prefs.edit().remove("last").apply()
    }

    /** Press and release one key. False when no computer is connected. */
    fun tap(key: Int): Boolean {
        val h = hid ?: return false
        val d = host ?: return false
        return h.sendReport(d, KeyReport.REPORT_ID, KeyReport.press(key)) &&
            h.sendReport(d, KeyReport.REPORT_ID, KeyReport.release())
    }

    private fun reconnectLast(plugged: BluetoothDevice?) {
        val h = hid ?: return
        if (plugged != null) {
            h.connect(plugged)
            return
        }
        val last = prefs.getString("last", null) ?: return
        adapter?.bondedDevices?.firstOrNull { it.address == last }?.let { h.connect(it) }
    }
}

/** Boot-keyboard style input report with report ID 1: modifiers, reserved, six key slots. */
object KeyReport {
    const val REPORT_ID = 1
    const val KEY_RIGHT = 0x4F
    const val KEY_LEFT = 0x50

    val DESCRIPTOR: ByteArray = intArrayOf(
        0x05, 0x01, // Usage Page (Generic Desktop)
        0x09, 0x06, // Usage (Keyboard)
        0xA1, 0x01, // Collection (Application)
        0x85, REPORT_ID, //   Report ID
        0x05, 0x07, //   Usage Page (Keyboard/Keypad)
        0x19, 0xE0, 0x29, 0xE7, //   Usage Minimum/Maximum (Left Control .. Right GUI)
        0x15, 0x00, 0x25, 0x01, //   Logical Minimum 0, Maximum 1
        0x75, 0x01, 0x95, 0x08, //   Report Size 1, Count 8
        0x81, 0x02, //   Input (Data, Variable, Absolute): modifier byte
        0x75, 0x08, 0x95, 0x01, //   Report Size 8, Count 1
        0x81, 0x01, //   Input (Constant): reserved byte
        0x75, 0x08, 0x95, 0x06, //   Report Size 8, Count 6
        0x15, 0x00, 0x25, 0x65, //   Logical Minimum 0, Maximum 101
        0x19, 0x00, 0x29, 0x65, //   Usage Minimum 0, Maximum 101
        0x81, 0x00, //   Input (Data, Array): key slots
        0xC0 // End Collection
    ).map { it.toByte() }.toByteArray()

    fun press(key: Int) = byteArrayOf(0, 0, key.toByte(), 0, 0, 0, 0, 0)

    fun release() = ByteArray(8)
}
