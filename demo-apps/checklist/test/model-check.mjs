// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/common/model.js';

// normalize: bad ids, duplicate ids, blank items and empty lists are dropped; titles trimmed
const lists = M.normalize({
  lists: [
    { id: 'a', title: ' Shop ', items: [{ id: 'x1', text: ' Milk ' }, { id: 'x2', text: '  ' }, { id: 'X3', text: 'bad id' }, { id: 'x1', text: 'dup' }, null, { id: 'x4', text: 'Eggs' }] },
    { id: 'a', title: 'duplicate list id', items: [] },
    { id: 'b', title: '', items: [] },
    { id: 'c', title: '', items: [{ id: 'y1', text: 'only item' }] },
    { id: 'bad id', title: 'x', items: [] },
    'junk',
  ],
});
assert.deepEqual(lists, [
  { id: 'a', title: 'Shop', items: [{ id: 'x1', text: 'Milk' }, { id: 'x4', text: 'Eggs' }] },
  { id: 'c', title: 'Untitled', items: [{ id: 'y1', text: 'only item' }] },
]);
assert.deepEqual(M.normalize(null), []);
assert.deepEqual(M.normalize({ lists: 'no' }), []);

// the bundled sample is valid
const sample = JSON.parse(readFileSync(new URL('../src/common/lists.json', import.meta.url), 'utf8'));
assert.equal(M.normalize(sample).length, sample.lists.length);

// ticks: toggle, count, serialize round trip
let ticks = {};
assert.equal(M.toggle(ticks, 'a', 'x1'), true);
assert.equal(M.toggle(ticks, 'c', 'y1'), true);
assert.equal(M.countDone(lists[0], ticks), 1);
assert.deepEqual(M.rows(lists[0], ticks), [{ id: 'x1', text: 'Milk', done: true }, { id: 'x4', text: 'Eggs', done: false }]);
const text = M.serializeTicks(ticks);
assert.equal(text, 'a:x1;c:y1');
assert.deepEqual(M.parseTicks(text), ticks);
assert.equal(M.toggle(ticks, 'a', 'x1'), false);
assert.equal(M.countDone(lists[0], ticks), 0);
assert.equal(M.serializeTicks(ticks), 'c:y1'); // empty lists are not written
assert.equal(M.serializeTicks({}), '');

// parseTicks tolerates junk
assert.deepEqual(M.parseTicks(''), {});
assert.deepEqual(M.parseTicks(null), {});
assert.deepEqual(M.parseTicks('a:x1,,BAD,x2;:y;nocolon;b:'), { a: { x1: true, x2: true } });

// uncheck all only touches that list
ticks = M.parseTicks('a:x1,x4;c:y1');
M.uncheckAll(ticks, 'a');
assert.deepEqual(ticks, { c: { y1: true } });

// re-install with edited lists: ticks kept for items that still exist, new items unticked,
// removed items and lists forgotten
ticks = M.parseTicks('a:x1,x4;c:y1;gone:z1');
const edited = M.normalize({ lists: [{ id: 'a', title: 'Shop', items: [{ id: 'x4', text: 'Eggs (6)' }, { id: 'x9', text: 'New' }] }] });
const pruned = M.pruneTicks(ticks, edited);
assert.deepEqual(pruned, { a: { x4: true } });
assert.deepEqual(M.rows(edited[0], pruned), [{ id: 'x4', text: 'Eggs (6)', done: true }, { id: 'x9', text: 'New', done: false }]);

// helpers
assert.equal(M.findList(lists, 'c'), lists[1]);
assert.equal(M.findList(lists, 'zz'), null);
assert.equal(M.fillWidth(3, 8, 148), 56);
assert.equal(M.fillWidth(0, 0, 148), 0);
assert.equal(M.fillWidth(8, 8, 148), 148);

// many items: 100 items round-trip within a reasonable storage value
const big = { id: 'big', title: 'Big', items: Array.from({ length: 100 }, (_, i) => ({ id: 'i' + i, text: 'Item ' + i })) };
ticks = {};
for (const it of big.items) M.toggle(ticks, 'big', it.id);
assert.equal(M.countDone(big, M.parseTicks(M.serializeTicks(ticks))), 100);

console.log('ok checklist model checks');
