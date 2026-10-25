// Checklist model: pure functions, no platform APIs (tested with plain node in test/model-check.mjs).
//
// Lists come from /common/lists.json (written in the web app):
//   {"lists":[{"id":"shop1","title":"Shopping","items":[{"id":"s1","text":"Milk"}]}]}
// Ticks are kept on the band, keyed by list id and item id, so re-installing the app with edited
// lists keeps the ticks of items that still exist and new items start unticked:
//   ticks = { listId: { itemId: true } }, stored as "listId:itemId,itemId;listId2:itemId"
// (ids are [a-z0-9], so ':' ',' ';' never occur in them).

var ID_RE = /^[a-z0-9]{1,16}$/

export function validId(id) {
  return typeof id === 'string' && ID_RE.test(id)
}

// Keeps the well-formed lists and items: ids valid and unique, blank items dropped.
export function normalize(data) {
  var list = data && Array.isArray(data.lists) ? data.lists : []
  var seen = {}
  var out = []
  for (var i = 0; i < list.length; i++) {
    var l = list[i] || {}
    if (!validId(l.id) || seen[l.id]) continue
    seen[l.id] = true
    var items = []
    var src = Array.isArray(l.items) ? l.items : []
    for (var j = 0; j < src.length; j++) {
      var it = src[j] || {}
      var text = typeof it.text === 'string' ? it.text.trim() : ''
      if (!text || !validId(it.id) || seen[it.id]) continue
      seen[it.id] = true
      items.push({ id: it.id, text: text })
    }
    var title = typeof l.title === 'string' ? l.title.trim() : ''
    if (!title && items.length === 0) continue
    out.push({ id: l.id, title: title || 'Untitled', items: items })
  }
  return out
}

export function parseTicks(text) {
  var ticks = {}
  var groups = String(text || '').split(';')
  for (var i = 0; i < groups.length; i++) {
    var colon = groups[i].indexOf(':')
    if (colon < 1) continue
    var listId = groups[i].slice(0, colon)
    if (!validId(listId)) continue
    var ids = groups[i].slice(colon + 1).split(',')
    for (var j = 0; j < ids.length; j++) {
      if (!validId(ids[j])) continue
      if (!ticks[listId]) ticks[listId] = {}
      ticks[listId][ids[j]] = true
    }
  }
  return ticks
}

export function serializeTicks(ticks) {
  var out = []
  for (var listId in ticks) {
    if (!Object.prototype.hasOwnProperty.call(ticks, listId)) continue
    var ids = []
    for (var id in ticks[listId]) {
      if (Object.prototype.hasOwnProperty.call(ticks[listId], id) && ticks[listId][id]) ids.push(id)
    }
    if (ids.length) out.push(listId + ':' + ids.join(','))
  }
  return out.join(';')
}

// Only the ticks of lists and items that still exist (after the lists were edited and re-installed).
export function pruneTicks(ticks, lists) {
  var out = {}
  for (var i = 0; i < lists.length; i++) {
    var l = lists[i]
    var t = ticks[l.id]
    if (!t) continue
    for (var j = 0; j < l.items.length; j++) {
      if (t[l.items[j].id]) {
        if (!out[l.id]) out[l.id] = {}
        out[l.id][l.items[j].id] = true
      }
    }
  }
  return out
}

export function countDone(list, ticks) {
  var t = ticks[list.id] || {}
  var n = 0
  for (var i = 0; i < list.items.length; i++) if (t[list.items[i].id]) n++
  return n
}

// Rows for the list page, in the order written in the web app.
export function rows(list, ticks) {
  var t = ticks[list.id] || {}
  var out = []
  for (var i = 0; i < list.items.length; i++) {
    out.push({ id: list.items[i].id, text: list.items[i].text, done: !!t[list.items[i].id] })
  }
  return out
}

// Flips one item; returns its new state.
export function toggle(ticks, listId, itemId) {
  if (!ticks[listId]) ticks[listId] = {}
  if (ticks[listId][itemId]) {
    delete ticks[listId][itemId]
    return false
  }
  ticks[listId][itemId] = true
  return true
}

export function uncheckAll(ticks, listId) {
  delete ticks[listId]
}

export function findList(lists, id) {
  for (var i = 0; i < lists.length; i++) if (lists[i].id === id) return lists[i]
  return null
}

// Width in px of a progress bar `width` px wide.
export function fillWidth(done, total, width) {
  return total ? Math.round((width * done) / total) : 0
}
