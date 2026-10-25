package uk.trinh.miband.remote

import android.content.Context
import android.media.AudioManager
import android.os.SystemClock
import android.view.KeyEvent
import uk.trinh.miband.remote.Protocol.Command
import uk.trinh.miband.remote.Protocol.Done
import uk.trinh.miband.remote.Protocol.Failure

sealed interface Outcome {
    data class Ok(val done: Done) : Outcome
    data class Err(val failure: Failure) : Outcome
}

/**
 * What each band button does on the phone:
 * - Shutter: takes a photo in this app's camera screen (CameraActivity) when it is open. Android does not let
 *   an ordinary app press another app's shutter or inject volume-key presses, so there is no "any camera app" mode.
 * - Prev / Next: Left / Right arrow on the computer connected over [HidKeyboard]; with no computer connected,
 *   previous / next track of whatever is playing on the phone.
 * - Play / Pause: the media key, delivered to the app that owns the active media session (Spotify, YouTube…).
 */
class Actions(context: Context, private val hid: HidKeyboard) {
    private val audio = context.getSystemService(AudioManager::class.java)

    fun run(command: Command): Outcome = when (command) {
        Command.SHUTTER -> if (Shutter.fire()) Outcome.Ok(Done.PHOTO) else Outcome.Err(Failure.CAMERA_CLOSED)
        Command.PREV -> slide(KeyReport.KEY_LEFT, KeyEvent.KEYCODE_MEDIA_PREVIOUS)
        Command.NEXT -> slide(KeyReport.KEY_RIGHT, KeyEvent.KEYCODE_MEDIA_NEXT)
        Command.PLAY_PAUSE -> media(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, Done.MEDIA)
        Command.HELLO -> Outcome.Ok(Done.HELLO)
    }

    private fun slide(hidKey: Int, mediaKey: Int): Outcome {
        if (hid.host == null) return media(mediaKey, Done.TRACK)
        return if (hid.tap(hidKey)) Outcome.Ok(Done.SLIDE) else Outcome.Err(Failure.FAILED)
    }

    private fun media(keyCode: Int, done: Done): Outcome {
        val am = audio ?: return Outcome.Err(Failure.FAILED)
        val now = SystemClock.uptimeMillis()
        am.dispatchMediaKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, keyCode, 0))
        am.dispatchMediaKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, keyCode, 0))
        return Outcome.Ok(done)
    }
}
