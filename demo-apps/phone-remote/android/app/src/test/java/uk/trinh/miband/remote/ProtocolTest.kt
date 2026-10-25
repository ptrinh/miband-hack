package uk.trinh.miband.remote

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uk.trinh.miband.remote.Protocol.Command

class ProtocolTest {
    private fun bytes(s: String) = s.toByteArray(Charsets.UTF_8)

    @Test
    fun parsesWhatTheBandSends() {
        // ../band/src/common/remote.js encode('next', 7)
        val r = Protocol.parse(bytes("""{"v":1,"id":7,"cmd":"next"}"""))!!
        assertEquals(7, r.id)
        assertEquals(Command.NEXT, r.command)
        for (c in Command.entries) assertEquals(c, Protocol.parse(bytes("""{"v":1,"id":1,"cmd":"${c.wire}"}"""))!!.command)
    }

    @Test
    fun toleratesABareCommand() {
        assertEquals(Command.PLAY_PAUSE, Protocol.parse(bytes("playpause"))!!.command)
        assertEquals(Command.SHUTTER, Protocol.parse(bytes("\"shutter\""))!!.command)
        assertNull(Protocol.parse(bytes("\"selfdestruct\"")))
    }

    @Test
    fun unknownCommandIsKeptSoThePhoneCanSaySo() {
        val r = Protocol.parse(bytes("""{"v":1,"id":3,"cmd":"zoom"}"""))!!
        assertNull(r.command)
        assertEquals("zoom", r.wire)
    }

    @Test
    fun rejectsOtherMessages() {
        assertNull(Protocol.parse(bytes("")))
        assertNull(Protocol.parse(bytes("{not json")))
        assertNull(Protocol.parse(bytes("""{"v":2,"id":1,"cmd":"next"}""")))
        assertNull(Protocol.parse(bytes("""{"v":1,"id":1}""")))
    }

    @Test
    fun repliesCarryIdOutcomeAndStatus() {
        val ok = JSONObject(Protocol.ok(7, Protocol.Done.SLIDE, Protocol.Status("MacBook", false)).toString(Charsets.UTF_8))
        assertEquals(1, ok.getInt("v"))
        assertEquals(7, ok.getInt("id"))
        assertTrue(ok.getBoolean("ok"))
        assertEquals("slide", ok.getString("did"))
        assertEquals("MacBook", ok.getString("laptop"))
        assertFalse(ok.getBoolean("camera"))

        val err = JSONObject(Protocol.error(8, Protocol.Failure.CAMERA_CLOSED, Protocol.Status(null, false)).toString(Charsets.UTF_8))
        assertFalse(err.getBoolean("ok"))
        assertEquals("camera-closed", err.getString("error"))
        assertTrue(err.isNull("laptop"))

        val status = JSONObject(Protocol.status(Protocol.Status(null, true)).toString(Charsets.UTF_8))
        assertFalse(status.has("id"))
        assertTrue(status.getBoolean("camera"))
    }

    @Test
    fun keyReports() {
        assertArrayEquals(byteArrayOf(0, 0, 0x4F, 0, 0, 0, 0, 0), KeyReport.press(KeyReport.KEY_RIGHT))
        assertArrayEquals(ByteArray(8), KeyReport.release())
        // descriptor declares report ID 1 and closes its collection
        assertEquals(0x85.toByte(), KeyReport.DESCRIPTOR[6])
        assertEquals(KeyReport.REPORT_ID.toByte(), KeyReport.DESCRIPTOR[7])
        assertEquals(0xC0.toByte(), KeyReport.DESCRIPTOR.last())
    }
}
