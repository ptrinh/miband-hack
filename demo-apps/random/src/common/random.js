// Random number engine (pure, no platform APIs) — MIT License.
//
// Randomness: Vela's crypto module has no random-bytes call (and is not available on Mi Band 9 / 10 at all),
// so the only source is Math.random(). randInt() turns it into unbiased integers: each draw takes 32 bits
// (floor(rand() * 2^32)) and rejects the top (2^32 mod range) values, so every value in the range is hit by
// exactly the same number of 32-bit inputs (no modulo bias).
// Every function that draws takes rand() (returns [0, 1)) so tests can inject their own.

export var LOW = 0; // smallest number the band can set
export var HIGH = 9999; // largest: 4 digits still fit the result line
export var DEFAULT_MIN = 1;
export var DEFAULT_MAX = 100;
export var MODES = ['number', 'dice', 'coin'];

var TWO32 = 4294967296;
var MAX_TRIES = 64; // with a working rand() a retry happens less than half the time; this only stops a broken stub

function uint32(rand) {
  var x = Math.floor(rand() * TWO32);
  return x >= TWO32 ? TWO32 - 1 : x < 0 ? 0 : x;
}

// Uniform integer in [lo, hi] (both inclusive, hi - lo < 2^32).
export function randInt(lo, hi, rand) {
  rand = rand || Math.random;
  var range = hi - lo + 1;
  if (range <= 1) return lo;
  var limit = TWO32 - (TWO32 % range); // largest multiple of range that fits in 32 bits
  var x = uint32(rand);
  for (var i = 1; x >= limit && i < MAX_TRIES; i++) x = uint32(rand);
  return lo + (x % range);
}

export function rollDice(count, rand) {
  var faces = [];
  var sum = 0;
  for (var i = 0; i < count; i++) {
    var f = randInt(1, 6, rand);
    faces.push(f);
    sum += f;
  }
  return { faces: faces, sum: sum };
}

export function flipCoin(rand) {
  return randInt(0, 1, rand) === 0 ? 'heads' : 'tails';
}

// ---- number range ----

function clamp(v) {
  return v < LOW ? LOW : v > HIGH ? HIGH : v;
}

// One press of − / +: ±1, or with big = true (held button) to the next multiple of 10 in that direction.
export function stepValue(v, dir, big) {
  if (!big) return clamp(v + dir);
  return clamp(dir > 0 ? Math.floor(v / 10) * 10 + 10 : Math.ceil(v / 10) * 10 - 10);
}

// Changes min or max; the other end is pushed along so that min <= max always holds.
export function adjust(state, which, dir, big) {
  if (which === 'min') {
    state.min = stepValue(state.min, dir, big);
    if (state.max < state.min) state.max = state.min;
  } else {
    state.max = stepValue(state.max, dir, big);
    if (state.min > state.max) state.min = state.max;
  }
  return state;
}

// ---- no repeats: draw without replacement ----
// The pool stores only the numbers drawn so far (in draw order), so a 1–9999 range costs nothing up front.

export function newPool(min, max) {
  return { min: min, max: max, drawn: [] };
}

// The pool for the current range: a range change starts a fresh pool.
export function poolFor(state) {
  var p = state.pool;
  if (!p || p.min !== state.min || p.max !== state.max) state.pool = newPool(state.min, state.max);
  return state.pool;
}

export function poolTotal(pool) {
  return pool.max - pool.min + 1;
}

export function poolLeft(pool) {
  return poolTotal(pool) - pool.drawn.length;
}

// Draws one number not drawn before, uniformly among those left; null when the pool is used up.
export function drawFromPool(pool, rand) {
  var left = poolLeft(pool);
  if (left <= 0) return null;
  // The k-th number (0-based) of the range that has not been drawn yet.
  var v = pool.min + randInt(0, left - 1, rand);
  var sorted = pool.drawn.slice().sort(function (a, b) { return a - b; });
  for (var i = 0; i < sorted.length && sorted[i] <= v; i++) v++;
  pool.drawn.push(v);
  return v;
}

// ---- dice faces ----

// Pip cells of a die face on a 3 x 3 grid, numbered 0..8 left to right, top to bottom.
var PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

// Pip positions ({l, t} in px) for a die of `size` px with pips of `pip` px.
export function pipPositions(face, size, pip) {
  var cells = PIPS[face] || [];
  var pad = Math.round(size * 0.14);
  var gap = (size - 2 * pad - pip) / 2;
  var out = [];
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    out.push({ l: Math.round(pad + (c % 3) * gap), t: Math.round(pad + Math.floor(c / 3) * gap) });
  }
  return out;
}

// ---- saved settings ----

export function defaults() {
  return { mode: 'number', min: DEFAULT_MIN, max: DEFAULT_MAX, dice: 1, noRepeat: false, pool: null };
}

function isInt(v) {
  return typeof v === 'number' && Math.floor(v) === v && v >= LOW && v <= HIGH;
}

// Parses what serialize() wrote; anything missing or invalid falls back to the default.
export function parseState(text) {
  var s = defaults();
  var o = null;
  try {
    o = JSON.parse(text);
  } catch (e) {
    return s;
  }
  if (!o || typeof o !== 'object') return s;
  if (MODES.indexOf(o.mode) >= 0) s.mode = o.mode;
  if (isInt(o.min) && isInt(o.max) && o.min <= o.max) {
    s.min = o.min;
    s.max = o.max;
  }
  if (o.dice === 1 || o.dice === 2) s.dice = o.dice;
  s.noRepeat = o.noRepeat === true;
  var p = o.pool;
  if (p && isInt(p.min) && isInt(p.max) && p.min <= p.max && Array.isArray(p.drawn)) {
    var seen = {};
    var drawn = [];
    for (var i = 0; i < p.drawn.length; i++) {
      var v = p.drawn[i];
      if (typeof v === 'number' && Math.floor(v) === v && v >= p.min && v <= p.max && !seen[v]) {
        seen[v] = true;
        drawn.push(v);
      }
    }
    s.pool = { min: p.min, max: p.max, drawn: drawn };
  }
  return s;
}

export function serialize(s) {
  return JSON.stringify({ mode: s.mode, min: s.min, max: s.max, dice: s.dice, noRepeat: s.noRepeat, pool: s.pool });
}
