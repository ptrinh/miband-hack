// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import * as S from '../src/common/sketch.js';

let sk = S.createSketch();
S.beginStroke(sk, 10, 10, 8, S.COLORS[0]);
S.extendStroke(sk, 110, 10, 8, S.COLORS[0]);
S.endStroke(sk);
const n1 = sk.dots.length;
assert.ok(n1 >= 25 && n1 <= 40, 'continuous line, got ' + n1);
// consecutive dots overlap (gap < radius)
for (let i = 1; i < n1; i++) assert.ok(Math.abs(sk.dots[i].x - sk.dots[i - 1].x) <= 4);
// tiny moves add nothing
assert.equal(S.extendStroke(sk, 110.5, 10, 8, S.COLORS[0]).length, 1); // new stroke start (last was reset)
S.endStroke(sk);
// redrawing the same line dedupes
S.beginStroke(sk, 10, 10, 8, S.COLORS[0]);
S.extendStroke(sk, 110, 10, 8, S.COLORS[0]);
S.endStroke(sk);
assert.ok(sk.dots.length <= n1 + 2, 'dedupe');
// undo removes last stroke only
S.beginStroke(sk, 10, 100, 4, S.COLORS[1]);
S.extendStroke(sk, 10, 150, 4, S.COLORS[1]);
S.endStroke(sk);
const before = sk.dots.length;
assert.ok(S.undo(sk));
assert.ok(sk.dots.length < before && sk.dots.every((d) => d.c === S.COLORS[0]));
// eraser
const removed = S.eraseStroke(sk, 60, 10, 10);
S.endStroke(sk);
assert.ok(removed > 0 && sk.dots.every((d) => Math.abs(d.x + d.s / 2 - 60) > 10));
// serialize round-trip
const text = S.serialize(sk);
const sk2 = S.deserialize(text);
assert.equal(sk2.dots.length, sk.dots.length);
assert.deepEqual(sk2.dots.map((d) => [d.x, d.y, d.s, d.c]), sk.dots.map((d) => [d.x, d.y, d.s, d.c]));
assert.equal(S.deserialize('garbage;1,2;3,4,99,0,1').dots.length, 0);
// cap
let big = S.createSketch();
for (let row = 0; row < 200 && !big.full; row++) {
  S.beginStroke(big, 0, row * 2, 4, S.COLORS[2]);
  S.extendStroke(big, 190, row * 2, 4, S.COLORS[2]);
  S.endStroke(big);
}
assert.equal(big.dots.length, S.MAX_DOTS);
assert.ok(big.full);
S.clear(big);
assert.equal(big.dots.length, 0);
console.log('ok sketch engine checks');
