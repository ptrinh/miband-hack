// Reads the notes bundled in the package at /common/notes.json.
//
// The file is NOT imported (an import would inline it into the compiled page JS). It stays a
// plain resource file inside the .rpk and is read at runtime with @system.file, whose readText
// accepts app resource paths. That is what lets the web app swap the notes by re-packing the rpk
// without running the toolchain.
import file from '@system.file'

export var NOTES_URI = '/common/notes.json'

export function normalize(data) {
  var list = data && Array.isArray(data.notes) ? data.notes : []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var n = list[i] || {}
    var title = typeof n.title === 'string' ? n.title.trim() : ''
    var body = typeof n.body === 'string' ? n.body : ''
    if (!title && !body) continue
    out.push({ title: title || '(untitled)', body: body })
  }
  return out
}

// Splits a body into paragraphs so line breaks show up even if <text> ignores "\n".
export function paragraphs(body) {
  var parts = String(body || '').replace(/\r\n?/g, '\n').split('\n')
  var out = []
  for (var i = 0; i < parts.length; i++) out.push({ t: parts[i] === '' ? ' ' : parts[i] })
  return out
}

// cb(error, notes)
export function loadNotes(cb) {
  file.readText({
    uri: NOTES_URI,
    success: function (res) {
      var notes
      try {
        notes = normalize(JSON.parse(res.text))
      } catch (e) {
        cb('bad notes.json', [])
        return
      }
      cb(null, notes)
    },
    fail: function (data, code) {
      cb('read failed (' + code + ')', [])
    }
  })
}
