// Run: npm test   (plain node)
// Loads the page script from index.ux with stubbed @system.storage, @system.vibrator and timers, and drives it
// through its handlers: rolls in each mode (with the 0.5 s animation), − / + taps and holds, no repeats until
// the pool is used up, Start over, and that settings and the pool survive a restart.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ux = readFileSync(join(root, 'src/pages/index/index.ux'), 'utf8');
const script = ux.match(/<script>([\s\S]*?)<\/script>/)[1];
const engine = pathToFileURL(join(root, 'src/common/random.js')).href;

// Every handler named in the template exists in the script.
const template = ux.match(/<template>([\s\S]*?)<\/template>/)[1];
const handlers = [...template.matchAll(/\son[a-z]+="([A-Za-z]+)"/g)].map((m) => m[1]);
assert.ok(handlers.length >= 10);

const dir = mkdtempSync(join(tmpdir(), 'random-page-'));
try {
  writeFileSync(
    join(dir, 'page.mjs'),
    'var storage = globalThis.__storage;\nvar vibrator = globalThis.__vibrator;\n' +
      script
        .replace(/import storage from '@system\.storage'\n/, '')
        .replace(/import vibrator from '@system\.vibrator'\n/, '')
        .replace("'../../common/random.js'", JSON.stringify(engine))
  );
  const saved = {};
  let writes = 0;
  globalThis.__storage = {
    get(o) { if (saved[o.key] !== undefined) o.success(saved[o.key]); else if (o.fail) o.fail(); },
    set(o) { saved[o.key] = o.value; writes++; }
  };
  let buzz = [];
  globalThis.__vibrator = { vibrate(o) { buzz.push(o.mode); } };
  const def = (await import(pathToFileURL(join(dir, 'page.mjs')).href)).default;
  for (const h of handlers) assert.equal(typeof def[h], 'function', 'handler ' + h);

  // Minimal VM: private data + methods on one object; timers run by hand.
  let timers = [];
  let nextId = 1;
  globalThis.setTimeout = (fn, ms) => { const t = { id: nextId++, fn, ms }; timers.push(t); return t.id; };
  globalThis.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
  const runTimer = () => {
    assert.equal(timers.length, 1, 'one pending timer');
    const t = timers.shift();
    t.fn();
    return t.ms;
  };
  const makeVm = () => {
    const vm = JSON.parse(JSON.stringify(def.private));
    for (const k of Object.keys(def)) if (typeof def[k] === 'function') vm[k] = def[k];
    vm.onInit();
    return vm;
  };
  // A full roll: tap, the animation frames, the landing.
  const roll = (vm) => {
    buzz = [];
    vm.roll();
    assert.equal(vm.rolling, true);
    let ms = 0, frames = 0;
    while (vm.rolling) { ms += runTimer(); frames++; }
    assert.equal(frames, 10);
    assert.equal(ms, 500);
    assert.deepEqual(buzz, ['short']); // one short buzz when the result lands
    assert.equal(timers.length, 0);
  };

  const vm = makeVm();
  assert.equal(vm.mode, 'number');
  assert.deepEqual([vm.min, vm.max, vm.big, vm.sub, vm.goLabel], [1, 100, '?', '1 – 100', 'Roll']);

  // number mode
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    roll(vm);
    const n = Number(vm.big);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 100);
    seen.add(n);
  }
  assert.ok(seen.size > 80);
  // a second tap while rolling is ignored
  vm.roll();
  vm.roll();
  vm.minUp();
  vm.chooseCoin();
  assert.deepEqual([vm.min, vm.mode], [1, 'number']);
  while (vm.rolling) runTimer();

  // − / +: tap = 1, hold = steps of 10 after 450 ms, one save per press
  vm.minUp(); vm.release();
  assert.equal(vm.min, 2);
  assert.equal(timers.length, 0);
  let before = writes;
  vm.maxDown();
  assert.equal(vm.max, 99);
  assert.equal(runTimer(), 450);
  assert.equal(vm.max, 90);
  assert.equal(runTimer(), 180);
  assert.equal(vm.max, 80);
  vm.release();
  assert.equal(timers.length, 0);
  assert.equal(writes, before + 1);
  vm.maxDown(); vm.release(); // 79
  assert.equal(vm.sub, '2 – 79');
  // max pushed below min drags min along, never below 0
  vm.minDown();
  for (let i = 0; i < 20; i++) runTimer();
  vm.release();
  assert.equal(vm.min, 0);
  vm.maxDown();
  for (let i = 0; i < 20; i++) runTimer();
  vm.onHide(); // hiding stops a hold
  assert.equal(timers.length, 0);
  assert.deepEqual([vm.min, vm.max], [0, 0]);
  roll(vm);
  assert.equal(vm.big, '0');
  // a long hold stops by itself
  vm.maxUp();
  while (timers.length) runTimer();
  assert.equal(vm.max, 1200);
  assert.equal(vm.bigSize, 'n3');
  vm.release();
  roll(vm);
  assert.ok(Number(vm.big) <= 1200);
  assert.equal(vm.bigSize, vm.big.length > 3 ? 'n4' : 'n3');

  // no repeats over 3..7
  vm.st.min = 3; vm.st.max = 7; vm.render();
  vm.toggleNoRepeat();
  assert.equal(vm.noRepeat, true);
  assert.equal(vm.sub, '5 of 5 left');
  const drawn = [];
  for (let i = 0; i < 5; i++) {
    roll(vm);
    drawn.push(Number(vm.big));
    assert.equal(vm.sub, i < 4 ? `${4 - i} of 5 left` : 'All 5 drawn');
  }
  assert.deepEqual(drawn.sort(), [3, 4, 5, 6, 7]);
  assert.equal(vm.exhausted, true);
  assert.equal(vm.goLabel, 'Start over');
  assert.deepEqual(JSON.parse(saved['random-state']).pool.drawn.length, 5);
  // Start over: a tap refills the pool, no animation, no buzz
  buzz = [];
  vm.roll();
  assert.equal(vm.rolling, false);
  assert.equal(timers.length, 0);
  assert.deepEqual(buzz, []);
  assert.equal(vm.sub, '5 of 5 left');
  assert.equal(vm.goLabel, 'Roll');
  roll(vm);
  roll(vm);
  assert.equal(vm.sub, '3 of 5 left');
  // Reset button
  vm.resetPool();
  assert.equal(vm.sub, '5 of 5 left');
  assert.equal(vm.big, '?');
  roll(vm);
  const kept = JSON.parse(saved['random-state']).pool.drawn;
  assert.equal(kept.length, 1);

  // dice
  vm.chooseDice();
  assert.equal(vm.mode, 'dice');
  assert.equal(vm.goLabel, 'Roll');
  assert.equal(vm.dieFaces.length, 1);
  roll(vm);
  let face = Number(vm.sub.replace('You rolled ', ''));
  assert.ok(face >= 1 && face <= 6);
  assert.equal(vm.dieFaces[0].length, face); // pips drawn = face
  vm.twoDice();
  assert.equal(vm.dieSize, 'two');
  assert.equal(vm.dieFaces.length, 2);
  for (let i = 0; i < 50; i++) {
    roll(vm);
    const m = vm.sub.match(/^(\d) \+ (\d) = (\d+)$/);
    assert.ok(m, vm.sub);
    assert.equal(+m[1] + +m[2], +m[3]);
    assert.deepEqual(vm.dieFaces.map((d) => d.length), [+m[1], +m[2]]);
  }

  // coin
  vm.chooseCoin();
  assert.deepEqual([vm.goLabel, vm.coinFace, vm.sub], ['Flip', '?', 'Tap Flip']);
  let heads = 0;
  for (let i = 0; i < 40; i++) {
    roll(vm);
    assert.ok(vm.sub === 'Heads' || vm.sub === 'Tails');
    assert.equal(vm.coinFace, vm.sub[0]);
    if (vm.sub === 'Heads') heads++;
  }
  assert.equal(vm.tally, `Heads ${heads} · Tails ${40 - heads}`);

  // switching back shows the last number again and its pool count
  vm.chooseNumber();
  assert.equal(vm.big, String(kept[0]));
  assert.equal(vm.sub, '4 of 5 left');

  // settings and the pool are restored on the next launch
  vm.chooseDice();
  const vm2 = makeVm();
  assert.deepEqual([vm2.mode, vm2.dice, vm2.st.min, vm2.st.max, vm2.st.noRepeat], ['dice', 2, 3, 7, true]);
  assert.deepEqual(vm2.st.pool.drawn, kept);
  vm2.chooseNumber();
  assert.equal(vm2.sub, '4 of 5 left');
  for (let i = 0; i < 4; i++) roll(vm2);
  assert.equal(vm2.sub, 'All 5 drawn');

  // corrupt storage falls back to defaults
  saved['random-state'] = '{oops';
  const vm3 = makeVm();
  assert.deepEqual([vm3.mode, vm3.min, vm3.max, vm3.noRepeat], ['number', 1, 100, false]);

  // a missing vibrator module does not break a roll
  globalThis.__vibrator.vibrate = () => { throw new Error('no vibrator'); };
  vm3.roll();
  while (vm3.rolling) runTimer();
  assert.notEqual(vm3.big, '?');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok random page checks');
