// Metronome logic: tempo limits, tap tempo, a drift-free beat clock, the vibration pattern per beat and
// the saved settings. Pure JS, no platform APIs, so it runs under plain node for the tests.

export var MIN_BPM = 30
export var MAX_BPM = 250
export var DEFAULT_BPM = 120

// beats per bar; in 6/8 the BPM counts eighth notes (six clicks per bar)
export var SIGNATURES = [
  { id: '2/4', beats: 2 },
  { id: '3/4', beats: 3 },
  { id: '4/4', beats: 4 },
  { id: '6/8', beats: 6 }
]
export var DEFAULT_SIGNATURE = '4/4'

// How beat 1 is felt: 'double' = two short pulses, 'long' = the system's long vibration.
export var ACCENTS = ['double', 'long']
export var DEFAULT_ACCENT = 'double'

export function clampBpm(n) {
  n = Math.round(Number(n))
  if (!isFinite(n)) return DEFAULT_BPM
  return Math.min(MAX_BPM, Math.max(MIN_BPM, n))
}

// delta ±1 moves by one; a bigger delta snaps to its multiples (123 +5 -> 125, 125 +5 -> 130).
export function stepBpm(bpm, delta) {
  bpm = clampBpm(bpm)
  var size = Math.abs(delta)
  if (size <= 1) return clampBpm(bpm + delta)
  var next = delta > 0 ? Math.floor(bpm / size) * size + size : Math.ceil(bpm / size) * size - size
  return clampBpm(next)
}

export function interval(bpm) {
  return 60000 / clampBpm(bpm)
}

export function signature(id) {
  for (var i = 0; i < SIGNATURES.length; i++) if (SIGNATURES[i].id === id) return SIGNATURES[i]
  return signature(DEFAULT_SIGNATURE)
}

export function nextSignature(id) {
  for (var i = 0; i < SIGNATURES.length; i++) {
    if (SIGNATURES[i].id === id) return SIGNATURES[(i + 1) % SIGNATURES.length].id
  }
  return DEFAULT_SIGNATURE
}

export function nextAccent(style) {
  return style === 'double' ? 'long' : 'double'
}

// Usual Italian tempo markings, by lower bound.
var NAMES = [
  [30, 'Grave'],
  [40, 'Largo'],
  [60, 'Larghetto'],
  [66, 'Adagio'],
  [76, 'Andante'],
  [108, 'Moderato'],
  [120, 'Allegro'],
  [156, 'Vivace'],
  [176, 'Presto'],
  [200, 'Prestissimo']
]

export function tempoName(bpm) {
  bpm = clampBpm(bpm)
  var name = NAMES[0][1]
  for (var i = 0; i < NAMES.length; i++) if (bpm >= NAMES[i][0]) name = NAMES[i][1]
  return name
}

// ---- tap tempo ----

export var TAP_RESET = 2000 // ms without a tap starts a new measurement
export var TAP_KEEP = 5 // taps kept: the BPM is the average of the last 4 intervals

export function createTapper() {
  return { taps: [] }
}

// Records a tap at time `now` (ms). Returns the BPM once there are two taps, else 0.
export function tap(t, now) {
  var taps = t.taps
  var last = taps.length ? taps[taps.length - 1] : -Infinity
  var gap = now - last
  if (gap > TAP_RESET || gap <= 0) {
    t.taps = [now]
    return 0
  }
  // A gap far off the running average means the player changed tempo: measure from the previous tap.
  if (taps.length >= 2) {
    var avg = (last - taps[0]) / (taps.length - 1)
    if (gap > avg * 1.6 || gap < avg / 1.6) taps = [last]
  }
  taps.push(now)
  while (taps.length > TAP_KEEP) taps.shift()
  t.taps = taps
  if (taps.length < 2) return 0
  return clampBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)))
}

// ---- beat clock ----
// Every beat time is computed from an anchor (base + k * interval), never by adding up timer delays,
// so late timers do not accumulate drift. Retempo moves the anchor to the last beat.

export function createClock(bpm, beats, now) {
  return { base: now, k: -1, interval: interval(bpm), beats: beats, count: 0 }
}

export function beatAt(c, k) {
  return c.base + k * c.interval
}

// Called when the timer fires (and once right after createClock). Fires beat k+1 if it is due,
// skips beats missed by more than half an interval (the app stalled: no burst of catch-up beats).
// Returns { fire, index, accent, delay } where delay is the ms to wait before calling again.
export function advance(c, now) {
  var k = c.k + 1
  var at = beatAt(c, k)
  if (now < at - 1) return { fire: false, index: -1, accent: false, delay: at - now }
  var fire = now - at <= c.interval / 2
  if (!fire) k = Math.ceil((now - c.base) / c.interval) // first beat still ahead
  var index = -1
  if (fire) {
    c.k = k
    index = c.count % c.beats
    c.count++
  } else {
    c.k = k - 1
  }
  return { fire: fire, index: index, accent: index === 0, delay: Math.max(0, beatAt(c, c.k + 1) - now) }
}

// New tempo while running: the next beat comes one new interval after the last one (or now).
// Returns the delay to the next beat.
export function retempo(c, bpm, now) {
  var last = c.k >= 0 ? beatAt(c, c.k) : c.base - c.interval
  c.interval = interval(bpm)
  c.base = Math.max(last, now - c.interval)
  c.k = 0
  return Math.max(0, beatAt(c, 1) - now)
}

// New time signature while running: the next beat is a downbeat.
export function setBeats(c, beats) {
  c.beats = beats
  c.count = 0
}

// ---- vibration ----
// Mi Band 9/10 only support vibrator.vibrate({ mode: 'short' | 'long' }) (no duration control).
// Returns the pulses of one beat as [{ at: ms after the beat, mode }].
export var DOUBLE_GAP = 110

export function pulses(accent, style, intervalMs) {
  if (!accent) return [{ at: 0, mode: 'short' }]
  if (style === 'long') return [{ at: 0, mode: 'long' }]
  var gap = Math.min(DOUBLE_GAP, Math.floor(intervalMs * 0.4))
  return [{ at: 0, mode: 'short' }, { at: gap, mode: 'short' }]
}

// ---- saved settings ----

export function parseSettings(text) {
  var s = { bpm: DEFAULT_BPM, sig: DEFAULT_SIGNATURE, accent: DEFAULT_ACCENT }
  var o = null
  try {
    o = JSON.parse(text)
  } catch (e) {
    return s
  }
  if (!o || typeof o !== 'object') return s
  if (typeof o.bpm === 'number') s.bpm = clampBpm(o.bpm)
  if (typeof o.sig === 'string') s.sig = signature(o.sig).id
  if (ACCENTS.indexOf(o.accent) >= 0) s.accent = o.accent
  return s
}

export function serializeSettings(s) {
  return JSON.stringify({ bpm: clampBpm(s.bpm), sig: signature(s.sig).id, accent: s.accent })
}
