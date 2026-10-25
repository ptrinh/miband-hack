// Run: npm test   (plain node)
// Loads the page script from index.ux with stubbed @system.vibrator / brightness / storage, a virtual clock and
// timers that fire late at random, then checks the vibrations, the lit dot, −/+ (tap and hold), tap tempo,
// stop on hide and that the settings are saved and restored.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ux = readFileSync(join(root, 'src/pages/index/index.ux'), 'utf8');
const script = ux.match(/<script>([\s\S]*?)<\/script>/)[1];
const engine = pathToFileURL(join(root, 'src/common/metronome.js')).href;

// every system module the page imports is declared in the manifest
const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
const imported = [...script.matchAll(/from '@(system\.\w+)'/g)].map((m) => m[1]).sort();
assert.deepEqual(manifest.features.map((f) => f.name).sort(), imported);

// ---- virtual time ----
let now = 1_000_000;
let seq = 0;
let timers = new Map(); // id -> { at, fn }
let lateness = () => 0;
globalThis.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0) + lateness(), fn }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
Date.now = () => now;
function runUntil(t) {
  for (;;) {
    let next = null;
    for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
    if (!next) break;
    timers.delete(next[0]);
    now = next[1].at;
    next[1].fn();
  }
  now = t;
}

const dir = mkdtempSync(join(tmpdir(), 'metronome-page-'));
try {
  writeFileSync(
    join(dir, 'page.mjs'),
    'var vibrator = globalThis.__vibrator, brightness = globalThis.__brightness, storage = globalThis.__storage;\n' +
      script
        .replace(/import (vibrator|brightness|storage) from '@system\.\w+'\n/g, '')
        .replace("'../../common/metronome.js'", JSON.stringify(engine))
  );
  const buzzes = [];
  let screenOn = null;
  const saved = {};
  globalThis.__vibrator = { vibrate(o) { buzzes.push({ at: now, mode: o.mode }); } };
  globalThis.__brightness = { setKeepScreenOn(o) { screenOn = o.keepScreenOn; } };
  globalThis.__storage = {
    get(o) { if (saved[o.key] !== undefined) o.success(saved[o.key]); else if (o.fail) o.fail(); },
    set(o) { saved[o.key] = o.value; }
  };
  const def = (await import(pathToFileURL(join(dir, 'page.mjs')).href)).default;
  const makeVm = () => {
    const vm = JSON.parse(JSON.stringify(def.private));
    for (const k of Object.keys(def)) if (typeof def[k] === 'function') vm[k] = def[k];
    vm.onInit();
    return vm;
  };
  const lit = (vm) => vm.dots.map((d, i) => (d.cls === 'dot-on' || d.cls === 'dot-accent' ? i : -1)).filter((i) => i >= 0);

  const vm = makeVm();
  assert.equal(vm.bpm, 120);
  assert.equal(vm.sig, '4/4');
  assert.equal(vm.dots.length, 4);
  assert.equal(vm.dots[0].cls, 'dot-first');

  // ---- run 4/4 at 120 with timers up to 30 ms late: on the grid, accent on 1 ----
  let seed = 11;
  lateness = () => ((seed = (seed * 48271) % 2147483647) / 2147483647) * 30;
  const t0 = now;
  vm.toggle();
  assert.equal(vm.running, true);
  assert.equal(screenOn, true);
  assert.deepEqual(lit(vm), [0]);
  assert.equal(vm.flash, 'flash-accent');
  runUntil(t0 + 20 * 500 + 100); // 21 beats
  const beats = buzzes.filter((b) => b.at - t0 < 20 * 500 + 100);
  const onBeat = beats.filter((b) => (b.at - t0) % 500 <= 31);
  const second = beats.filter((b) => (b.at - t0) % 500 > 31);
  assert.equal(onBeat.length, 21);
  onBeat.forEach((b, i) => {
    assert.ok(b.at - t0 >= i * 500 && b.at - t0 <= i * 500 + 31, 'beat ' + i + ' at ' + (b.at - t0));
    assert.equal(b.mode, 'short');
  });
  // double pulse on every downbeat, about 110 ms after the beat (beats 0..16: 5; beat 20's comes after the window)
  assert.equal(second.length, 5);
  for (const b of second) assert.ok(Math.floor((b.at - t0) / 500) % 4 === 0 && (b.at - t0) % 500 >= 110);
  assert.deepEqual(lit(vm), [0]); // beat 20 is a downbeat
  runUntil(now + 200);
  assert.equal(vm.flash, ''); // flash cleared between beats

  // ---- accent 'long' ----
  vm.cycleAccent();
  assert.equal(vm.accent, 'long');
  buzzes.length = 0;
  lateness = () => 0;
  runUntil(t0 + 24 * 500 + 10); // beats 21..24, 24 is a downbeat
  assert.deepEqual(buzzes.map((b) => b.mode), ['short', 'short', 'short', 'long']);

  // ---- − / +: tap = ±1, hold = steps of 5 that repeat, release adds nothing ----
  vm.plusDown(); vm.stepUp();
  assert.equal(vm.bpm, 121);
  vm.minusDown(); vm.stepUp();
  vm.minusDown(); vm.stepUp();
  assert.equal(vm.bpm, 119);
  vm.plusDown();
  runUntil(now + 450);
  assert.equal(vm.bpm, 120);
  runUntil(now + 220 * 2);
  assert.equal(vm.bpm, 130);
  vm.stepUp();
  assert.equal(vm.bpm, 130);
  runUntil(now + 1000);
  assert.equal(vm.bpm, 130); // no repeat after release
  vm.minusDown(); vm.stepCancel(); runUntil(now + 1000);
  assert.equal(vm.bpm, 130); // cancelled touch: nothing
  assert.equal(vm.name, 'Allegro');

  // tempo change while running keeps beats evenly spaced at the new tempo
  buzzes.length = 0;
  runUntil(now + 3000);
  const gaps = buzzes.filter((b) => b.mode === 'short' || b.mode === 'long').map((b) => b.at);
  const beatTimes = gaps.filter((t, i) => i === 0 || t - gaps[i - 1] > 200);
  assert.ok(beatTimes.length >= 5);
  for (let i = 2; i < beatTimes.length; i++) assert.ok(Math.abs(beatTimes[i] - beatTimes[i - 1] - 60000 / 130) <= 1);

  // ---- time signature while running: dots rebuilt, next beat is the downbeat ----
  vm.cycleSignature();
  assert.equal(vm.sig, '6/8');
  assert.equal(vm.dots.length, 6);
  assert.deepEqual(lit(vm), []);
  const next = [...timers.values()].reduce((a, b) => (a && a.at < b.at ? a : b));
  runUntil(next.at);
  assert.deepEqual(lit(vm), [0]);

  // ---- tap tempo while running ----
  vm.tapTempo();
  assert.equal(vm.tapLabel, 'Tap again');
  for (let i = 0; i < 4; i++) { runUntil(now + 400); vm.tapTempo(); }
  assert.equal(vm.bpm, 150);
  assert.equal(vm.tapLabel, 'Tap · 150');

  // ---- hide stops everything, screen may sleep, settings saved at once ----
  vm.onHide();
  assert.equal(vm.running, false);
  assert.equal(screenOn, false);
  assert.deepEqual(lit(vm), []);
  assert.equal(vm.flash, '');
  buzzes.length = 0;
  runUntil(now + 5000);
  assert.equal(buzzes.length, 0, 'no vibration after hide');
  assert.equal(timers.size, 0, 'no timers left');
  assert.deepEqual(JSON.parse(saved.metronome), { bpm: 150, sig: '6/8', accent: 'long' });

  // ---- restored on the next launch ----
  const vm2 = makeVm();
  assert.equal(vm2.bpm, 150);
  assert.equal(vm2.sig, '6/8');
  assert.equal(vm2.dots.length, 6);
  assert.equal(vm2.accent, 'long');
  assert.equal(vm2.name, 'Allegro');

  // ---- start / stop by button; changes while stopped are saved after a pause ----
  vm2.toggle();
  assert.equal(vm2.running, true);
  vm2.toggle();
  assert.equal(vm2.running, false);
  assert.equal(screenOn, false);
  vm2.plusDown(); vm2.stepUp();
  runUntil(now + 1000);
  assert.equal(JSON.parse(saved.metronome).bpm, 151);
  assert.equal(timers.size, 0);
  // limits hold through the buttons
  for (let i = 0; i < 300; i++) { vm2.plusDown(); vm2.stepUp(); }
  assert.equal(vm2.bpm, 250);
  vm2.onDestroy();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok metronome page checks');
