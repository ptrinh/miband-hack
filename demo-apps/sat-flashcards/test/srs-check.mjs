// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import { WORDS } from '../src/common/words.js';
import * as S from '../src/common/srs.js';

// word list: enough words, unique, every field filled, short enough for the 192 px screen
assert.ok(WORDS.length >= 300, 'only ' + WORDS.length + ' words');
const seen = new Set();
for (const e of WORDS) {
  assert.equal(e.length, 4, 'entry ' + e[0]);
  const [w, pos, def, ex] = e;
  assert.ok(/^[a-z][a-z-]*$/.test(w), 'word ' + w);
  assert.ok(!seen.has(w), 'duplicate ' + w);
  seen.add(w);
  assert.ok(['n', 'v', 'adj', 'adv'].includes(pos), 'pos of ' + w);
  assert.ok(w.length <= 14, 'word too long for one line: ' + w);
  assert.ok(def.length > 0 && def.length <= 40, 'definition too long: ' + w);
  assert.ok(ex.length > 0 && ex.length <= 42, 'example too long: ' + w);
}

// new-word order is a fixed permutation
const order = S.newOrder(WORDS.length);
assert.deepEqual([...order].sort((a, b) => a - b), WORDS.map((_, i) => i));
assert.deepEqual(S.newOrder(WORDS.length), order);
assert.notDeepEqual(order.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

// a fresh state starts with the first word of the order
const today = 20000;
let st = S.createState();
let ses = S.createSession();
let i = S.nextCard(st, WORDS, order, today, ses);
assert.equal(i, order[0]);
assert.ok(S.isNew(st, WORDS[i][0]));

// known on first sight -> learned box, due in 3 days
assert.equal(S.answer(st, WORDS[i][0], true, today, ses), S.LEARNED_BOX);
assert.equal(st.cards[WORDS[i][0]].d, today + S.INTERVALS[S.LEARNED_BOX]);
assert.equal(S.nextCard(st, WORDS, order, today, ses), order[1]);

// "Again" comes back after AGAIN_GAP other cards, not immediately
const again = WORDS[order[1]][0];
S.answer(st, again, false, today, ses);
const shown = [];
for (let k = 0; k < S.AGAIN_GAP; k++) {
  const j = S.nextCard(st, WORDS, order, today, ses);
  shown.push(WORDS[j][0]);
  S.answer(st, WORDS[j][0], true, today, ses);
}
assert.ok(!shown.includes(again), 'again card shown too early: ' + shown);
assert.equal(WORDS[S.nextCard(st, WORDS, order, today, ses)][0], again);
S.answer(st, again, true, today, ses);
assert.equal(st.cards[again].b, 1);
assert.equal(st.cards[again].d, today + 1);

// due reviews come before new words; lowest box first
const tomorrow = today + 1;
ses = S.createSession();
assert.equal(WORDS[S.nextCard(st, WORDS, order, tomorrow, ses)][0], again);

// boxes cap at MAX_BOX
const w0 = WORDS[0][0];
for (let k = 0; k < 10; k++) S.answer(st, w0, true, today, ses);
assert.equal(st.cards[w0].b, S.MAX_BOX);

// the only remaining card is still offered even if it was just shown
let small = [['alpha', 'n', 'a', 'a.'], ['beta', 'n', 'b', 'b.']];
st = S.createState();
ses = S.createSession();
S.answer(st, 'alpha', true, today, ses);
S.answer(st, 'beta', false, today, ses);
assert.equal(S.nextCard(st, small, S.newOrder(2), today, ses), 1);
S.answer(st, 'beta', true, today, ses);
// all seen, nothing due -> done
assert.equal(S.nextCard(st, small, S.newOrder(2), today, ses), -1);
assert.equal(S.nextCard(st, small, S.newOrder(2), today + 30, S.createSession()) >= 0, true);

// stats
const s = S.stats(st, small, today);
assert.deepEqual([s.total, s.seen, s.learned, s.due, s.mastered], [2, 2, 1, 0, 0]);
assert.deepEqual(s.boxes, [0, 1, 1, 0, 0, 0]);

// serialize round-trip; garbage and removed words are tolerated
st.cards.removed = { b: 3, d: 5 };
const text = S.serialize(st);
assert.deepEqual(S.deserialize(text).cards, st.cards);
assert.equal(S.stats(S.deserialize(text), small, today).seen, 2);
assert.deepEqual(S.deserialize('x:9:1;y:1.5:2;:1:1;junk;z:2:abc;ok:2:7').cards, { ok: { b: 2, d: 7 } });
assert.deepEqual(S.deserialize(undefined).cards, {});

// a full pass through every word ends with everything seen
st = S.createState();
ses = S.createSession();
let n = 0;
for (;;) {
  const j = S.nextCard(st, WORDS, order, today, ses);
  if (j < 0) break;
  S.answer(st, WORDS[j][0], true, today, ses);
  assert.ok(++n <= WORDS.length, 'loop');
}
assert.equal(S.stats(st, WORDS, today).learned, WORDS.length);

assert.equal(S.partOfSpeech('adj'), 'adjective');
assert.equal(S.dayNumber(new Date(2026, 9, 25, 23, 59)), S.dayNumber(new Date(2026, 9, 25, 0, 1)));

console.log('ok srs checks (' + WORDS.length + ' words)');
