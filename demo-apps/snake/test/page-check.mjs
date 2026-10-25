// Run: npm test   (plain node)
// Loads the page script from index.ux with stubbed @system.storage and timers, plays random games,
// and checks that the incremental renderer (one div moved per tick) always matches the engine's body.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ux = readFileSync(join(root, 'src/pages/index/index.ux'), 'utf8');
const script = ux.match(/<script>([\s\S]*?)<\/script>/)[1];
const engine = pathToFileURL(join(root, 'src/common/snake.js')).href;

const dir = mkdtempSync(join(tmpdir(), 'snake-page-'));
try {
  writeFileSync(
    join(dir, 'page.mjs'),
    'var storage = globalThis.__storage;\n' +
      script
        .replace(/import storage from '@system\.storage'\n/, '')
        .replace("'../../common/snake.js'", JSON.stringify(engine)) +
      '\nexport function __game() { return game }\n'
  );
  const saved = {};
  globalThis.__storage = {
    get(o) { if (saved[o.key] !== undefined) o.success(saved[o.key]); else if (o.fail) o.fail(); },
    set(o) { saved[o.key] = o.value; }
  };
  const mod = await import(pathToFileURL(join(dir, 'page.mjs')).href);
  const def = mod.default;

  // Minimal VM: private data + methods on one object; timers run by hand.
  let pending = null;
  globalThis.setTimeout = (fn) => { pending = fn; return 1; };
  globalThis.clearTimeout = () => { pending = null; };
  const vm = JSON.parse(JSON.stringify(def.private));
  for (const k of Object.keys(def)) if (typeof def[k] === 'function') vm[k] = def[k];
  vm.$element = () => ({ getBoundingClientRect: (o) => o.success({ left: 0, top: 0, width: 192, height: 490 }) });
  vm.onInit();
  vm.onShow();

  const touch = (x0, y0, x1, y1) => {
    vm.onStart({ touches: [{ clientX: x0, clientY: y0 }] });
    vm.onEnd({ changedTouches: [{ clientX: x1, clientY: y1 }] });
    vm.lastTouch = 0; // as if 400 ms passed
  };
  const rendered = () => vm.slots.map((i) => vm.segs[i].l + ',' + vm.segs[i].t);
  const expected = () => mod.__game().body.map((c) => (c.x * 12 + 1) + ',' + (c.y * 12 + 1));

  assert.equal(vm.mode, 'ready');
  touch(100, 200, 100, 200); // tap starts
  assert.equal(vm.mode, 'run');
  assert.ok(pending);

  let games = 0;
  let maxLen = 0;
  for (let n = 0; n < 20000 && games < 30; n++) {
    if (vm.mode === 'over') {
      games++;
      vm.overAt = 0;
      touch(100, 200, 100, 200); // tap restarts
      assert.equal(vm.mode, 'run');
      assert.equal(vm.score, 0);
    }
    // steer towards the food most of the time so the snake grows
    const g = mod.__game();
    const h = g.body[0];
    if (g.food && Math.random() < 0.8) {
      const want = g.food.x !== h.x ? (g.food.x > h.x ? 'right' : 'left') : (g.food.y > h.y ? 'down' : 'up');
      const sw = { right: [60, 200, 120, 200], left: [120, 200, 60, 200], down: [100, 150, 100, 220], up: [100, 220, 100, 150] }[want];
      touch(...sw);
    } else if (Math.random() < 0.2) {
      const x = Math.random() < 0.5 ? 40 : 150;
      touch(x, 200, x + 3, 202); // tap on a half: relative turn
    }
    const fn = pending;
    pending = null;
    fn();
    if (vm.mode !== 'over') {
      assert.deepEqual(rendered(), expected());
      assert.equal(vm.segs.length, g.body.length); // no leaked divs
      assert.deepEqual([vm.head.l, vm.head.t], [g.body[0].x * 12 + 1, g.body[0].y * 12 + 1]);
      if (g.food) assert.deepEqual([vm.food.l, vm.food.t], [g.food.x * 12 + 1, g.food.y * 12 + 1]);
      assert.equal(vm.score, g.score);
      maxLen = Math.max(maxLen, g.body.length);
    }
  }
  assert.ok(games >= 1, 'played to game over');
  assert.ok(maxLen > 6, 'snake grew, max ' + maxLen);
  assert.ok(+saved['snake-best'] >= 1 && vm.best === +saved['snake-best'], 'best score saved');

  // pause on Back and on hide; Back while paused leaves the app
  vm.overAt = 0;
  if (vm.mode !== 'run') touch(100, 200, 100, 200);
  assert.equal(vm.mode, 'run');
  assert.equal(vm.onBackPress(), true);
  assert.equal(vm.mode, 'paused');
  assert.equal(pending, null);
  assert.equal(vm.onBackPress(), false);
  touch(100, 200, 100, 200);
  assert.equal(vm.mode, 'run');
  vm.onHide();
  assert.equal(vm.mode, 'paused');
  // a steering swipe right that the system also reports as Back does not pause
  touch(100, 200, 100, 200);
  vm.onStart({ touches: [{ clientX: 60, clientY: 200 }] });
  assert.equal(vm.onBackPress(), true);
  assert.equal(vm.mode, 'run');
  // a back gesture from the left edge is not a game touch
  vm.onCancel();
  vm.lastTouch = 0;
  vm.onStart({ touches: [{ clientX: 4, clientY: 200 }] });
  vm.onEnd({ changedTouches: [{ clientX: 80, clientY: 200 }] });
  assert.equal(vm.onBackPress(), true);
  assert.equal(vm.mode, 'paused');
  // best score is restored on the next launch
  const vm2 = JSON.parse(JSON.stringify(def.private));
  for (const k of Object.keys(def)) if (typeof def[k] === 'function') vm2[k] = def[k];
  vm2.onInit();
  assert.equal(vm2.best, vm.best);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok snake page checks');
