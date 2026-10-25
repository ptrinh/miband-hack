// Access to a user deck (pure, no platform APIs) — MIT License.
//
// The web app writes each deck as /common/deck<N>.json = {"v":1,"id":"…","name":"…","cards":[…]}
// where every card is one string "id\tfront\tback\tnote" (the web app turns tabs and line breaks in
// the text into spaces, so a tab only ever separates fields). One string per card keeps the number
// of objects low for the band's JS engine, as in SAT Flashcards' words.js; a card is split into its
// fields only when it is shown. The id is computed by the web app from the front and back, so a
// card keeps its progress as long as its front and back are unchanged.

var SEP = '\t';

// The card ids, in deck order (what the Leitner scheduler keys progress by).
export function keysOf(lines) {
  var keys = [];
  for (var i = 0; i < lines.length; i++) keys.push(lines[i].slice(0, lines[i].indexOf(SEP)));
  return keys;
}

// [id, front, back, note] (note may be '')
export function entryAt(lines, i) {
  var f = lines[i].split(SEP);
  while (f.length < 4) f.push('');
  return f;
}

// Keeps only well-formed cards: "id\tfront\tback[\tnote]" with a non-empty id, front and back.
export function cleanCards(list) {
  var out = [];
  if (!Array.isArray(list)) return out;
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (typeof s !== 'string') continue;
    var f = s.split(SEP);
    if (f.length < 3 || !f[0] || !f[1] || !f[2] || seen[f[0]]) continue;
    seen[f[0]] = 1;
    out.push(s);
  }
  return out;
}

// Deck index (/common/decks.json): [{ id, name, n, file }], malformed entries dropped.
export function cleanIndex(data) {
  var list = data && Array.isArray(data.decks) ? data.decks : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var d = list[i] || {};
    if (typeof d.id !== 'string' || !d.id || typeof d.file !== 'string' || !d.file) continue;
    out.push({
      id: d.id,
      name: typeof d.name === 'string' && d.name ? d.name : 'Deck ' + (i + 1),
      n: typeof d.n === 'number' && d.n >= 0 ? d.n : 0,
      file: d.file
    });
  }
  return out;
}

// Display width of a text in "narrow character" units: CJK ideographs, kana, Hangul and
// full-width forms count 2, everything else (Latin, Vietnamese with its diacritics, digits) 1.
export function textWidth(s) {
  var w = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) continue; // low surrogate: counted with its high half
    if (
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0xd800 && c <= 0xdbff)
    ) w += 2;
    else w += 1;
  }
  return w;
}

// Font size classes, biggest first: [max width, class]. The last class takes anything longer.
var FRONT = [[10, 'f-xl'], [18, 'f-l'], [34, 'f-m'], [60, 'f-s'], [Infinity, 'f-xs']];
var BACK = [[24, 'b-l'], [60, 'b-m'], [120, 'b-s'], [Infinity, 'b-xs']];
var CHOICE = [[12, 'c-l'], [26, 'c-m'], [52, 'c-s'], [Infinity, 'c-xs']];
var SIZES = { front: FRONT, back: BACK, choice: CHOICE };

// The CSS class that lets a text of this length fit its box ('front', 'back' or 'choice').
export function sizeClass(kind, text) {
  var steps = SIZES[kind];
  var w = textWidth(text || '');
  for (var i = 0; i < steps.length; i++) if (w <= steps[i][0]) return steps[i][1];
  return steps[steps.length - 1][1];
}

// "deckId:learned:total;…": what the deck list shows, saved by the study page.
export function parseSummary(text) {
  var out = {};
  if (!text || typeof text !== 'string') return out;
  var parts = text.split(';');
  for (var i = 0; i < parts.length; i++) {
    var f = parts[i].split(':');
    if (f.length !== 3 || !f[0]) continue;
    var l = +f[1], t = +f[2];
    if (!(l >= 0) || !(t >= 0)) continue;
    out[f[0]] = { learned: Math.floor(l), total: Math.floor(t) };
  }
  return out;
}

export function serializeSummary(map) {
  var out = [];
  for (var id in map) {
    if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
    out.push(id + ':' + map[id].learned + ':' + map[id].total);
  }
  return out.join(';');
}
