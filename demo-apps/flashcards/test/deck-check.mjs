// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as D from '../src/common/deck.js';
import * as S from '../src/common/srs.js';

// The sample deck bundled in the template (written by src/decks/model.ts bandFiles()).
const index = JSON.parse(readFileSync(new URL('../src/common/decks.json', import.meta.url), 'utf8'));
const deck0 = JSON.parse(readFileSync(new URL('../src/common/deck0.json', import.meta.url), 'utf8'));
const decks = D.cleanIndex(index);
assert.equal(decks.length, 1);
assert.equal(decks[0].file, '/common/deck0.json');
const LINES = D.cleanCards(deck0.cards);
assert.equal(LINES.length, decks[0].n);
assert.ok(LINES.length >= 4, 'sample deck must allow the quiz');

// cards: id, front, back, optional note
assert.deepEqual(D.entryAt(LINES, 0).slice(1), ['France', 'Paris', 'On the Seine']);
assert.deepEqual(D.entryAt(LINES, 6).slice(1), ['Canada', 'Ottawa', '']);
const KEYS = D.keysOf(LINES);
assert.equal(new Set(KEYS).size, KEYS.length);
for (const k of KEYS) assert.match(k, /^[a-z0-9]+$/);

// malformed cards and index entries are dropped, duplicate ids keep the first
assert.deepEqual(D.cleanCards(['a\tx\ty', 'b\tx', '\tx\ty', 7, 'a\tz\tw', 'c\tf\tb\tn']), ['a\tx\ty', 'c\tf\tb\tn']);
assert.deepEqual(D.cleanCards(null), []);
assert.deepEqual(D.cleanIndex({ decks: [{ id: 'x', file: '/f' }, { id: '', file: '/g' }, null, { id: 'y', name: 'Y', n: 3, file: '/h' }] }), [
  { id: 'x', name: 'Deck 1', n: 0, file: '/f' },
  { id: 'y', name: 'Y', n: 3, file: '/h' },
]);
assert.deepEqual(D.cleanIndex(undefined), []);

// display width: CJK and full-width count 2, Latin and Vietnamese 1, astral ideographs 2
assert.equal(D.textWidth('Paris'), 5);
assert.equal(D.textWidth('Hà Nội'), 6);
assert.equal(D.textWidth('北京'), 4);
assert.equal(D.textWidth('東京タワー'), 10);
assert.equal(D.textWidth('한국어'), 6);
assert.equal(D.textWidth('𠀀'), 2); // U+20000, a surrogate pair
assert.equal(D.textWidth('ＡＢ'), 4);
assert.equal(D.textWidth(''), 0);

// font size classes shrink with the width
assert.equal(D.sizeClass('front', 'Paris'), 'f-xl');
assert.equal(D.sizeClass('front', '北京大学'), 'f-xl'); // width 8
assert.equal(D.sizeClass('front', '中华人民共和国'), 'f-l'); // width 14
assert.equal(D.sizeClass('front', 'x'.repeat(60)), 'f-s');
assert.equal(D.sizeClass('front', '字'.repeat(60)), 'f-xs');
assert.equal(D.sizeClass('back', 'x'.repeat(24)), 'b-l');
assert.equal(D.sizeClass('back', 'x'.repeat(120)), 'b-s');
assert.equal(D.sizeClass('back', '字'.repeat(120)), 'b-xs');
assert.equal(D.sizeClass('choice', 'Ottawa'), 'c-l');
assert.equal(D.sizeClass('choice', '字'.repeat(40)), 'c-xs');

// summary for the deck list
const sum = D.parseSummary('capitals:3:8;bad;x:-1:2;other:0:500');
assert.deepEqual(sum, { capitals: { learned: 3, total: 8 }, other: { learned: 0, total: 500 } });
assert.deepEqual(D.parseSummary(D.serializeSummary(sum)), sum);
assert.deepEqual(D.parseSummary(''), {});

// the SAT scheduler works unchanged with card ids as keys and the deck's own order
const order = KEYS.map((_, i) => i);
const today = 20000;
const st = S.createState();
const ses = S.createSession();
assert.equal(S.nextCard(st, KEYS, order, today, ses), 0);
S.answer(st, KEYS[0], true, today, ses);
assert.equal(S.nextCard(st, KEYS, order, today, ses), 1);
S.answer(st, KEYS[1], false, today, ses);
assert.equal(S.nextCard(st, KEYS, order, today, ses), 2);
const restored = S.deserialize(S.serialize(st));
assert.deepEqual(restored, st);
// progress follows the id: a card moved elsewhere in an edited deck keeps its box,
// a card whose id is gone is simply not counted
const edited = [KEYS[3], KEYS[0], 'newcard'];
const s2 = S.stats(restored, edited, today);
assert.equal(s2.total, 3);
assert.equal(s2.seen, 1);
assert.equal(s2.learned, 1);

console.log('deck checks passed');
