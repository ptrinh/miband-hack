package uk.trinh.miband.remote

import org.json.JSONObject

/**
 * Wire format shared with the band app (../band/src/common/remote.js; keep the two in sync).
 *
 * Band -> phone: `{"v":1,"id":7,"cmd":"next"}` (interconnect send({data}), arrives here as UTF-8 JSON bytes).
 * Phone -> band: a reply with the same id (`ok`, `did` or `error`), or a status push without id. Every message
 * carries the current `laptop` (name of the computer the phone types arrow keys into, or null) and `camera`
 * (camera screen open) so the band can show what Prev/Next and Shutter will do.
 */
object Protocol {
    const val VERSION = 1

    enum class Command(val wire: String) {
        SHUTTER("shutter"), PREV("prev"), NEXT("next"), PLAY_PAUSE("playpause"), HELLO("hello");

        companion object {
            fun of(wire: String): Command? = entries.firstOrNull { it.wire == wire }
        }
    }

    /** A parsed band message. [command] is null for a well-formed message with a command we do not know. */
    data class Request(val id: Int?, val command: Command?, val wire: String)

    /** What the phone did, sent back as `did`. */
    enum class Done(val wire: String) { PHOTO("photo"), SLIDE("slide"), TRACK("track"), MEDIA("media"), HELLO("hello") }

    /** Why it did not, sent back as `error`. */
    enum class Failure(val wire: String) {
        CAMERA_CLOSED("camera-closed"), NO_TARGET("no-target"), UNKNOWN_COMMAND("unknown-command"), FAILED("failed")
    }

    data class Status(val laptop: String?, val camera: Boolean)

    /** Returns null for anything that is not one of our messages. Tolerates a bare `"next"` too. */
    fun parse(bytes: ByteArray): Request? {
        val text = bytes.toString(Charsets.UTF_8).trim()
        if (text.isEmpty()) return null
        if (!text.startsWith("{")) {
            val wire = text.trim('"')
            return Command.of(wire)?.let { Request(null, it, wire) }
        }
        val json = try {
            JSONObject(text)
        } catch (e: Exception) {
            return null
        }
        if (json.optInt("v", -1) != VERSION) return null
        val wire = json.optString("cmd", "")
        if (wire.isEmpty()) return null
        val id = if (json.has("id")) json.optInt("id") else null
        return Request(id, Command.of(wire), wire)
    }

    fun ok(id: Int?, done: Done, status: Status): ByteArray =
        base(status).apply {
            if (id != null) put("id", id)
            put("ok", true)
            put("did", done.wire)
        }.bytes()

    fun error(id: Int?, failure: Failure, status: Status): ByteArray =
        base(status).apply {
            if (id != null) put("id", id)
            put("ok", false)
            put("error", failure.wire)
        }.bytes()

    fun status(status: Status): ByteArray = base(status).bytes()

    private fun base(status: Status) = JSONObject().apply {
        put("v", VERSION)
        put("laptop", status.laptop ?: JSONObject.NULL)
        put("camera", status.camera)
    }

    private fun JSONObject.bytes() = toString().toByteArray(Charsets.UTF_8)
}
