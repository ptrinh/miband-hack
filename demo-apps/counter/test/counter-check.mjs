// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import * as C from '../src/common/counter.js';

// fresh state: four empty slots named "Counter 1..4", no goals
let s = C.createState();
assert.equal(s.slots.length, C.SLOTS);
assert.equal(s.cur, 0);
assert.deepEqual(s.slots.map((_, i) => C.nameOf(s, i)), ['Counter 1', 'Counter 2', 'Counter 3', 'Counter 4']);
assert.equal(C.goalLine(C.current(s)), 'Tap anywhere');

// +1 / −1, never below zero
assert.equal(C.increment(s), 'tap');
assert.equal(C.increment(s), 'tap');
assert.equal(C.current(s).count, 2);
assert.equal(C.goalLine(C.current(s)), '');
assert.equal(C.decrement(s), true);
assert.equal(C.decrement(s), true);
assert.equal(C.decrement(s), false);
assert.equal(C.current(s).count, 0);

// goal: long buzz exactly at the goal and at every multiple (prayer-bead rounds), tick once reached
C.setGoal(s, 33);
const events = [];
for (let i = 0; i < 100; i++) events.push(C.increment(s));
assert.deepEqual(events.map((e, i) => (e === 'goal' ? i + 1 : 0)).filter(Boolean), [33, 66, 99]);
assert.ok(events.every((e) => e === 'tap' || e === 'goal'));
assert.equal(C.reached(C.current(s)), true);
assert.equal(C.goalLine(C.current(s)), '✓ 33 ×3');
C.current(s).count = 40;
assert.equal(C.goalLine(C.current(s)), '✓ 33');
C.current(s).count = 32;
assert.equal(C.reached(C.current(s)), false);
assert.equal(C.goalLine(C.current(s)), 'of 33');
// −1 below the goal clears the tick; +1 back onto it buzzes again
assert.equal(C.increment(s), 'goal');
C.decrement(s);
assert.equal(C.increment(s), 'goal');
// goal off
C.setGoal(s, 0);
assert.equal(C.reached(C.current(s)), false);
assert.equal(C.increment(s), 'tap');
assert.equal(C.goalLabel(0), 'Off');
assert.equal(C.goalLabel(108), '108');
// every preset is a valid goal, Off first
assert.equal(C.GOALS[0], 0);
for (const g of C.GOALS) { C.setGoal(s, g); assert.equal(C.current(s).goal, g); }
C.setGoal(s, -5);
assert.equal(C.current(s).goal, 0);
C.setGoal(s, 2.5);
assert.equal(C.current(s).goal, 0);

// reset reports whether anything changed
assert.equal(C.reset(s), true);
assert.equal(C.current(s).count, 0);
assert.equal(C.reset(s), false);

// slots are independent
C.select(s, 2);
assert.equal(s.cur, 2);
C.increment(s);
C.setGoal(s, 10);
C.select(s, 0);
assert.equal(C.current(s).count, 0);
assert.equal(s.slots[2].count, 1);
assert.equal(s.slots[2].goal, 10);
C.select(s, 9); // out of range: ignored
assert.equal(s.cur, 0);

// rename cycles the presets and comes back to "Counter n"
C.select(s, 1);
const names = [];
for (let i = 0; i < C.NAMES.length; i++) { C.rename(s); names.push(C.nameOf(s, 1)); }
assert.deepEqual(names, [...C.NAMES.slice(1), 'Counter 2']);
for (const n of C.NAMES) assert.ok(n.length <= 9, 'name too long for the pill: ' + n);

// maximum
C.current(s).count = C.MAX_COUNT - 1;
assert.equal(C.increment(s), 'tap');
assert.equal(C.increment(s), '');
assert.equal(C.current(s).count, C.MAX_COUNT);

// number size class by digit count
assert.deepEqual([0, 9, 99, 100, 999, 1000, 9999, 10000, 99999, 100000, C.MAX_COUNT].map(C.sizeClass),
  ['n-2', 'n-2', 'n-2', 'n-3', 'n-3', 'n-4', 'n-4', 'n-5', 'n-5', 'n-6', 'n-6']);

// serialize → deserialize round trip
C.rename(s);
const back = C.deserialize(C.serialize(s));
assert.deepEqual(back, s);

// broken or hostile storage never throws and falls back field by field
for (const bad of ['', 'null', '42', '{', '[]', '"x"', undefined]) assert.deepEqual(C.deserialize(bad), C.createState());
const partial = C.deserialize(JSON.stringify({
  cur: 7,
  slots: [{ count: -3, goal: 'x', name: 99 }, null, { count: 5.5, goal: 33, name: 2 }, { count: 1e9 }, { count: 4 }]
}));
assert.equal(partial.cur, 0);
assert.deepEqual(partial.slots, [
  { count: 0, goal: 0, name: 0 },
  { count: 0, goal: 0, name: 0 },
  { count: 0, goal: 33, name: 2 },
  { count: 0, goal: 0, name: 0 }
]);

// taps vs swipes and the left-edge Back strip
assert.equal(C.isTap({ x: 100, y: 200 }, { x: 104, y: 205 }), true);
assert.equal(C.isTap({ x: 100, y: 200 }, null), true);
assert.equal(C.isTap({ x: 100, y: 200 }, { x: 100 + C.SLOP, y: 200 }), false); // swipe right
assert.equal(C.isTap({ x: 100, y: 200 }, { x: 100, y: 200 - C.SLOP }), false); // swipe up
assert.equal(C.isTap({ x: C.EDGE - 1, y: 200 }, { x: C.EDGE - 1, y: 200 }), false); // left edge
assert.equal(C.isTap({ x: C.EDGE, y: 200 }, { x: C.EDGE, y: 200 }), true);
assert.equal(C.isTap(null, { x: 100, y: 200 }), false);

console.log('ok counter checks');
