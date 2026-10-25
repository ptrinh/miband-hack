package uk.trinh.miband.remote

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/** Setup screen: start/stop the remote, pick the laptop for slides, open the camera, try each button. */
class MainActivity : ComponentActivity() {
    private lateinit var bandText: TextView
    private lateinit var laptopText: TextView
    private lateinit var cameraText: TextView
    private lateinit var startButton: Button
    private lateinit var logText: TextView

    private val refresh: () -> Unit = { render() }

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (bluetoothGranted()) startForegroundService(RemoteService.intent(this))
        else Hub.log("Bluetooth permission is needed for the band link and the laptop keyboard")
    }

    private val askDiscoverable = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun text(size: Float = 16f) = TextView(this).apply { textSize = size }.also { column.addView(it) }
        fun button(label: String, onClick: () -> Unit) =
            Button(this).apply { text = label; setOnClickListener { onClick() } }.also { column.addView(it) }

        text(22f).text = "MiBand Remote"
        text(14f).text = "Install \"Phone Remote\" on the band, keep Mi Fitness connected, then press Start."
        bandText = text()
        laptopText = text()
        cameraText = text()
        startButton = button("Start") { toggle() }
        button("Open camera (band Shutter takes the photo)") {
            startActivity(Intent(this, CameraActivity::class.java))
        }
        button("Slides: connect to a computer…") { pickLaptop() }
        button("Slides: let a computer pair with this phone") {
            askDiscoverable.launch(Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE))
        }
        button("Slides: disconnect computer") {
            if (Hub.running) startService(RemoteService.intent(this, RemoteService.ACTION_DISCONNECT_LAPTOP))
        }
        text(14f).text = "Try without the band:"
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        column.addView(row)
        for (c in listOf(Protocol.Command.SHUTTER, Protocol.Command.PREV, Protocol.Command.NEXT, Protocol.Command.PLAY_PAUSE)) {
            row.addView(Button(this).apply {
                text = c.wire
                isAllCaps = false
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener {
                    if (Hub.running) startService(RemoteService.intent(this@MainActivity, RemoteService.ACTION_TEST).putExtra(RemoteService.EXTRA_COMMAND, c.wire))
                    else Hub.log("Press Start first")
                }
            })
        }
        logText = text(12f)
        setContentView(ScrollView(this).apply { addView(column) })
    }

    override fun onStart() {
        super.onStart()
        Hub.listen(refresh)
        render()
    }

    override fun onStop() {
        Hub.unlisten(refresh)
        super.onStop()
    }

    private fun render() {
        bandText.text = "Band: ${Hub.band}"
        laptopText.text = "Slides: " + (Hub.laptop?.let { "arrow keys on $it" } ?: "no computer, Prev/Next skip tracks")
        cameraText.text = "Camera screen: " + if (Hub.camera) "open" else "closed"
        startButton.text = if (Hub.running) "Stop" else "Start"
        logText.text = Hub.lines.joinToString("\n")
    }

    private fun toggle() {
        if (Hub.running) {
            startService(RemoteService.intent(this, RemoteService.ACTION_STOP))
            return
        }
        val wanted = buildList {
            if (Build.VERSION.SDK_INT >= 31) add(Manifest.permission.BLUETOOTH_CONNECT)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isEmpty()) startForegroundService(RemoteService.intent(this))
        else askPermissions.launch(wanted.toTypedArray())
    }

    @SuppressLint("MissingPermission")
    private fun pickLaptop() {
        if (!Hub.running) {
            Hub.log("Press Start first")
            return
        }
        if (!bluetoothGranted()) return
        val bonded = getSystemService(BluetoothManager::class.java)?.adapter?.bondedDevices.orEmpty().toList()
        if (bonded.isEmpty()) {
            Hub.log("No paired devices: pair the computer with this phone first")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Computer showing the slides")
            .setItems(bonded.map { it.name ?: it.address }.toTypedArray()) { _, i ->
                startService(
                    RemoteService.intent(this, RemoteService.ACTION_CONNECT_LAPTOP)
                        .putExtra(RemoteService.EXTRA_ADDRESS, bonded[i].address)
                )
            }
            .show()
    }

    private fun bluetoothGranted() = Build.VERSION.SDK_INT < 31 ||
        checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
}
