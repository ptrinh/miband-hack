// Run: npm test   (plain node)
// Loads the page script from index.ux with stubbed @system.storage, @system.vibrator and timers, drives it
// through its touch and click handlers, and checks what is shown, what buzzes and what is saved.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ux = readFileSync(join(root, 'src/pages/index/index.ux'), 'utf8');
const template = ux.match(/<template>([\s\S]*?)<\/template>/)[1];
const script = ux.match(/<script>([\s\S]*?)<\/script>/)[1];
const engine = pathToFileURL(join(root, 'src/common/counter.js')).href;
const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));

// every module the page imports is declared as a feature in the manifest
const imported = [...script.matchAll(/from '@(system\.[a-z]+)'/g)].map((m) => m[1]).sort();
assert.deepEqual(imported, ['system.storage', 'system.vibrator']);
assert.deepEqual(manifest.features.map((f) => f.name).sort(), imported);
assert.equal(manifest.config.designWidth, 192);

const dir = mkdtempSync(join(tmpdir(), 'counter-page-'));
try {
  writeFileSync(
    join(dir, 'page.mjs'),
    'var storage = globalThis.__storage;\nvar vibrator = globalThis.__vibrator;\n' +
      script
        .replace(/import storage from '@system\.storage'\n/, '')
        .replace(/import vibrator from '@system\.vibrator'\n/, '')
        .replace("'../../common/counter.js'", JSON.stringify(engine))
  );
  const saved = {};
  let sets = 0;
  globalThis.__storage = {
    get(o) { if (saved[o.key] !== undefined) o.success(saved[o.key]); else if (o.fail) o.fail(); },
    set(o) { saved[o.key] = o.value; sets++; }
  };
  const buzzes = [];
  globalThis.__vibrator = { vibrate(o) { buzzes.push(o.mode); } };
  let pending = null;
  globalThis.setTimeout = (fn) => { pending = fn; return 1; };
  globalThis.clearTimeout = () => { pending = null; };

  const { default: def } = await import(pathToFileURL(join(dir, 'page.mjs')).href);
  for (const m of template.matchAll(/on(?:click|touchstart|touchend|touchcancel)="([a-zA-Z]+)/g)) {
    assert.equal(typeof def[m[1]], 'function', 'missing handler ' + m[1]);
  }

  // Minimal VM: private data + methods on one object.
  function boot() {
    const vm = JSON.parse(JSON.stringify(def.private));
    for (const k of Object.keys(def)) if (typeof def[k] === 'function') vm[k] = def[k];
    // the page is 212 px wide on a Mi Band 10: touches arrive in device px
    vm.$element = () => ({ getBoundingClientRect: (o) => o.success({ left: 0, top: 0, width: 212, height: 520 }) });
    vm.onInit();
    vm.onShow();
    return vm;
  }
  const dev = (x) => (x * 212) / 192; // design px → device px
  const touch = (vm, x0, y0, x1 = x0, y1 = y0) => {
    vm.onStart({ touches: [{ clientX: dev(x0), clientY: dev(y0) }] });
    vm.onEnd({ changedTouches: [{ clientX: dev(x1), clientY: dev(y1) }] });
  };
  const stored = () => JSON.parse(saved['counter-v1']);

  let vm = boot();
  assert.equal(vm.view, 'main');
  assert.equal(vm.name, 'Counter 1');
  assert.equal(vm.count, 0);
  assert.equal(vm.line, 'Tap anywhere');

  // taps count, buzz short and save every time
  for (let i = 0; i < 5; i++) touch(vm, 96, 240);
  assert.equal(vm.count, 5);
  assert.deepEqual(buzzes, ['short', 'short', 'short', 'short', 'short']);
  assert.equal(sets, 5);
  assert.equal(stored().slots[0].count, 5);
  // swipes and the left-edge strip do not count
  touch(vm, 60, 240, 140, 240);
  touch(vm, 96, 300, 96, 200);
  touch(vm, 6, 240);
  vm.onStart({ touches: [{ clientX: dev(96), clientY: dev(240) }] });
  vm.onCancel();
  vm.onEnd({ changedTouches: [{ clientX: dev(96), clientY: dev(240) }] });
  assert.equal(vm.count, 5);
  assert.equal(buzzes.length, 5);

  // −1, and not below zero
  vm.minus();
  assert.equal(vm.count, 4);
  for (let i = 0; i < 6; i++) vm.minus();
  assert.equal(vm.count, 0);
  assert.equal(buzzes.length, 10); // only the five real steps buzzed
  assert.equal(stored().slots[0].count, 0);

  // goal picker: pick 10, long buzz on reaching it, tick shown
  vm.openGoals();
  assert.equal(vm.view, 'goals');
  assert.equal(vm.goals[0].cls, 'cell-cur'); // Off is current
  const ten = vm.goals.findIndex((g) => g.label === '10');
  vm.pickGoal(ten);
  assert.equal(vm.view, 'main');
  assert.equal(vm.ringClass, 'ring-on');
  assert.equal(vm.line, 'of 10');
  buzzes.length = 0;
  for (let i = 0; i < 10; i++) touch(vm, 96, 240);
  assert.deepEqual(buzzes, [...Array(9).fill('short'), 'long']);
  assert.equal(vm.line, '✓ 10');
  assert.equal(vm.doneClass, 'done-col');
  assert.equal(stored().slots[0].goal, 10);

  // reset needs a second tap; a timeout, a count, Back or leaving disarms it
  vm.resetTap();
  assert.equal(vm.resetLabel, 'Sure?');
  assert.equal(vm.count, 10);
  pending(); // 3 s pass
  assert.equal(vm.resetLabel, 'Reset');
  vm.resetTap();
  assert.equal(vm.onBackPress(), true); // Back cancels the armed reset, stays in the app
  assert.equal(vm.resetLabel, 'Reset');
  vm.resetTap();
  touch(vm, 96, 240); // counting disarms
  assert.equal(vm.count, 11);
  assert.equal(vm.resetLabel, 'Reset');
  vm.resetTap();
  vm.resetTap();
  assert.equal(vm.count, 0);
  assert.equal(vm.resetLabel, 'Reset');
  assert.equal(pending, null);
  assert.equal(stored().slots[0].count, 0);
  assert.equal(stored().slots[0].goal, 10); // reset keeps the goal

  // counters sheet: switch slot, rename, Back closes the sheet
  touch(vm, 96, 240);
  vm.openCounters();
  assert.equal(vm.view, 'counters');
  assert.deepEqual(vm.rows.map((r) => r.name), ['Counter 1', 'Counter 2', 'Counter 3', 'Counter 4']);
  assert.equal(vm.rows[0].cls, 'row-cur');
  assert.equal(vm.rows[0].count, 1);
  assert.equal(vm.onBackPress(), true);
  assert.equal(vm.view, 'main');
  vm.openCounters();
  vm.pickCounter(2);
  assert.equal(vm.view, 'main');
  assert.equal(vm.name, 'Counter 3');
  assert.equal(vm.count, 0);
  assert.equal(vm.ringClass, '');
  vm.openCounters();
  vm.renameCurrent();
  assert.equal(vm.view, 'counters');
  assert.equal(vm.name, 'Reps');
  assert.equal(vm.rows[2].name, 'Reps');
  vm.closeSheet();
  touch(vm, 96, 240);
  touch(vm, 96, 240);
  assert.equal(vm.onBackPress(), false); // Back on the main view leaves the app

  // everything comes back on the next launch
  vm = boot();
  assert.equal(vm.name, 'Reps');
  assert.equal(vm.count, 2);
  vm.openCounters();
  assert.deepEqual(vm.rows.map((r) => [r.name, r.count]), [['Counter 1', 1], ['Counter 2', 0], ['Reps', 2], ['Counter 4', 0]]);

  // taps before storage has answered are ignored (they would be overwritten by the load)
  const realGet = globalThis.__storage.get;
  let later = null;
  globalThis.__storage.get = (o) => { later = () => realGet(o); };
  vm = boot();
  touch(vm, 96, 240);
  vm.minus();
  later();
  assert.equal(vm.count, 2);
  globalThis.__storage.get = realGet;

  // corrupt storage starts fresh instead of crashing
  saved['counter-v1'] = '{not json';
  vm = boot();
  assert.equal(vm.name, 'Counter 1');
  assert.equal(vm.count, 0);

  // a vibrator that throws does not stop counting
  globalThis.__vibrator = { vibrate() { throw new Error('unsupported'); } };
  touch(vm, 96, 240);
  assert.equal(vm.count, 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok counter page checks');
