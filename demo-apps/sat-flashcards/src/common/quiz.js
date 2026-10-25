// Multiple-choice quiz (pure, no platform APIs) — MIT License.
//
// Two kinds of question, mixed at random:
//   'def'  shows a word, the user picks its definition;
//   'word' shows a definition, the user picks the word.
// Wrong choices are other words of the same part of speech (so the grammar of a definition gives
// nothing away) whose definitions share no key word with the answer's, so a near-synonym is never
// offered as a "wrong" answer. The page grades the answer with the Leitner scheduler (srs.js), so
// the quiz and the flashcards share progress.
//
// `lines` is the word list of words.js; `rand` returns a number in [0, 1) (Math.random on the band,
// a seeded generator in the tests).

import { entryAt, posAt } from './deck.js';

export var CHOICES = 4;

// Words that carry no meaning of their own when comparing two definitions.
var STOP = {};
('the and for with not from that this into out off one who someone something very too its his her ' +
  'their your own all any being having than what but way often others other about much make made ' +
  'are was has can may way also each some such kind sort').split(' ').forEach(function (w) { STOP[w] = 1; });

// Five-letter stems of the meaningful words of a text ("skillful" and "skilled" both give "skill").
export function stems(text) {
  var out = [];
  var parts = text.toLowerCase().split(/[^a-z]+/);
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p.length < 3 || STOP[p]) continue;
    out.push(p.slice(0, 5));
  }
  return out;
}

function shares(a, b) {
  for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) return true;
  return false;
}

// True when entries i and j are too close to be told apart in a quiz: their definitions share a
// key word, one word appears in the other's definition, or the two words look alike
// ("compel" / "compelling").
export function related(lines, i, j) {
  if (i === j) return true;
  var a = entryAt(lines, i), b = entryAt(lines, j);
  var da = stems(a[2]), db = stems(b[2]);
  if (shares(da, db)) return true;
  var ka = a[0].slice(0, 5), kb = b[0].slice(0, 5);
  if (ka === kb) return true;
  return da.indexOf(kb) >= 0 || db.indexOf(ka) >= 0;
}

// Picks up to n wrong choices for entry `answer`, best first:
//   1. same part of speech and not related to the answer or to each other;
//   2. any part of speech, still unrelated;
//   3. anything with a different word and definition (only for tiny lists).
// Random probing keeps a question cheap on the band (no pass over the whole list).
export function pickDistractors(lines, answer, n, rand) {
  var picked = [];
  var pos = posAt(lines, answer);
  var a = entryAt(lines, answer);
  function ok(j, pass) {
    if (j === answer || picked.indexOf(j) >= 0) return false;
    if (pass === 0 && posAt(lines, j) !== pos) return false;
    var e = entryAt(lines, j);
    if (e[0] === a[0] || e[2] === a[2]) return false;
    for (var k = 0; k < picked.length; k++) {
      var p = entryAt(lines, picked[k]);
      if (e[0] === p[0] || e[2] === p[2]) return false;
    }
    if (pass === 2) return true;
    if (related(lines, answer, j)) return false;
    for (var m = 0; m < picked.length; m++) if (related(lines, picked[m], j)) return false;
    return true;
  }
  for (var pass = 0; pass < 3 && picked.length < n; pass++) {
    for (var t = 0; t < 80 && picked.length < n; t++) {
      var j = Math.floor(rand() * lines.length);
      if (ok(j, pass)) picked.push(j);
    }
    // Small or crowded lists: finish the pass with a scan from a random start.
    var start = Math.floor(rand() * lines.length);
    for (var s = 0; s < lines.length && picked.length < n; s++) {
      var x = (start + s) % lines.length;
      if (ok(x, pass)) picked.push(x);
    }
  }
  return picked;
}

export function shuffle(list, rand) {
  for (var i = list.length - 1; i > 0; i--) {
    var k = Math.floor(rand() * (i + 1));
    var t = list[i];
    list[i] = list[k];
    list[k] = t;
  }
  return list;
}

// A question about entry `answer`: { kind, answer, choices: [entry indices], correct: position }.
export function makeQuestion(lines, answer, rand, kind) {
  var choices = pickDistractors(lines, answer, CHOICES - 1, rand);
  choices.push(answer);
  shuffle(choices, rand);
  return {
    kind: kind || (rand() < 0.5 ? 'def' : 'word'),
    answer: answer,
    choices: choices,
    correct: choices.indexOf(answer)
  };
}

// The text shown on choice k: a definition for 'def' questions, a word for 'word' questions.
export function choiceText(lines, q, k) {
  return entryAt(lines, q.choices[k])[q.kind === 'def' ? 2 : 0];
}

export function isCorrect(q, k) {
  return k === q.correct;
}

// Quiz score: for the session (shown in the header) and all-time totals (stats page).
export function createScore() {
  return { answered: 0, correct: 0, streak: 0, best: 0 };
}

export function record(score, correct) {
  score.answered++;
  if (correct) {
    score.correct++;
    score.streak++;
    if (score.streak > score.best) score.best = score.streak;
  } else {
    score.streak = 0;
  }
  return score;
}

// Percentage of correct answers, or -1 before the first answer.
export function accuracy(score) {
  return score.answered ? Math.round((100 * score.correct) / score.answered) : -1;
}

// All-time totals for @system.storage: "answered:correct:best:streak" (the running streak is
// kept so a best streak can span sessions).
export function serializeScore(score) {
  return score.answered + ':' + score.correct + ':' + score.best + ':' + score.streak;
}

export function deserializeScore(text) {
  var score = createScore();
  if (!text || typeof text !== 'string') return score;
  var f = text.split(':');
  var n = [];
  for (var i = 0; i < 4; i++) {
    var v = +f[i];
    n.push(v >= 0 && Math.floor(v) === v ? v : 0);
  }
  if (n[1] > n[0]) return score;
  score.answered = n[0];
  score.correct = n[1];
  score.best = n[2];
  score.streak = Math.min(n[3], n[1]);
  if (score.best < score.streak) score.best = score.streak;
  return score;
}
