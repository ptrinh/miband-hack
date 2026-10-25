// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import { WORDS as LINES } from '../src/common/words.js';
import { keysOf, entryAt, posAt } from '../src/common/deck.js';
import * as S from '../src/common/srs.js';

const WORDS = keysOf(LINES);

// word list: enough words, unique, sorted, every field filled, short enough for the 192 px screen
assert.ok(LINES.length >= 1000, 'only ' + LINES.length + ' words');
const seen = new Set();
const defs = new Map();
for (let n = 0; n < LINES.length; n++) {
  const e = entryAt(LINES, n);
  assert.equal(e.length, 4, 'entry ' + LINES[n]);
  const [w, pos, def, ex] = e;
  assert.equal(WORDS[n], w);
  assert.equal(posAt(LINES, n), pos);
  assert.ok(n === 0 || WORDS[n - 1] < w, 'not sorted: ' + w);
  assert.equal(def.trim(), def, 'spaces in definition of ' + w);
  assert.ok(!defs.has(def), 'same definition for ' + w + ' and ' + defs.get(def));
  defs.set(def, w);
  assert.ok(/^[a-z][a-z-]*$/.test(w), 'word ' + w);
  assert.ok(!seen.has(w), 'duplicate ' + w);
  seen.add(w);
  assert.ok(['n', 'v', 'adj', 'adv'].includes(pos), 'pos of ' + w);
  assert.ok(w.length <= 14, 'word too long for one line: ' + w);
  assert.ok(def.length > 0 && def.length <= 40, 'definition too long: ' + w);
  assert.ok(ex.length > 0 && ex.length <= 42, 'example too long: ' + w);
  assert.ok(ex.toLowerCase().includes(w.slice(0, 4)), 'example does not use the word: ' + w);
}

// the words of version 1.0.0 are all still there, so saved progress keeps counting
const V1 = 'abate aberration abhor abridge abstain abstract abundant accolade acquiesce acrimony acute adamant adept adhere admonish adverse advocate aesthetic affable affluent aggregate alleviate aloof altruism ambiguous ambivalent ameliorate amiable anachronism analogous anecdote animosity anomaly antagonize antithesis apathy appease arbitrary arcane archaic ardent arduous articulate ascertain assert assiduous astute audacious augment austere authoritarian autonomous avarice banal belie belligerent benevolent bolster bombastic brevity burgeon cacophony callous candid capricious castigate catalyst caustic censure chronic circumspect circumvent clandestine coalesce coerce cogent cognizant coherent collaborate colloquial complacent comply concede concise concur condone conducive conformity conjecture conscientious consensus contemporary contempt contentious contrite conventional convoluted copious corroborate credible cryptic culpable cursory curtail cynical dearth debilitate decorum deference deleterious delineate demagogue denounce deplete deride derivative despondent deter detrimental devious didactic diffident digress diligent diminish discern disdain disparate disparity disseminate divergent dogmatic dubious eclectic efficacy egregious elated elicit eloquent elusive embellish empathy empirical emulate endorse enhance enigma ephemeral equivocal erratic erroneous erudite esoteric espouse euphemism exacerbate exemplary exhaustive exonerate expedient explicit extol extraneous fabricate facetious facilitate fallacy fastidious feasible fervent fickle flagrant flourish foster frugal futile garrulous gratuitous gregarious hackneyed haughty hedonist hegemony heresy hierarchy hinder homogeneous hostile hubris hypothesis iconoclast idiosyncrasy illicit immutable impartial impede imperative impetuous implicit impudent inadvertent incessant incisive incoherent incongruous indifferent indigenous indolent induce inept inevitable infamous ingenious inherent innate innocuous innovative insatiable insipid insolent integrity intrepid intricate intuitive inundate irony jeopardize judicious juxtapose laconic lament languid latent laudable lethargic levity lucid magnanimous malevolent malleable mandate meticulous mitigate mollify mundane munificent myriad naive nefarious negligent nonchalant nostalgia notorious novice nuance obdurate oblivious obscure obsolete obstinate ominous opaque opportunist optimist opulent ostentatious ostracize paradigm paradox paramount partisan paucity pedantic penchant perfunctory peripheral pernicious perpetuate pervasive philanthropy placate plausible polarize pragmatic precarious precedent precocious predecessor prevalent proficient profound prolific propensity prosaic provocative prudent quell querulous rancor ratify rebuke recalcitrant reciprocate reclusive redundant refute relegate relinquish reprehensible repudiate rescind resilient resolute reticent revere rhetoric rigorous sagacious salient sanction satire scrupulous scrutinize skeptical solace sporadic spurious squander stagnant staunch stoic strident subjective substantiate subtle succinct superfluous surreptitious sycophant synthesis tacit tangible temperate tenacious tentative tenuous terse tirade torpid transient trepidation trivial truculent ubiquitous undermine unprecedented unscrupulous vacillate validate venerate veracity verbose viable vigilant vindicate virtuous volatile voracious wane wary whimsical zealous'.split(' ');
assert.equal(V1.length, 372);
for (const w of V1) assert.ok(seen.has(w), 'word of v1 missing: ' + w);

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
assert.ok(S.isNew(st, WORDS[i]));

// known on first sight -> learned box, due in 3 days
assert.equal(S.answer(st, WORDS[i], true, today, ses), S.LEARNED_BOX);
assert.equal(st.cards[WORDS[i]].d, today + S.INTERVALS[S.LEARNED_BOX]);
assert.equal(S.nextCard(st, WORDS, order, today, ses), order[1]);

// "Again" comes back after AGAIN_GAP other cards, not immediately
const again = WORDS[order[1]];
S.answer(st, again, false, today, ses);
const shown = [];
for (let k = 0; k < S.AGAIN_GAP; k++) {
  const j = S.nextCard(st, WORDS, order, today, ses);
  shown.push(WORDS[j]);
  S.answer(st, WORDS[j], true, today, ses);
}
assert.ok(!shown.includes(again), 'again card shown too early: ' + shown);
assert.equal(WORDS[S.nextCard(st, WORDS, order, today, ses)], again);
S.answer(st, again, true, today, ses);
assert.equal(st.cards[again].b, 1);
assert.equal(st.cards[again].d, today + 1);

// due reviews come before new words; lowest box first
const tomorrow = today + 1;
ses = S.createSession();
assert.equal(WORDS[S.nextCard(st, WORDS, order, tomorrow, ses)], again);

// boxes cap at MAX_BOX
const w0 = WORDS[0];
for (let k = 0; k < 10; k++) S.answer(st, w0, true, today, ses);
assert.equal(st.cards[w0].b, S.MAX_BOX);

// the only remaining card is still offered even if it was just shown
let small = ['alpha', 'beta'];
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
  S.answer(st, WORDS[j], true, today, ses);
  assert.ok(++n <= WORDS.length, 'loop');
}
assert.equal(S.stats(st, WORDS, today).learned, WORDS.length);

// a progress string written by version 1.0.0 still loads and counts against the new list
const old = S.deserialize('abate:2:20003;zealous:0:20000;removedword:3:1');
const os = S.stats(old, WORDS, today);
assert.deepEqual([os.seen, os.learned, os.due], [2, 1, 1]);

assert.equal(S.partOfSpeech('adj'), 'adjective');
assert.equal(S.dayNumber(new Date(2026, 9, 25, 23, 59)), S.dayNumber(new Date(2026, 9, 25, 0, 1)));

console.log('ok srs checks (' + WORDS.length + ' words)');
