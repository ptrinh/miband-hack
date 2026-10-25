// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import * as Q from '../src/common/quiz.js';
import { entryAt } from '../src/common/deck.js';

// Seeded generator so failures are reproducible.
function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}
const card = (id, front, back, note) => [id, front, back, note].filter((x) => x !== undefined).join('\t');

assert.equal(Q.quizAvailable(3), false);
assert.equal(Q.quizAvailable(4), true);

// a mixed deck: Latin, Vietnamese, CJK, a synonym pair (same back) and a homograph pair (same front)
const DECK = [
  card('a', 'France', 'Paris'),
  card('b', 'Japan', 'Tokyo'),
  card('c', 'Việt Nam', 'Hà Nội'),
  card('d', '中国', '北京'),
  card('e', '日本', '东京'),
  card('f', 'big', 'large'),
  card('g', 'huge', 'large'),
  card('h', 'bank', 'river side'),
  card('i', 'bank', 'money place'),
  card('j', 'Egypt', 'Cairo'),
  card('k', 'Canada', 'Ottawa'),
  card('l', 'Brazil', 'Brasília'),
];

const rand = rng(11);
const positions = [0, 0, 0, 0];
const kinds = { back: 0, front: 0 };
for (let round = 0; round < 40; round++) {
  for (let i = 0; i < DECK.length; i++) {
    const q = Q.makeQuestion(DECK, i, rand);
    kinds[q.kind]++;
    assert.equal(q.choices.length, 4, 'four choices for ' + DECK[i]);
    assert.equal(q.choices.filter((c) => c === i).length, 1);
    assert.equal(q.choices[q.correct], i);
    positions[q.correct]++;
    const a = entryAt(DECK, i);
    const texts = q.choices.map((_, k) => Q.choiceText(DECK, q, k).toLowerCase());
    assert.equal(new Set(texts).size, 4, 'repeated choice text');
    assert.equal(Q.promptText(DECK, q), q.kind === 'back' ? a[1] : a[2]);
    for (const j of q.choices) {
      if (j === i) continue;
      const e = entryAt(DECK, j);
      // a wrong choice must not be right too: different front and different back
      assert.notEqual(e[1].toLowerCase(), a[1].toLowerCase(), 'same front offered as wrong: ' + a[1]);
      assert.notEqual(e[2].toLowerCase(), a[2].toLowerCase(), 'same back offered as wrong: ' + a[2]);
    }
  }
}
assert.ok(kinds.back > 100 && kinds.front > 100, 'both kinds of question');
for (const p of positions) assert.ok(p > 60, 'answer position is shuffled: ' + positions);

// prefers choices of the same script: a CJK answer gets CJK choices when the deck has enough
const cjk = [card('1', '中国', '北京'), card('2', '日本', '东京'), card('3', '韩国', '首尔'), card('4', '泰国', '曼谷'),
  card('5', 'France', 'Paris'), card('6', 'Spain', 'Madrid'), card('7', 'Italy', 'Rome'), card('8', 'Peru', 'Lima')];
for (let n = 0; n < 50; n++) {
  const q = Q.makeQuestion(cjk, 0, rand, 'back');
  for (const j of q.choices) assert.ok(j < 4, 'non-CJK choice for a CJK answer');
}

// exactly four cards: always the other three; question kinds forced
const four = DECK.slice(0, 4);
const q4 = Q.makeQuestion(four, 2, rand, 'front');
assert.equal(q4.kind, 'front');
assert.deepEqual([...q4.choices].sort(), [0, 1, 2, 3]);

// a deck where everything shares a back: fewer choices, never a wrong "right" answer
const same = [card('x', 'big', 'large'), card('y', 'huge', 'large'), card('z', 'vast', 'large'), card('w', 'tiny', 'small')];
const qs = Q.makeQuestion(same, 0, rand, 'back');
assert.deepEqual([...qs.choices].sort(), [0, 3]);

// score: unchanged from SAT Flashcards
const sc = Q.createScore();
Q.record(sc, true);
Q.record(sc, true);
Q.record(sc, false);
assert.equal(Q.accuracy(sc), 67);
assert.deepEqual(Q.deserializeScore(Q.serializeScore(sc)), sc);
assert.equal(Q.accuracy(Q.createScore()), -1);
assert.deepEqual(Q.deserializeScore('3:9:1:1'), Q.createScore());

console.log('quiz checks passed');
