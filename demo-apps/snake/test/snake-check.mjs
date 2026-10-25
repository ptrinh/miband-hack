// Run: npm test   (plain node; deliberately not named *.test.* so the main vitest suite ignores it)
import assert from 'node:assert/strict';
import * as S from '../src/common/snake.js';

const cells = (g) => g.body.map((c) => c.x + ',' + c.y);
const zero = () => 0;

// start: length 3, heading up, food not on the snake
let g = S.createGame(15, 32, zero);
assert.deepEqual(cells(g), ['7,20', '7,21', '7,22']);
assert.equal(g.dir, 'up');
assert.deepEqual(g.food, { x: 0, y: 0 }); // first free cell when rand() = 0

// movement: head advances, tail cell is reported as freed
let r = S.step(g);
assert.deepEqual(r.head, { x: 7, y: 19 });
assert.deepEqual(r.tail, { x: 7, y: 22 });
assert.equal(r.ate, false);
assert.deepEqual(cells(g), ['7,19', '7,20', '7,21']);
assert.ok(!g.occ[22 * 15 + 7] && g.occ[19 * 15 + 7]);

// turns: reversal and repeats ignored, queue is capped at 2
assert.equal(S.turn(g, 'down'), false);
assert.equal(S.turn(g, 'up'), false);
assert.equal(S.turn(g, 'left'), true);
assert.equal(S.turn(g, 'right'), false); // opposite of the queued 'left'
assert.equal(S.turn(g, 'down'), true);
assert.equal(S.turn(g, 'left'), false); // queue full
S.step(g);
assert.equal(g.dir, 'left');
S.step(g);
assert.equal(g.dir, 'down');
// relative turns: from 'down', left (counter-clockwise) = right on screen
assert.ok(S.turnSide(g, 'left'));
assert.equal(g.queue[0], 'right');
g.queue = [];
assert.ok(S.turnSide(g, 'right'));
assert.equal(g.queue[0], 'left');

// growth: eating keeps the tail and scores
g = S.createGame(15, 32, zero);
g.food = { x: 7, y: 19 };
r = S.step(g);
assert.equal(r.ate, true);
assert.equal(r.tail, null);
assert.equal(g.body.length, 4);
assert.equal(g.score, 1);
assert.ok(g.food && !g.occ[g.food.y * 15 + g.food.x]);

// wall collision
g = S.createGame(5, 5, zero);
g.food = null;
let steps = 0;
while (!g.over && steps < 10) { S.step(g); steps++; }
assert.ok(g.over);
assert.equal(steps, 3); // head starts on row 2; rows 1, 0, then the wall
assert.equal(g.body.length, 3);

// self collision: a length-5 snake turning in a tight square bites itself
g = S.createGame(10, 10, zero);
g.food = null;
g.body = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }, { x: 4, y: 4 }];
g.occ = [];
for (const c of g.body) g.occ[c.y * 10 + c.x] = true;
g.dir = 'up';
S.turn(g, 'left');
S.step(g); // head -> 4,5: a body cell that is not the tail
assert.ok(g.over);
assert.equal(g.body.length, 5); // final position kept for the game-over screen

// moving into the cell the tail is leaving is allowed
g = S.createGame(10, 10, zero);
g.food = null;
g.body = [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 4, y: 6 }, { x: 4, y: 5 }];
g.occ = [];
for (const c of g.body) g.occ[c.y * 10 + c.x] = true;
g.dir = 'up';
S.turn(g, 'left');
r = S.step(g);
assert.ok(!g.over);
assert.deepEqual(r.head, { x: 4, y: 5 });
assert.deepEqual(r.tail, { x: 4, y: 5 });

// food placement: never on the snake, whatever rand() returns
for (let i = 0; i < 300; i++) {
  g = S.createGame(6, 6, Math.random);
  for (let k = 0; k < 40 && !g.over; k++) {
    if (k % 5 === 0) S.turnSide(g, Math.random() < 0.5 ? 'left' : 'right');
    S.step(g);
    if (g.food) assert.ok(!g.body.some((c) => c.x === g.food.x && c.y === g.food.y), 'food on snake');
  }
}
// rand() at its upper edge still lands on a free cell
g = S.createGame(4, 4, () => 0.9999999);
assert.deepEqual(g.food, { x: 3, y: 3 });
// a full board is a win
g = S.createGame(1, 4, zero); // 1x4: body fills 3 cells, food on the last one
assert.deepEqual(g.food, { x: 0, y: 0 });
r = S.step(g);
assert.ok(r.ate && g.over && g.won && g.food === null);

// speed: gentle, with a floor
assert.equal(S.interval(0), 280);
assert.ok(S.interval(10) < S.interval(0));
assert.equal(S.interval(1000), 130);

console.log('ok snake engine checks');
