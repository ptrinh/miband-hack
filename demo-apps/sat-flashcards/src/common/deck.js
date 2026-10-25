// Access to the word list (pure, no platform APIs) — MIT License.
//
// words.js stores each entry as one string "word|pos|definition|example". The scheduler only
// needs the words, so keysOf() extracts them once at startup; a full entry is split only when
// it is shown.

export function keysOf(lines) {
  var keys = [];
  for (var i = 0; i < lines.length; i++) keys.push(lines[i].slice(0, lines[i].indexOf('|')));
  return keys;
}

// [word, part of speech, definition, example]
export function entryAt(lines, i) {
  return lines[i].split('|');
}

export function posAt(lines, i) {
  var s = lines[i];
  var a = s.indexOf('|') + 1;
  return s.slice(a, s.indexOf('|', a));
}
