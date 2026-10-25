// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import * as M from '../src/common/metronome.js';

// ---- limits and steps ----
assert.equal(M.clampBpm(10), 30);
assert.equal(M.clampBpm(999), 250);
assert.equal(M.clampBpm(119.6), 120);
assert.equal(M.clampBpm('abc'), M.DEFAULT_BPM);
assert.equal(M.stepBpm(120, 1), 121);
assert.equal(M.stepBpm(120, -1), 119);
assert.equal(M.stepBpm(30, -1), 30);
assert.equal(M.stepBpm(250, 1), 250);
assert.equal(M.stepBpm(123, 5), 125);
assert.equal(M.stepBpm(125, 5), 130);
assert.equal(M.stepBpm(123, -5), 120);
assert.equal(M.stepBpm(120, -5), 115);
assert.equal(M.stepBpm(248, 5), 250);
assert.equal(M.stepBpm(32, -5), 30);
assert.equal(M.interval(120), 500);
assert.equal(M.interval(60), 1000);

// ---- signatures, accent, names ----
assert.deepEqual(M.SIGNATURES.map((s) => s.id + ':' + s.beats), ['2/4:2', '3/4:3', '4/4:4', '6/8:6']);
let id = '2/4';
const seen = [];
for (let i = 0; i < 4; i++) { seen.push(id); id = M.nextSignature(id); }
assert.equal(id, '2/4');
assert.deepEqual(seen, ['2/4', '3/4', '4/4', '6/8']);
assert.equal(M.nextSignature('7/8'), M.DEFAULT_SIGNATURE);
assert.equal(M.signature('nope').id, M.DEFAULT_SIGNATURE);
assert.equal(M.nextAccent('double'), 'long');
assert.equal(M.nextAccent('long'), 'double');
assert.equal(M.tempoName(30), 'Grave');
assert.equal(M.tempoName(90), 'Andante');
assert.equal(M.tempoName(120), 'Allegro');
assert.equal(M.tempoName(250), 'Prestissimo');

// ---- tap tempo ----
{
  const t = M.createTapper();
  assert.equal(M.tap(t, 1000), 0); // one tap: nothing yet
  assert.equal(M.tap(t, 1500), 120);
  assert.equal(M.tap(t, 2000), 120);
  // average of the last 4 intervals, not the last one alone
  assert.equal(M.tap(t, 2520), 118); // (2520-1000)/3 = 506.7 ms
  M.tap(t, 3010);
  M.tap(t, 3500);
  assert.equal(t.taps.length, M.TAP_KEEP);
  assert.equal(M.tap(t, 4000), 120); // last 5 taps 2000..4000: 500 ms on average
  // a pause longer than TAP_RESET starts over
  assert.equal(M.tap(t, 7000), 0);
  assert.equal(t.taps.length, 1);
  // a sudden tempo change measures from the previous tap instead of averaging with the old tempo
  M.tap(t, 7500); M.tap(t, 8000); M.tap(t, 8500);
  assert.equal(M.tap(t, 8750), 240); // 250 ms gap after 500 ms ones
  assert.equal(M.tap(t, 9000), 240);
  // limits
  const fast = M.createTapper();
  M.tap(fast, 0);
  assert.equal(M.tap(fast, 100), 250);
  const slow = M.createTapper();
  M.tap(slow, 0);
  assert.equal(M.tap(slow, 1990), 30);
}

// ---- beat clock: no drift with late timers ----
{
  // timers fire up to 40 ms late at random; beats must stay on the grid, not accumulate lateness
  let seed = 3;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const c = M.createClock(120, 4, 0);
  let now = 0;
  const fired = [];
  for (let i = 0; i < 2000; i++) {
    const r = M.advance(c, now);
    if (r.fire) fired.push({ at: now, index: r.index, accent: r.accent });
    now += r.delay + rand() * 40;
  }
  assert.ok(fired.length > 1500);
  for (let i = 0; i < fired.length; i++) {
    const err = fired[i].at - i * 500;
    assert.ok(err >= 0 && err <= 41, 'beat ' + i + ' off grid by ' + err);
    assert.equal(fired[i].index, i % 4);
    assert.equal(fired[i].accent, i % 4 === 0);
  }
}
{
  // a naive setTimeout(interval) loop with the same lateness would drift by ~20 ms per beat
  let now = 0;
  for (let i = 0; i < 100; i++) now += 500 + 20;
  assert.ok(now - 100 * 500 > 1000);
}
{
  // early timer: no beat, wait the rest
  const c = M.createClock(60, 4, 0);
  assert.equal(M.advance(c, 0).fire, true);
  const r = M.advance(c, 600);
  assert.equal(r.fire, false);
  assert.equal(r.delay, 400);
  assert.equal(M.advance(c, 1000).fire, true);
}
{
  // stall (screen work, GC): beats missed by more than half an interval are skipped, no burst
  const c = M.createClock(120, 4, 0);
  M.advance(c, 0); // beat 0
  const r = M.advance(c, 1800); // beats at 500, 1000, 1500 missed
  assert.equal(r.fire, false);
  assert.equal(r.delay, 200); // next grid beat at 2000
  const r2 = M.advance(c, 2000);
  assert.equal(r2.fire, true);
  assert.equal(r2.index, 1); // the bar position counts fired beats
  // slightly late (under half an interval) still fires
  const r3 = M.advance(c, 2700);
  assert.equal(r3.fire, true);
  assert.equal(r3.delay, 300);
}
{
  // retempo: next beat one new interval after the last beat
  const c = M.createClock(60, 4, 0);
  M.advance(c, 0);
  assert.equal(M.retempo(c, 120, 200), 300); // last beat 0, new interval 500
  assert.equal(M.advance(c, 500).fire, true);
  assert.equal(M.advance(c, 1000).fire, true);
  // retempo much faster after a long wait: next beat now, not in the past
  const c2 = M.createClock(30, 4, 0);
  M.advance(c2, 0);
  assert.equal(M.retempo(c2, 240, 1500), 0);
  const r = M.advance(c2, 1500);
  assert.equal(r.fire, true);
  assert.equal(r.delay, 250);
}
{
  // time signature change while running: next beat is the downbeat
  const c = M.createClock(120, 4, 0);
  M.advance(c, 0);
  M.advance(c, 500);
  M.setBeats(c, 3);
  const r = M.advance(c, 1000);
  assert.equal(r.index, 0);
  assert.equal(r.accent, true);
  assert.equal(M.advance(c, 1500).index, 1);
  assert.equal(M.advance(c, 2000).index, 2);
  assert.equal(M.advance(c, 2500).index, 0);
}
{
  // 6/8: six beats per bar, accent on 1 only
  const c = M.createClock(180, 6, 0);
  const acc = [];
  let now = 0;
  for (let i = 0; i < 12; i++) { const r = M.advance(c, now); acc.push(r.accent); now += r.delay; }
  assert.deepEqual(acc, [true, false, false, false, false, false, true, false, false, false, false, false]);
}

// ---- vibration pattern ----
assert.deepEqual(M.pulses(false, 'double', 500), [{ at: 0, mode: 'short' }]);
assert.deepEqual(M.pulses(false, 'long', 500), [{ at: 0, mode: 'short' }]);
assert.deepEqual(M.pulses(true, 'long', 500), [{ at: 0, mode: 'long' }]);
assert.deepEqual(M.pulses(true, 'double', 500), [{ at: 0, mode: 'short' }, { at: 110, mode: 'short' }]);
// the second pulse always lands well before the next beat, even at 250 BPM
for (let bpm = M.MIN_BPM; bpm <= M.MAX_BPM; bpm++) {
  const p = M.pulses(true, 'double', M.interval(bpm));
  assert.ok(p[1].at <= M.interval(bpm) * 0.4 && p[1].at >= 90, 'gap at ' + bpm);
}

// ---- saved settings ----
assert.deepEqual(M.parseSettings(M.serializeSettings({ bpm: 96, sig: '6/8', accent: 'long' })), { bpm: 96, sig: '6/8', accent: 'long' });
const def = { bpm: M.DEFAULT_BPM, sig: M.DEFAULT_SIGNATURE, accent: M.DEFAULT_ACCENT };
assert.deepEqual(M.parseSettings(''), def);
assert.deepEqual(M.parseSettings('null'), def);
assert.deepEqual(M.parseSettings('{"bpm":"x","sig":"9/9","accent":"loud"}'), def);
assert.deepEqual(M.parseSettings('{"bpm":900}'), { ...def, bpm: 250 });

console.log('ok metronome checks');
