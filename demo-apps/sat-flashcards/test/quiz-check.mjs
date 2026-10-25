// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import { WORDS } from '../src/common/words.js';
import { entryAt, posAt } from '../src/common/deck.js';
import * as Q from '../src/common/quiz.js';

// Seeded generator so failures are reproducible.
function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

// stems: meaningful words only, cut to 5 letters
assert.deepEqual(Q.stems('to make less harmful or severe'), ['less', 'harmf', 'sever']);
assert.deepEqual(Q.stems('clever and skillful'), ['cleve', 'skill']);

const idx = (w) => WORDS.findIndex((l) => l.startsWith(w + '|'));
// near-synonyms and look-alikes are related, unrelated words are not
assert.ok(Q.related(WORDS, idx('obstinate'), idx('obdurate')));
assert.ok(Q.related(WORDS, idx('frugal'), idx('thrifty')));
assert.ok(Q.related(WORDS, idx('compel'), idx('compelling')));
assert.ok(Q.related(WORDS, idx('placate'), idx('pacify'))); // "to soothe; to pacify"
assert.ok(!Q.related(WORDS, idx('abate'), idx('zealous')));

// every word: valid, distinct choices, the answer exactly once, same part of speech, nothing related
const rand = rng(7);
const positions = [0, 0, 0, 0];
const kinds = { def: 0, word: 0 };
for (let i = 0; i < WORDS.length; i++) {
  const q = Q.makeQuestion(WORDS, i, rand);
  assert.equal(q.choices.length, Q.CHOICES, 'choices for ' + WORDS[i]);
  assert.equal(q.answer, i);
  assert.equal(q.choices[q.correct], i);
  assert.equal(q.choices.filter((c) => c === i).length, 1);
  assert.equal(new Set(q.choices).size, Q.CHOICES, 'duplicate choice for ' + WORDS[i]);
  const texts = q.choices.map((_, k) => Q.choiceText(WORDS, q, k));
  assert.equal(new Set(texts).size, Q.CHOICES, 'duplicate choice text for ' + WORDS[i]);
  assert.equal(texts[q.correct], entryAt(WORDS, i)[q.kind === 'def' ? 2 : 0]);
  assert.ok(Q.isCorrect(q, q.correct));
  for (let k = 0; k < Q.CHOICES; k++) {
    if (k === q.correct) continue;
    assert.ok(!Q.isCorrect(q, k));
    const j = q.choices[k];
    assert.ok(!Q.related(WORDS, i, j), WORDS[i] + ' got related distractor ' + WORDS[j]);
    // adverbs are too few to fill a question on their own; everything else stays in its part of speech
    if (posAt(WORDS, i) !== 'adv') assert.equal(posAt(WORDS, j), posAt(WORDS, i), 'pos of distractor for ' + WORDS[i]);
  }
  positions[q.correct]++;
  kinds[q.kind]++;
}
// the right answer lands in every position and both kinds of question come up, roughly evenly
const even = WORDS.length / Q.CHOICES;
for (const p of positions) assert.ok(p > even * 0.8 && p < even * 1.2, 'answer positions ' + positions);
assert.ok(kinds.def > WORDS.length * 0.4 && kinds.word > WORDS.length * 0.4, 'kinds ' + JSON.stringify(kinds));

// a fixed kind is honoured, and the order of the choices changes between questions
assert.equal(Q.makeQuestion(WORDS, 5, rand, 'word').kind, 'word');
const orders = new Set();
for (let t = 0; t < 20; t++) orders.add(Q.makeQuestion(WORDS, 5, rand).choices.join());
assert.ok(orders.size > 10);

// tiny lists: as many distinct choices as exist, never the answer, never two equal texts
const tiny = ['ant|n|an insect|An ant.', 'bee|n|an insect|A bee.', 'cat|n|a pet|A cat.'];
const tq = Q.makeQuestion(tiny, 0, rng(3), 'def');
assert.equal(tq.choices.length, 2);
assert.deepEqual([...tq.choices].sort(), [0, 2]);
assert.equal(Q.pickDistractors(['solo|n|alone|Solo.'], 0, 3, rng(1)).length, 0);

// shuffle keeps every element
assert.deepEqual(Q.shuffle([1, 2, 3, 4, 5], rng(9)).sort(), [1, 2, 3, 4, 5]);

// score: session counts, streak and best; accuracy
const s = Q.createScore();
assert.equal(Q.accuracy(s), -1);
for (const ok of [true, true, false, true, true, true, false]) Q.record(s, ok);
assert.deepEqual(s, { answered: 7, correct: 5, streak: 0, best: 3 });
assert.equal(Q.accuracy(s), 71);

// totals round-trip through storage; garbage is ignored
assert.deepEqual(Q.deserializeScore(Q.serializeScore(s)), s);
Q.record(s, true);
assert.deepEqual(Q.deserializeScore(Q.serializeScore(s)), s);
assert.deepEqual(Q.deserializeScore(undefined), Q.createScore());
assert.deepEqual(Q.deserializeScore('x:y'), Q.createScore());
assert.deepEqual(Q.deserializeScore('3:9:1:1'), Q.createScore()); // more correct than answered
assert.deepEqual(Q.deserializeScore('10:6:2'), { answered: 10, correct: 6, streak: 0, best: 2 });

console.log('ok quiz checks (' + WORDS.length + ' questions)');
