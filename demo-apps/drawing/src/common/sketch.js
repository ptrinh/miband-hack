// Drawing engine (pure, no platform APIs) — MIT License.
//
// Xiaomi Vela's documented component set has no <canvas>, so a stroke is
// rendered as a chain of small round, absolutely positioned dots. This module
// turns touch points into dots: it interpolates between consecutive points
// (so fast swipes still give a continuous line), de-duplicates dots that
// would overlap almost completely, and caps the total so the band's UI tree
// stays small.

export var COLORS = ['#ffffff', '#ff453a', '#ffd60a', '#32d74b', '#0a84ff'];
export var SIZES = [4, 8, 14]; // dot diameter in design px (designWidth 192)
export var MAX_DOTS = 1000;

export function createSketch() {
  return { dots: [], seen: {}, stroke: 0, last: null, full: false };
}

function cellKey(x, y, size, color) {
  var q = Math.max(1, Math.round(size * 0.35));
  return color + ':' + size + ':' + Math.round(x / q) + ':' + Math.round(y / q);
}

function pushDot(sk, x, y, size, color) {
  if (sk.dots.length >= MAX_DOTS) {
    sk.full = true;
    return false;
  }
  var key = cellKey(x, y, size, color);
  if (sk.seen[key]) return false;
  sk.seen[key] = true;
  var r = size / 2;
  // Stored as top-left corner so the template needs no arithmetic.
  sk.dots.push({ x: Math.round(x - r), y: Math.round(y - r), s: size, c: color, k: sk.stroke, key: key });
  return true;
}

// Returns the dots added by this call (for incremental rendering).
export function beginStroke(sk, x, y, size, color) {
  sk.stroke += 1;
  sk.last = { x: x, y: y };
  var before = sk.dots.length;
  pushDot(sk, x, y, size, color);
  return sk.dots.slice(before);
}

export function extendStroke(sk, x, y, size, color) {
  if (!sk.last) return beginStroke(sk, x, y, size, color);
  var before = sk.dots.length;
  var dx = x - sk.last.x;
  var dy = y - sk.last.y;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var step = Math.max(1.5, size * 0.4); // overlap => looks like a line with round caps/joins
  if (dist < step) return [];
  var n = Math.floor(dist / step);
  for (var i = 1; i <= n; i++) {
    var t = (i * step) / dist;
    pushDot(sk, sk.last.x + dx * t, sk.last.y + dy * t, size, color);
  }
  var t2 = (n * step) / dist;
  sk.last = { x: sk.last.x + dx * t2, y: sk.last.y + dy * t2 };
  return sk.dots.slice(before);
}

export function endStroke(sk) {
  sk.last = null;
}

function rebuildSeen(sk) {
  sk.seen = {};
  for (var i = 0; i < sk.dots.length; i++) sk.seen[sk.dots[i].key] = true;
  sk.full = sk.dots.length >= MAX_DOTS;
}

// Removes every dot whose centre is within radius of (x, y). Returns count removed.
export function eraseAt(sk, x, y, radius) {
  var keep = [];
  var removed = 0;
  for (var i = 0; i < sk.dots.length; i++) {
    var d = sk.dots[i];
    var cx = d.x + d.s / 2 - x;
    var cy = d.y + d.s / 2 - y;
    var rr = radius + d.s / 2;
    if (cx * cx + cy * cy <= rr * rr) removed++;
    else keep.push(d);
  }
  if (removed) {
    sk.dots = keep;
    rebuildSeen(sk);
  }
  return removed;
}

// Erases along the segment from the previous erase point, so quick swipes don't skip.
export function eraseStroke(sk, x, y, radius) {
  var removed = 0;
  if (sk.last) {
    var dx = x - sk.last.x;
    var dy = y - sk.last.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var n = Math.max(1, Math.ceil(dist / radius));
    for (var i = 1; i <= n; i++) removed += eraseAt(sk, sk.last.x + (dx * i) / n, sk.last.y + (dy * i) / n, radius);
  } else {
    removed = eraseAt(sk, x, y, radius);
  }
  sk.last = { x: x, y: y };
  return removed;
}

// Removes the most recent drawn stroke. Returns true if something was removed.
export function undo(sk) {
  if (!sk.dots.length) return false;
  var k = sk.dots[sk.dots.length - 1].k;
  var i = sk.dots.length;
  while (i > 0 && sk.dots[i - 1].k === k) i--;
  sk.dots = sk.dots.slice(0, i);
  rebuildSeen(sk);
  return true;
}

export function clear(sk) {
  sk.dots = [];
  sk.seen = {};
  sk.last = null;
  sk.full = false;
}

// Compact text form for @system.storage: "x,y,size,colorIndex,stroke;..."
export function serialize(sk) {
  var out = [];
  for (var i = 0; i < sk.dots.length; i++) {
    var d = sk.dots[i];
    out.push(d.x + ',' + d.y + ',' + d.s + ',' + COLORS.indexOf(d.c) + ',' + d.k);
  }
  return out.join(';');
}

export function deserialize(text) {
  var sk = createSketch();
  if (!text || typeof text !== 'string') return sk;
  var parts = text.split(';');
  for (var i = 0; i < parts.length && sk.dots.length < MAX_DOTS; i++) {
    var f = parts[i].split(',');
    if (f.length !== 5) continue;
    var x = +f[0], y = +f[1], s = +f[2], ci = +f[3], k = +f[4];
    if (!isFinite(x) || !isFinite(y) || SIZES.indexOf(s) < 0 || !COLORS[ci] || !isFinite(k)) continue;
    var c = COLORS[ci];
    var key = cellKey(x + s / 2, y + s / 2, s, c);
    if (sk.seen[key]) continue;
    sk.seen[key] = true;
    sk.dots.push({ x: x, y: y, s: s, c: c, k: k, key: key });
    if (k > sk.stroke) sk.stroke = k;
  }
  sk.full = sk.dots.length >= MAX_DOTS;
  return sk;
}
