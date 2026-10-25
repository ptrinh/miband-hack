// Wire format between the band app and the Android companion (uk.trinh.miband.remote).
// Pure JS, no Vela imports, so test/remote-check.mjs can run it under plain node.
//
// Band -> phone (interconnect send({ data })):  { v: 1, id: 7, cmd: 'next' }
// Phone -> band (MessageApi.sendMessage bytes, UTF-8 JSON):
//   reply   { v: 1, id: 7, ok: true, did: 'slide', laptop: 'MacBook', camera: false }
//   error   { v: 1, id: 7, ok: false, error: 'camera-closed', laptop: null, camera: false }
//   status  { v: 1, laptop: 'MacBook', camera: true }   (pushed when something changes, no id)
// The same format is parsed on the phone by Protocol.kt; keep the two in sync.

export var VERSION = 1
export var COMMANDS = ['shutter', 'prev', 'next', 'playpause', 'hello']

// How long to wait for the phone's reply before saying so on the band.
export var REPLY_TIMEOUT_MS = 3000

export function encode(cmd, id) {
  return { v: VERSION, id: id, cmd: cmd }
}

// Accepts whatever onmessage hands us: the docs say a string, the official demo reads res.data.
// Returns null for anything that is not one of our messages.
export function decode(raw) {
  var data = raw
  if (data && typeof data === 'object' && data.data !== undefined && data.v === undefined) data = data.data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (e) {
      return null
    }
  }
  if (!data || typeof data !== 'object' || data.v !== VERSION) return null
  return {
    id: typeof data.id === 'number' ? data.id : null,
    ok: data.ok === true,
    isReply: typeof data.id === 'number',
    did: typeof data.did === 'string' ? data.did : '',
    error: typeof data.error === 'string' ? data.error : '',
    laptop: typeof data.laptop === 'string' && data.laptop ? data.laptop : '',
    camera: data.camera === true
  }
}

var DONE = {
  photo: 'Photo taken',
  slide: 'Slide changed',
  track: 'Track changed',
  media: 'Play / Pause sent',
  hello: 'Phone ready'
}

var ERRORS = {
  'camera-closed': 'Open the camera screen in the phone app',
  'no-target': 'Phone has nothing to control',
  'unknown-command': 'Phone app too old',
  failed: 'Phone could not do it'
}

// Short text for the line under the buttons.
export function resultText(msg) {
  if (!msg) return ''
  if (msg.ok) return DONE[msg.did] || 'Done'
  return ERRORS[msg.error] || 'Phone error'
}

// Text for a failed interconnect send(); codes from the Vela interconnect docs.
export function sendErrorText(code) {
  if (code === 204) return 'Phone timed out'
  if (code === 1006) return 'Phone not connected'
  return 'Send failed (' + code + ')'
}

// Link states: 'unsupported' (no interconnect on this band), 'connecting', 'open', 'closed', 'no-app'.
var LINK = {
  unsupported: 'No phone link on this band',
  connecting: 'Connecting…',
  open: 'Phone connected',
  closed: 'Phone not connected',
  'no-app': 'Install the phone app'
}

export function linkText(state) {
  return LINK[state] || LINK.closed
}

// onerror code -> link state (1001 = companion app not installed on the phone).
export function errorState(code) {
  return code === 1001 ? 'no-app' : 'closed'
}

// What Prev / Next will drive, shown under the link state.
export function targetText(msg) {
  if (!msg) return ''
  return msg.laptop ? 'Slides: ' + msg.laptop : 'Slides: media keys'
}
