// Tally counter state (pure, no platform APIs) — MIT License.
//
// A few counter slots, each with a count, an optional goal and a name picked from presets.
// The page owns storage, vibration and touch; everything it decides goes through here so it
// can be tested in plain node (test/counter-check.mjs).

export var SLOTS = 4;
export var MAX_COUNT = 999999; // six digits still fit the 192 px screen (font shrinks with length)
export var GOALS = [0, 10, 21, 33, 50, 99, 100, 108, 500, 1000]; // 0 = no goal
// Name presets. Index 0 is "Counter <n>", numbered by slot; renaming cycles through the list.
export var NAMES = ['Counter', 'Reps', 'Laps', 'Visitors', 'Beads', 'Rounds', 'People', 'Score'];
export var EDGE = 12; // design px at the left edge left to the system Back gesture
export var SLOP = 16; // design px a touch may travel and still be a tap

function blank() {
  return { count: 0, goal: 0, name: 0 };
}

export function createState() {
  var slots = [];
  for (var i = 0; i < SLOTS; i++) slots.push(blank());
  return { cur: 0, slots: slots };
}

function int(v, lo, hi, dflt) {
  return typeof v === 'number' && v === Math.floor(v) && v >= lo && v <= hi ? v : dflt;
}

// Never throws: anything unreadable falls back to fresh counters, bad fields to their defaults.
export function deserialize(text) {
  var state = createState();
  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return state;
  }
  if (!data || typeof data !== 'object') return state;
  state.cur = int(data.cur, 0, SLOTS - 1, 0);
  var saved = Array.isArray(data.slots) ? data.slots : [];
  for (var i = 0; i < SLOTS; i++) {
    var s = saved[i];
    if (!s || typeof s !== 'object') continue;
    state.slots[i] = {
      count: int(s.count, 0, MAX_COUNT, 0),
      goal: int(s.goal, 0, MAX_COUNT, 0),
      name: int(s.name, 0, NAMES.length - 1, 0)
    };
  }
  return state;
}

export function serialize(state) {
  return JSON.stringify({ v: 1, cur: state.cur, slots: state.slots });
}

export function current(state) {
  return state.slots[state.cur];
}

export function nameOf(state, i) {
  var n = state.slots[i].name;
  return n === 0 ? NAMES[0] + ' ' + (i + 1) : NAMES[n];
}

// +1. Returns 'goal' when the count lands on the goal or a multiple of it (prayer beads: every
// 33 is a round), 'tap' for an ordinary step, '' when the count is already at the maximum.
export function increment(state) {
  var s = current(state);
  if (s.count >= MAX_COUNT) return '';
  s.count++;
  return s.goal > 0 && s.count % s.goal === 0 ? 'goal' : 'tap';
}

// −1, never below zero. Returns whether the count changed.
export function decrement(state) {
  var s = current(state);
  if (s.count <= 0) return false;
  s.count--;
  return true;
}

export function reset(state) {
  var s = current(state);
  var changed = s.count !== 0;
  s.count = 0;
  return changed;
}

export function setGoal(state, goal) {
  current(state).goal = int(goal, 0, MAX_COUNT, 0);
}

export function select(state, i) {
  state.cur = int(i, 0, SLOTS - 1, state.cur);
}

// Next preset name for the current slot.
export function rename(state) {
  var s = current(state);
  s.name = (s.name + 1) % NAMES.length;
}

export function reached(slot) {
  return slot.goal > 0 && slot.count >= slot.goal;
}

// Line under the number: progress towards the goal, a tick once reached.
export function goalLine(slot) {
  if (slot.goal <= 0) return slot.count === 0 ? 'Tap anywhere' : '';
  if (reached(slot)) {
    var rounds = Math.floor(slot.count / slot.goal);
    return '✓ ' + slot.goal + (rounds > 1 ? ' ×' + rounds : '');
  }
  return 'of ' + slot.goal;
}

export function goalLabel(goal) {
  return goal > 0 ? String(goal) : 'Off';
}

// CSS class for the big number: the font shrinks as digits are added so it always fits.
export function sizeClass(count) {
  var d = String(count).length;
  return d <= 2 ? 'n-2' : d === 3 ? 'n-3' : d === 4 ? 'n-4' : d === 5 ? 'n-5' : 'n-6';
}

// A touch on the tap area counts when it starts clear of the left edge and barely moves:
// swipes (including the system Back swipe) never count.
export function isTap(start, end) {
  if (!start || start.x < EDGE) return false;
  if (!end) return true;
  return Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) < SLOP;
}
