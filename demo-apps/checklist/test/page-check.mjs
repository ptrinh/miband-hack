// Run: npm test   (plain node)
// Loads the two page scripts from their .ux files with stubbed @system.file, @system.storage and
// @system.router, then walks through: list of lists with progress -> open a list -> tick / untick
// -> Uncheck all (two taps) -> Back -> progress updated -> re-install with edited lists.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'checklist-page-'));

// Stubs shared by every module through globalThis.
let listsJson = readFileSync(join(root, 'src/common/lists.json'), 'utf8');
const saved = {};
const routes = [];
let timers = [];
globalThis.__file = { readText(o) { if (listsJson === null) o.fail(null, 300); else o.success({ text: listsJson }); } };
globalThis.__storage = {
  get(o) { o.success(saved[o.key] !== undefined ? saved[o.key] : o.default); },
  set(o) { if (o.value === '') delete saved[o.key]; else saved[o.key] = o.value; },
};
globalThis.__router = { push(o) { routes.push(o); }, back() { routes.push('back'); } };
globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
globalThis.clearTimeout = () => { timers = []; };

const stub = (src) =>
  src
    .replace(/import file from '@system\.file'\n/, 'var file = globalThis.__file;\n')
    .replace(/import storage from '@system\.storage'\n/, 'var storage = globalThis.__storage;\n')
    .replace(/import router from '@system\.router'\n/, 'var router = globalThis.__router;\n')
    .replace(/'\.\.\/\.\.\/common\//g, "'./");

try {
  copyFileSync(join(root, 'src/common/model.js'), join(dir, 'model.js'));
  writeFileSync(join(dir, 'data.js'), stub(readFileSync(join(root, 'src/common/data.js'), 'utf8')));
  const page = async (name) => {
    const ux = readFileSync(join(root, `src/pages/${name}/index.ux`), 'utf8');
    const script = ux.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.ok(!/@system\./.test(stub(script)), `${name}: unstubbed import`);
    writeFileSync(join(dir, `${name}.mjs`), stub(script));
    return (await import(pathToFileURL(join(dir, `${name}.mjs`)).href)).default;
  };
  const indexDef = await page('index');
  const listDef = await page('list');

  // Minimal VM: private + protected data and methods on one object; callbacks here are synchronous.
  const vm = (def, params = {}) => {
    const v = { ...JSON.parse(JSON.stringify({ ...def.protected, ...def.private })), ...params };
    for (const k of Object.keys(def)) if (typeof def[k] === 'function') v[k] = def[k];
    return v;
  };

  // 1. list of lists with progress
  const home = vm(indexDef);
  home.onInit();
  home.onShow();
  assert.equal(home.state, 'ready');
  assert.deepEqual(home.lists.map((l) => `${l.title} ${l.done}/${l.total}`), ['Shopping 0/6', 'To do 0/3', 'Packing 0/4']);
  assert.equal(home.lists[0].fill, 0);

  // 2. open a list
  home.open(0);
  assert.deepEqual(routes.pop(), { uri: 'pages/list', params: { id: 'shop1' } });
  const shop = vm(listDef, { id: 'shop1' });
  shop.onInit();
  assert.equal(shop.state, 'ready');
  assert.equal(shop.title, 'Shopping');
  assert.equal(shop.rows.length, 6);
  assert.equal(shop.total, 6);

  // 3. tick / untick, saved at once
  shop.toggle(0);
  shop.toggle(2);
  shop.toggle(3);
  assert.equal(shop.done, 3);
  assert.deepEqual(shop.rows.map((r) => r.done), [true, false, true, true, false, false]);
  assert.equal(saved['checklist-ticks'], 'shop1:s1,s3,s4');
  shop.toggle(2);
  assert.equal(shop.done, 2);
  assert.equal(saved['checklist-ticks'], 'shop1:s1,s4');
  shop.toggle(99); // out of range: ignored
  assert.equal(shop.done, 2);

  // 4. Back -> the home page shows the new progress
  shop.goBack();
  assert.equal(routes.pop(), 'back');
  home.onShow();
  assert.deepEqual(home.lists.map((l) => `${l.done}/${l.total}`), ['2/6', '0/3', '0/4']);
  assert.equal(home.lists[0].fill, Math.round((148 * 2) / 6));

  // 5. Uncheck all needs a second tap; the first one times out or is cancelled by a tick
  const shop2 = vm(listDef, { id: 'shop1' });
  shop2.onInit();
  assert.equal(shop2.done, 2); // ticks restored from storage
  assert.deepEqual(shop2.rows.map((r) => r.done), [true, false, false, true, false, false]);
  shop2.uncheckAll();
  assert.equal(shop2.confirmReset, true);
  assert.equal(shop2.done, 2);
  timers.shift()(); // 3 s pass
  assert.equal(shop2.confirmReset, false);
  shop2.uncheckAll();
  shop2.toggle(1); // a tick in between disarms it
  assert.equal(shop2.confirmReset, false);
  assert.equal(shop2.done, 3);
  shop2.uncheckAll();
  shop2.uncheckAll();
  assert.equal(shop2.done, 0);
  assert.ok(shop2.rows.every((r) => !r.done));
  assert.equal(saved['checklist-ticks'], undefined); // empty value deletes the key
  assert.equal(timers.length, 0);

  // ticks in another list are independent (one list page is open at a time: Back, then open another)
  shop2.toggle(5);
  const todo = vm(listDef, { id: 'todo1' });
  todo.onInit();
  todo.toggle(0);
  assert.equal(saved['checklist-ticks'], 'shop1:s6;todo1:t1');
  // a fresh list page keeps both
  const todo2 = vm(listDef, { id: 'todo1' });
  todo2.onInit();
  assert.equal(todo2.done, 1);

  // 6. re-install with edited lists: kept ticks for items that still exist, new items unticked
  saved['checklist-ticks'] = 'shop1:s1,s2,s6;todo1:t1;pack1:p2';
  const sample = JSON.parse(listsJson);
  sample.lists[0].items = [{ id: 's2', text: 'Eggs (a dozen)' }, { id: 'n1', text: 'Oat milk' }, ...sample.lists[0].items.slice(2)];
  sample.lists.splice(2, 1); // Packing removed
  listsJson = JSON.stringify(sample);
  const home2 = vm(indexDef);
  home2.onInit();
  home2.onShow();
  assert.deepEqual(home2.lists.map((l) => `${l.title} ${l.done}/${l.total}`), ['Shopping 2/6', 'To do 1/3']);
  assert.equal(saved['checklist-ticks'], 'shop1:s2,s6;todo1:t1'); // pruned
  const shop3 = vm(listDef, { id: 'shop1' });
  shop3.onInit();
  assert.deepEqual(shop3.rows.map((r) => `${r.id}:${r.done}`), ['s2:true', 'n1:false', 's3:false', 's4:false', 's5:false', 's6:true']);
  assert.equal(shop3.rows[0].text, 'Eggs (a dozen)');

  // 7. a list removed since the page was opened, an unreadable file, an empty list
  const gone = vm(listDef, { id: 'pack1' });
  gone.onInit();
  assert.equal(gone.state, 'missing');
  listsJson = '{"lists":[{"id":"e1","title":"Empty","items":[]}]}';
  const empty = vm(listDef, { id: 'e1' });
  empty.onInit();
  assert.equal(empty.state, 'ready');
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.total, 0);
  const home3 = vm(indexDef);
  home3.onInit();
  home3.onShow();
  assert.equal(home3.lists[0].complete, false);
  listsJson = null;
  const broken = vm(indexDef);
  broken.onInit();
  broken.onShow();
  assert.equal(broken.state, 'error');
  const brokenList = vm(listDef, { id: 'shop1' });
  brokenList.onInit();
  assert.equal(brokenList.state, 'error');
  listsJson = 'not json';
  const bad = vm(indexDef);
  bad.onInit();
  assert.equal(bad.state, 'error');

  // 8. complete list is flagged on the home page
  listsJson = '{"lists":[{"id":"d1","title":"Done","items":[{"id":"a","text":"A"}]}]}';
  saved['checklist-ticks'] = 'd1:a';
  const home4 = vm(indexDef);
  home4.onInit();
  home4.onShow();
  assert.equal(home4.lists[0].complete, true);
  assert.equal(home4.lists[0].fill, 148);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('ok checklist page checks');
