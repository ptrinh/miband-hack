package uk.trinh.miband.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat

/**
 * Foreground service that keeps the band link and the Bluetooth keyboard alive while the phone shows other
 * apps (the slides app, the music app). Band messages are handled on the main thread.
 */
class RemoteService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var hid: HidKeyboard
    private lateinit var actions: Actions
    private lateinit var band: BandLink
    private var lastStatus: Protocol.Status? = null

    private val statusWatcher: () -> Unit = { pushStatus() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        try {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, notification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            )
        } catch (e: Exception) {
            // Android 14+ refuses a connectedDevice service without the Bluetooth permission.
            Hub.log("Cannot start: ${e.message}")
            stopSelf()
            return
        }
        hid = HidKeyboard(this) { Hub.setLaptop(hid.hostName) }
        actions = Actions(this, hid)
        band = BandLink(this, onState = { Hub.setBand(it) }, onMessage = { bytes -> main.post { handle(bytes) } })
        if (!hid.start()) Hub.log("This phone cannot act as a Bluetooth keyboard: Prev/Next will skip tracks")
        band.start()
        Hub.listen(statusWatcher)
        Hub.setRunning(true)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!::band.isInitialized) return START_NOT_STICKY
        when (intent?.action) {
            ACTION_STOP -> stopSelf()
            ACTION_CONNECT_LAPTOP -> intent.getStringExtra(EXTRA_ADDRESS)?.let {
                if (!hid.connect(it)) Hub.log("Could not connect to that computer")
            }
            ACTION_DISCONNECT_LAPTOP -> hid.disconnect()
            ACTION_TEST -> Protocol.Command.of(intent.getStringExtra(EXTRA_COMMAND).orEmpty())?.let {
                Hub.log("Test ${it.wire}: ${describe(actions.run(it))}")
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (::band.isInitialized) {
            Hub.unlisten(statusWatcher)
            band.stop()
            hid.stop()
            Hub.setLaptop(null)
            Hub.setBand("Stopped")
        }
        Hub.setRunning(false)
        super.onDestroy()
    }

    private fun handle(bytes: ByteArray) {
        val request = Protocol.parse(bytes)
        if (request == null) {
            Hub.log("Ignored a message that is not ours (${bytes.size} bytes)")
            return
        }
        val command = request.command
        val outcome = if (command == null) Outcome.Err(Protocol.Failure.UNKNOWN_COMMAND) else actions.run(command)
        if (command != Protocol.Command.HELLO) Hub.log("Band ${request.wire}: ${describe(outcome)}")
        val status = Hub.status()
        lastStatus = status
        band.send(
            when (outcome) {
                is Outcome.Ok -> Protocol.ok(request.id, outcome.done, status)
                is Outcome.Err -> Protocol.error(request.id, outcome.failure, status)
            }
        )
    }

    /** Tell the band when what Prev/Next or Shutter will do has changed. */
    private fun pushStatus() {
        if (!band.ready) return
        val status = Hub.status()
        if (status == lastStatus) return
        lastStatus = status
        band.send(Protocol.status(status))
    }

    private fun describe(outcome: Outcome) = when (outcome) {
        is Outcome.Ok -> outcome.done.wire
        is Outcome.Err -> "failed (${outcome.failure.wire})"
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Band remote", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("MiBand Remote is listening")
            .setContentText("Band buttons control camera, slides and media")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL = "remote"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "uk.trinh.miband.remote.STOP"
        const val ACTION_CONNECT_LAPTOP = "uk.trinh.miband.remote.CONNECT_LAPTOP"
        const val ACTION_DISCONNECT_LAPTOP = "uk.trinh.miband.remote.DISCONNECT_LAPTOP"
        const val ACTION_TEST = "uk.trinh.miband.remote.TEST"
        const val EXTRA_ADDRESS = "address"
        const val EXTRA_COMMAND = "command"

        fun intent(context: Context, action: String? = null) =
            Intent(context, RemoteService::class.java).setAction(action)
    }
}
