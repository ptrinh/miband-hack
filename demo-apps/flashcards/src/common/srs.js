// Leitner-box scheduler for the flashcards (pure, no platform APIs) — MIT License.
//
// Every word the user has seen sits in a box 0..5 with a due day. "Know it" moves it
// up one box (a word known on first sight starts in box 2), "Again" drops it to box 0,
// due today. The interval grows with the box, so known words come back less and less.
// Within a session an "Again" card waits a few cards before it is shown again.
//
// Progress is keyed by the word itself, so the bundled list can change between versions.

export var INTERVALS = [0, 1, 3, 7, 14, 30]; // days until due, per box
export var MAX_BOX = INTERVALS.length - 1;
export var LEARNED_BOX = 2; // "learned" = known on first sight, or twice in a row
export var AGAIN_GAP = 3; // cards to show before an "Again" card returns

// Local day number (days since 1970-01-01 in local time).
export function dayNumber(date) {
  var d = date || new Date();
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

export function createState() {
  return { cards: {} };
}

export function createSession() {
  return { step: 0, soon: {}, last: '' };
}

// Order in which new words are introduced: a fixed shuffle, so the list
// (stored alphabetically) is not learned a-to-z, and the order is the same every launch.
export function newOrder(n, seed) {
  var order = [];
  for (var i = 0; i < n; i++) order.push(i);
  var s = (seed || 20261025) % 2147483647;
  for (var j = n - 1; j > 0; j--) {
    s = (s * 48271) % 2147483647; // Park-Miller: stays exact in doubles, no Math.imul needed
    var k = s % (j + 1);
    var t = order[j];
    order[j] = order[k];
    order[k] = t;
  }
  return order;
}

// keys: the words of the list (deck.js keysOf), in list order.
// Picks the next word index, or -1 when nothing is due and every word has been seen.
// Order: due cards (lowest box first, then oldest), then a new word, then "Again"
// cards still waiting out their gap (so the user is never left with an empty screen).
export function nextCard(state, keys, order, today, session) {
  var best = -1, bestCard = null;
  var held = -1, heldSoon = Infinity;
  for (var i = 0; i < keys.length; i++) {
    var w = keys[i];
    var c = state.cards[w];
    if (!c || c.d > today) continue;
    var soon = session.soon[w];
    if (w === session.last || (soon !== undefined && soon > session.step)) {
      var rank = w === session.last ? Infinity : soon;
      if (held < 0 || rank < heldSoon) {
        held = i;
        heldSoon = rank;
      }
      continue;
    }
    if (!bestCard || c.b < bestCard.b || (c.b === bestCard.b && c.d < bestCard.d)) {
      best = i;
      bestCard = c;
    }
  }
  if (best >= 0) return best;
  for (var j = 0; j < order.length; j++) {
    if (!state.cards[keys[order[j]]]) return order[j];
  }
  return held;
}

export function isNew(state, word) {
  return !state.cards[word];
}

export function answer(state, word, known, today, session) {
  var c = state.cards[word];
  var box;
  if (known) box = c ? Math.min(c.b + 1, MAX_BOX) : LEARNED_BOX;
  else box = 0;
  state.cards[word] = { b: box, d: today + INTERVALS[box] };
  session.step += 1;
  session.last = word;
  if (known) delete session.soon[word];
  else session.soon[word] = session.step + AGAIN_GAP;
  return box;
}

// Counts over the bundled list only (stale entries for removed words are ignored).
export function stats(state, keys, today) {
  var s = { total: keys.length, seen: 0, learned: 0, mastered: 0, due: 0, boxes: [] };
  for (var b = 0; b <= MAX_BOX; b++) s.boxes.push(0);
  for (var i = 0; i < keys.length; i++) {
    var c = state.cards[keys[i]];
    if (!c) continue;
    s.seen++;
    s.boxes[c.b]++;
    if (c.b >= LEARNED_BOX) s.learned++;
    if (c.b === MAX_BOX) s.mastered++;
    if (c.d <= today) s.due++;
  }
  return s;
}

// Compact text form for @system.storage: "word:box:dueDay;..."
export function serialize(state) {
  var out = [];
  for (var w in state.cards) {
    if (!Object.prototype.hasOwnProperty.call(state.cards, w)) continue;
    var c = state.cards[w];
    out.push(w + ':' + c.b + ':' + c.d);
  }
  return out.join(';');
}

export function deserialize(text) {
  var state = createState();
  if (!text || typeof text !== 'string') return state;
  var parts = text.split(';');
  for (var i = 0; i < parts.length; i++) {
    var f = parts[i].split(':');
    if (f.length !== 3 || !f[0]) continue;
    var b = +f[1], d = +f[2];
    if (!(b >= 0 && b <= MAX_BOX) || Math.floor(b) !== b || !isFinite(d)) continue;
    state.cards[f[0]] = { b: b, d: Math.floor(d) };
  }
  return state;
}

var POS = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb' };

export function partOfSpeech(p) {
  return POS[p] || p || '';
}
