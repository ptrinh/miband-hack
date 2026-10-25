// Platform side of the Checklist: reads the lists bundled in the package and keeps ticks in
// @system.storage.
//
// /common/lists.json is NOT imported (an import would inline it into the compiled page JS). It
// stays a plain resource file inside the .rpk and is read at runtime with @system.file, the same
// way as the Notes demo, so the web app can swap it by re-packing the rpk without the toolchain.
import file from '@system.file'
import storage from '@system.storage'
import { normalize, parseTicks, serializeTicks } from './model.js'

export var LISTS_URI = '/common/lists.json'
export var TICKS_KEY = 'checklist-ticks'

// cb(error, lists)
export function loadLists(cb) {
  file.readText({
    uri: LISTS_URI,
    success: function (res) {
      var lists
      try {
        lists = normalize(JSON.parse(res.text))
      } catch (e) {
        cb('bad lists.json', [])
        return
      }
      cb(null, lists)
    },
    fail: function (data, code) {
      cb('read failed (' + code + ')', [])
    }
  })
}

// cb(ticks); a missing or unreadable value means nothing is ticked.
export function loadTicks(cb) {
  storage.get({
    key: TICKS_KEY,
    default: '',
    success: function (value) {
      cb(parseTicks(value))
    },
    fail: function () {
      cb({})
    }
  })
}

// An empty value deletes the key (documented behaviour of storage.set).
export function saveTicks(ticks) {
  storage.set({ key: TICKS_KEY, value: serializeTicks(ticks) })
}
