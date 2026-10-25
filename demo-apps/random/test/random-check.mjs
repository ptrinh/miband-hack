// Run: npm test   (plain node)
// Engine checks: exact bounds, no modulo bias (rejection sampling), rough uniformity, dice / coin,
// the − / + steps, draws without replacement, and parsing of saved settings.
import assert from 'node:assert/strict';
import {
  LOW, HIGH, randInt, rollDice, flipCoin, stepValue, adjust, newPool, poolFor, poolLeft, poolTotal,
  drawFromPool, pipPositions, defaults, parseState, serialize
} from '../src/common/random.js';

const TWO32 = 4294967296;

// A seeded generator so failures can be reproduced (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO32;
  };
}
// Returns the given 32-bit values, in order, as rand() results.
function fixed(values) {
  let i = 0;
  return () => values[i++] / TWO32;
}

// ---- bounds ----
assert.equal(randInt(5, 5, Math.random), 5);
assert.equal(randInt(1, 100, fixed([0])), 1); // smallest input → min
assert.equal(randInt(0, 9999, fixed([0])), 0);
for (const [lo, hi] of [[1, 100], [0, 1], [1, 6], [0, 9999], [7, 8], [LOW, HIGH]]) {
  const range = hi - lo + 1;
  const limit = TWO32 - (TWO32 % range);
  // the largest accepted input maps to a value in range, the edge values map to both ends
  assert.equal(randInt(lo, hi, fixed([range - 1])), hi);
  assert.equal(randInt(lo, hi, fixed([limit - 1])), hi);
  // an input in the rejected tail is redrawn
  if (limit < TWO32) assert.equal(randInt(lo, hi, fixed([limit, 0])), lo);
  const r = seeded(lo * 31 + hi);
  let seenLo = false, seenHi = false;
  for (let i = 0; i < 20000; i++) {
    const v = randInt(lo, hi, r);
    assert.ok(Number.isInteger(v) && v >= lo && v <= hi, `${v} in [${lo}, ${hi}]`);
    if (v === lo) seenLo = true;
    if (v === hi) seenHi = true;
  }
  if (range <= 100) assert.ok(seenLo && seenHi, `both ends of [${lo}, ${hi}] drawn`);
}
// rand() returning exactly 1 (out of contract) still stays in range
{
  const v = randInt(1, 6, () => 1); // 2^32 - 1 is in the rejected tail; the retry cap still returns a value in range
  assert.ok(v >= 1 && v <= 6);
}

// ---- no modulo bias ----
// Range 3 over 2^32 inputs: 2^32 mod 3 = 1, so exactly one input (the top one) must be rejected,
// and every accepted input count per value must be equal. Check the mapping directly at the edges.
{
  const range = 3;
  const limit = TWO32 - (TWO32 % range);
  assert.equal(limit, TWO32 - 1);
  assert.equal(randInt(0, 2, fixed([TWO32 - 1, 2])), 2); // TWO32-1 rejected, next draw used
  assert.equal(randInt(0, 2, fixed([TWO32 - 2])), (TWO32 - 2) % 3);
}
// A range that does not divide 2^32 with a big remainder: 3 * 2^30 values. Plain modulo would make the
// lower third twice as likely; with rejection each third gets 1/3.
{
  const range = 3 * 2 ** 30; // > HIGH, only to expose bias in the method
  const r = seeded(7);
  const thirds = [0, 0, 0];
  const n = 60000;
  for (let i = 0; i < n; i++) thirds[Math.floor(randInt(0, range - 1, r) / 2 ** 30)]++;
  for (const c of thirds) assert.ok(Math.abs(c / n - 1 / 3) < 0.015, `third ${c / n}`);
}

// ---- rough uniformity (chi-square) ----
function chiSquare(counts, n) {
  const e = n / counts.length;
  return counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
}
{
  const r = seeded(42);
  const n = 100000;
  const c10 = new Array(10).fill(0);
  for (let i = 0; i < n; i++) c10[randInt(1, 10, r) - 1]++;
  assert.ok(chiSquare(c10, n) < 27.9, 'uniform 1..10, chi2 ' + chiSquare(c10, n)); // df 9, p = 0.001
  const c100 = new Array(100).fill(0);
  for (let i = 0; i < n; i++) c100[randInt(1, 100, r) - 1]++;
  assert.ok(chiSquare(c100, n) < 148.2, 'uniform 1..100, chi2 ' + chiSquare(c100, n)); // df 99, p = 0.001
  // with Math.random, the source the band uses
  const cm = new Array(6).fill(0);
  for (let i = 0; i < n; i++) cm[randInt(1, 6) - 1]++;
  assert.ok(chiSquare(cm, n) < 20.5, 'Math.random dice, chi2 ' + chiSquare(cm, n)); // df 5, p = 0.001
}

// ---- dice and coin ----
{
  const r = seeded(3);
  const sums = new Array(13).fill(0);
  const n = 72000;
  for (let i = 0; i < n; i++) {
    const d = rollDice(2, r);
    assert.equal(d.faces.length, 2);
    for (const f of d.faces) assert.ok(f >= 1 && f <= 6);
    assert.equal(d.sum, d.faces[0] + d.faces[1]);
    sums[d.sum]++;
  }
  // 7 is six times as likely as 2 or 12
  assert.ok(Math.abs(sums[7] / n - 6 / 36) < 0.01 && Math.abs(sums[2] / n - 1 / 36) < 0.005);
  assert.equal(rollDice(1, r).faces.length, 1);
  let heads = 0;
  for (let i = 0; i < 20000; i++) {
    const c = flipCoin(r);
    assert.ok(c === 'heads' || c === 'tails');
    if (c === 'heads') heads++;
  }
  assert.ok(Math.abs(heads / 20000 - 0.5) < 0.02);
}
for (let f = 1; f <= 6; f++) {
  const pips = pipPositions(f, 96, 18);
  assert.equal(pips.length, f);
  for (const p of pips) assert.ok(p.l >= 0 && p.t >= 0 && p.l + 18 <= 96 && p.t + 18 <= 96);
  assert.equal(new Set(pips.map((p) => p.l + ',' + p.t)).size, f); // no overlapping pips
}

// ---- − / + ----
assert.equal(stepValue(5, 1, false), 6);
assert.equal(stepValue(5, -1, false), 4);
assert.equal(stepValue(5, 1, true), 10);
assert.equal(stepValue(10, 1, true), 20);
assert.equal(stepValue(15, -1, true), 10);
assert.equal(stepValue(10, -1, true), 0);
assert.equal(stepValue(LOW, -1, false), LOW);
assert.equal(stepValue(HIGH, 1, true), HIGH);
assert.equal(stepValue(9995, 1, true), HIGH);
{
  const s = defaults();
  assert.deepEqual([s.min, s.max], [1, 100]);
  adjust(s, 'min', 1, false);
  assert.deepEqual([s.min, s.max], [2, 100]);
  adjust(s, 'max', -1, true);
  assert.deepEqual([s.min, s.max], [2, 90]);
  s.min = 50; s.max = 50;
  adjust(s, 'min', 1, false); // pushes max along
  assert.deepEqual([s.min, s.max], [51, 51]);
  adjust(s, 'max', -1, true); // pushes min down
  assert.deepEqual([s.min, s.max], [50, 50]);
}

// ---- draws without replacement ----
{
  const r = seeded(11);
  for (const [lo, hi] of [[1, 1], [1, 6], [1, 100], [0, 9], [9990, 9999]]) {
    const pool = newPool(lo, hi);
    const got = [];
    for (let i = 0; i < hi - lo + 1; i++) {
      assert.equal(poolLeft(pool), hi - lo + 1 - i);
      const v = drawFromPool(pool, r);
      assert.ok(v >= lo && v <= hi);
      got.push(v);
    }
    assert.equal(poolLeft(pool), 0);
    assert.equal(drawFromPool(pool, r), null); // exhausted
    assert.deepEqual([...got].sort((a, b) => a - b), Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
    assert.deepEqual(pool.drawn, got);
  }
  // each remaining number is equally likely: from 1..5 with 2 and 4 drawn, 1 / 3 / 5 each about 1/3
  const counts = { 1: 0, 3: 0, 5: 0 };
  for (let i = 0; i < 30000; i++) counts[drawFromPool({ min: 1, max: 5, drawn: [4, 2] }, r)]++;
  for (const k of [1, 3, 5]) assert.ok(Math.abs(counts[k] / 30000 - 1 / 3) < 0.015, `${k}: ${counts[k]}`);
  // the first position of a full shuffle is uniform
  const first = new Array(10).fill(0);
  for (let i = 0; i < 20000; i++) first[drawFromPool(newPool(0, 9), r)]++;
  assert.ok(chiSquare(first, 20000) < 27.9);
  // a range change starts a new pool; the same range keeps it
  const s = defaults();
  const p = poolFor(s);
  drawFromPool(p, r);
  assert.equal(poolFor(s), p);
  assert.equal(poolTotal(p), 100);
  adjust(s, 'max', 1, false);
  assert.notEqual(poolFor(s), p);
  assert.equal(poolLeft(poolFor(s)), 101);
}

// ---- saved settings ----
{
  const s = defaults();
  s.mode = 'dice';
  s.dice = 2;
  s.min = 3;
  s.max = 30;
  s.noRepeat = true;
  s.pool = { min: 3, max: 30, drawn: [7, 3, 30] };
  assert.deepEqual(parseState(serialize(s)), s);
  assert.deepEqual(parseState(''), defaults());
  assert.deepEqual(parseState('not json'), defaults());
  assert.deepEqual(parseState('null'), defaults());
  const bad = parseState(JSON.stringify({ mode: 'x', min: 50, max: 10, dice: 3, noRepeat: 'yes', pool: { min: 1, max: 10, drawn: [2, 2, 11, 1.5, 'a', 5] } }));
  assert.deepEqual(bad, { ...defaults(), pool: { min: 1, max: 10, drawn: [2, 5] } });
  assert.equal(parseState(JSON.stringify({ min: -1, max: 5 })).min, 1);
  assert.equal(parseState(JSON.stringify({ min: 0, max: 10000 })).max, 100);
}

console.log('ok random engine checks');
