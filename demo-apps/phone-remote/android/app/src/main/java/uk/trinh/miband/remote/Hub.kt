package uk.trinh.miband.remote

import android.os.Handler
import android.os.Looper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Process-wide state shared by the service and the two screens. Every change is applied on the main thread
 * and then every listener is called there, so the UI can read the fields directly.
 */
object Hub {
    private val main = Handler(Looper.getMainLooper())
    private val listeners = mutableListOf<() -> Unit>()
    private val stamp = SimpleDateFormat("HH:mm:ss", Locale.US)

    var running = false
        private set
    /** Mi Fitness / band link, as text for the main screen. */
    var band = "Not started"
        private set
    /** Computer the phone is connected to as a Bluetooth keyboard, or null. */
    var laptop: String? = null
        private set
    var camera = false
        private set
    val lines = ArrayDeque<String>()

    fun status() = Protocol.Status(laptop, camera)

    fun setRunning(value: Boolean) = update { running = value }
    fun setBand(value: String) = update { band = value }
    fun setLaptop(value: String?) = update { laptop = value }
    fun setCamera(value: Boolean) = update { camera = value }

    fun log(line: String) = update {
        lines.addFirst("${stamp.format(Date())}  $line")
        while (lines.size > 40) lines.removeLast()
    }

    fun listen(l: () -> Unit) {
        listeners += l
    }

    fun unlisten(l: () -> Unit) {
        listeners -= l
    }

    private fun update(change: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            change()
            listeners.toList().forEach { it() }
        } else {
            main.post { update(change) }
        }
    }
}

/** The camera screen registers itself here while it is in front; the service fires it when the band asks. */
object Shutter {
    @Volatile
    var handler: (() -> Unit)? = null

    fun fire(): Boolean {
        val h = handler ?: return false
        h()
        return true
    }
}
