// Reads the decks bundled in the package (MIT License).
//
// Like Notes, the decks are NOT imported (an import would inline them into the compiled page JS):
// they are plain resource files inside the .rpk, read at runtime with @system.file, which accepts
// app resource paths. The web app swaps them by re-packing and re-signing the rpk.
//   /common/decks.json      {"v":1,"decks":[{"id","name","n","file":"/common/deck0.json"}]}
//   /common/deck<N>.json    {"v":1,"id","name","cards":["id\tfront\tback\tnote", …]}
// Only one deck is held in memory at a time.
import file from '@system.file'
import { cleanIndex, cleanCards } from './deck.js'

export var INDEX_URI = '/common/decks.json'

function readJson(uri, cb) {
  file.readText({
    uri: uri,
    success: function (res) {
      var data
      try {
        data = JSON.parse(res.text)
      } catch (e) {
        cb('bad ' + uri)
        return
      }
      cb(null, data)
    },
    fail: function (data, code) {
      cb('read failed (' + code + ')')
    }
  })
}

// cb(error, decks)
export function loadIndex(cb) {
  readJson(INDEX_URI, function (err, data) {
    cb(err, err ? [] : cleanIndex(data))
  })
}

// cb(error, cards)
export function loadDeck(uri, cb) {
  readJson(uri, function (err, data) {
    cb(err, err ? [] : cleanCards(data && data.cards))
  })
}
