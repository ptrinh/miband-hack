package uk.trinh.miband.remote

import android.content.Context
import android.content.pm.PackageManager
import com.xiaomi.xms.wearable.Wearable
import com.xiaomi.xms.wearable.auth.Permission
import com.xiaomi.xms.wearable.message.OnMessageReceivedListener
import com.xiaomi.xms.wearable.node.DataItem
import com.xiaomi.xms.wearable.node.DataSubscribeResult
import com.xiaomi.xms.wearable.node.OnDataChangedListener
import com.xiaomi.xms.wearable.service.OnServiceConnectionListener

/**
 * Link to the band app through Xiaomi's phone SDK (xms-wearable-lib 1.4, ./fetch-sdk.sh). The SDK does not talk
 * Bluetooth itself: it binds to Mi Fitness (com.xiaomi.wearable, or com.mi.health in China), which owns the
 * band connection and relays interconnect messages. Mi Fitness only relays for an app whose package name and
 * signing certificate match the quick app's, and only after the user grants DEVICE_MANAGER.
 *
 * Flow: connected nodes → check/request DEVICE_MANAGER → message listener + connection subscription.
 */
class BandLink(
    context: Context,
    private val onState: (String) -> Unit,
    private val onMessage: (ByteArray) -> Unit
) {
    private val app = context.applicationContext
    private val serviceApi = Wearable.getServiceApi(app)
    private val nodeApi = Wearable.getNodeApi(app)
    private val authApi = Wearable.getAuthApi(app)
    private val messageApi = Wearable.getMessageApi(app)

    private var nodeId: String? = null
    var ready = false
        private set

    private val serviceListener = object : OnServiceConnectionListener {
        override fun onServiceConnected() = attach()
        override fun onServiceDisconnected() {
            ready = false
            nodeId = null
            onState("Mi Fitness disconnected")
        }
    }

    private val messageListener = OnMessageReceivedListener { _, message -> onMessage(message) }

    private val connectionListener = OnDataChangedListener { _, item, result ->
        if (item.type != DataItem.ITEM_CONNECTION.type) return@OnDataChangedListener
        if (result.connectedStatus == DataSubscribeResult.RESULT_CONNECTION_CONNECTED) {
            attach()
        } else {
            ready = false
            onState("Band disconnected from Mi Fitness")
        }
    }

    fun start() {
        if (MI_FITNESS.none { installed(it) }) {
            onState("Mi Fitness is not installed")
            return
        }
        serviceApi.registerServiceConnectionListener(serviceListener)
        attach()
    }

    fun stop() {
        serviceApi.unregisterServiceConnectionListener(serviceListener)
        nodeId?.let {
            messageApi.removeListener(it)
            nodeApi.unsubscribe(it, DataItem.ITEM_CONNECTION)
        }
        nodeId = null
        ready = false
    }

    fun send(bytes: ByteArray) {
        val id = nodeId ?: return
        messageApi.sendMessage(id, bytes)
            .addOnFailureListener { Hub.log("Send to band failed: ${it.message}") }
    }

    private fun attach() {
        onState("Looking for the band…")
        nodeApi.connectedNodes
            .addOnSuccessListener { nodes ->
                val node = nodes.firstOrNull()
                if (node == null) {
                    onState("No band connected in Mi Fitness")
                    return@addOnSuccessListener
                }
                nodeId = node.id
                authApi.checkPermission(node.id, Permission.DEVICE_MANAGER)
                    .addOnSuccessListener { granted -> if (granted) listen(node.id, node.name) else ask(node.id, node.name) }
                    .addOnFailureListener { onState("Permission check failed: ${it.message}") }
            }
            .addOnFailureListener { onState("Mi Fitness refused: ${it.message}") }
    }

    private fun ask(id: String, name: String?) {
        onState("Asking Mi Fitness for permission…")
        authApi.requestPermission(id, Permission.DEVICE_MANAGER)
            .addOnSuccessListener { granted ->
                if (granted.any { it.name == Permission.DEVICE_MANAGER.name }) listen(id, name)
                else onState("Permission denied in Mi Fitness")
            }
            .addOnFailureListener { onState("Permission request failed: ${it.message}") }
    }

    private fun listen(id: String, name: String?) {
        messageApi.addListener(id, messageListener)
            .addOnSuccessListener {
                ready = true
                onState("Listening to ${name ?: "band"}")
            }
            .addOnFailureListener { onState("Message listener failed: ${it.message}") }
        nodeApi.subscribe(id, DataItem.ITEM_CONNECTION, connectionListener)
        nodeApi.isWearAppInstalled(id).addOnSuccessListener { installed ->
            if (!installed) Hub.log("Phone Remote is not installed on the band (or Mi Fitness cannot see it)")
        }
    }

    private fun installed(pkg: String) = try {
        app.packageManager.getPackageInfo(pkg, 0)
        true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    companion object {
        /** The packages the SDK binds to (its manifest declares <queries> for both). */
        val MI_FITNESS = listOf("com.xiaomi.wearable", "com.mi.health")
    }
}
