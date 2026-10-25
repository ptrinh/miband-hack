// Multiple-choice quiz over a user deck (pure, no platform APIs) — MIT License.
//
// Adapted from SAT Flashcards' quiz.js: same question shape, scoring and storage format; the
// distractor rules are new because a user deck can be in any language and has no parts of speech.
//
// Two kinds of question, mixed at random:
//   'back'  shows the front, the user picks its back;
//   'front' shows the back, the user picks its front.
// Wrong choices are other cards of the same deck whose front AND back both differ from the
// answer's (otherwise a "wrong" choice could be right too, e.g. two words with the same meaning)
// and from the other choices'. Choices that look like the answer are preferred: the same kind of
// script (CJK or not) and a similar length, so the right one does not stand out by its shape.
//
// `lines` is the deck's card list (deck.js); `rand` returns a number in [0, 1) (Math.random on the
// band, a seeded generator in the tests).

import { entryAt, textWidth } from './deck.js';

export var CHOICES = 4;
export var MIN_CARDS = CHOICES; // fewer cards: the quiz is switched off for the deck

export function quizAvailable(count) {
  return count >= MIN_CARDS;
}

function norm(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasWide(s) {
  return textWidth(s) > s.length;
}

// Close enough in shape to be a convincing wrong answer.
function similar(a, b) {
  if (hasWide(a) !== hasWide(b)) return false;
  var wa = textWidth(a), wb = textWidth(b);
  return wa <= 2 * wb + 4 && wb <= 2 * wa + 4;
}

// Picks up to n wrong choices for card `answer`; `field` is 2 (backs are shown) or 1 (fronts).
//   pass 0: similar shape to the answer; pass 1: any card that is not also a right answer.
// Random probing keeps a question cheap on the band (no pass over the whole deck).
export function pickDistractors(lines, answer, n, rand, field) {
  var picked = [];
  var a = entryAt(lines, answer);
  var af = norm(a[1]), ab = norm(a[2]);
  var shown = [field === 1 ? af : ab];
  function ok(j, pass) {
    if (j === answer || picked.indexOf(j) >= 0) return false;
    var e = entryAt(lines, j);
    if (norm(e[1]) === af || norm(e[2]) === ab) return false;
    var text = norm(e[field]);
    if (shown.indexOf(text) >= 0) return false;
    if (pass === 0 && !similar(e[field], a[field])) return false;
    return true;
  }
  for (var pass = 0; pass < 2 && picked.length < n; pass++) {
    for (var t = 0; t < 60 && picked.length < n; t++) {
      var j = Math.floor(rand() * lines.length);
      if (ok(j, pass)) {
        picked.push(j);
        shown.push(norm(entryAt(lines, j)[field]));
      }
    }
    // Small or crowded decks: finish the pass with a scan from a random start.
    var start = Math.floor(rand() * lines.length);
    for (var s = 0; s < lines.length && picked.length < n; s++) {
      var x = (start + s) % lines.length;
      if (ok(x, pass)) {
        picked.push(x);
        shown.push(norm(entryAt(lines, x)[field]));
      }
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

// A question about card `answer`: { kind, answer, choices: [card indices], correct: position }.
// A deck whose cards mostly share a front or a back may yield fewer than four choices.
export function makeQuestion(lines, answer, rand, kind) {
  var k = kind || (rand() < 0.5 ? 'back' : 'front');
  var choices = pickDistractors(lines, answer, CHOICES - 1, rand, k === 'back' ? 2 : 1);
  choices.push(answer);
  shuffle(choices, rand);
  return { kind: k, answer: answer, choices: choices, correct: choices.indexOf(answer) };
}

// The text shown as the question: the front for 'back' questions, the back for 'front' ones.
export function promptText(lines, q) {
  return entryAt(lines, q.answer)[q.kind === 'back' ? 1 : 2];
}

// The text shown on choice k.
export function choiceText(lines, q, k) {
  return entryAt(lines, q.choices[k])[q.kind === 'back' ? 2 : 1];
}

export function isCorrect(q, k) {
  return k === q.correct;
}

// ---- score: unchanged from SAT Flashcards' quiz.js ----

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

// All-time totals for @system.storage: "answered:correct:best:streak".
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
