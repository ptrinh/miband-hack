// Snake engine (pure, no platform APIs) — MIT License.
//
// The page only renders what step() reports: the new head cell and the tail
// cell that was freed (null when the snake grew). That lets the page move one
// segment per tick instead of re-rendering the whole body.
// Coordinates are grid cells, x to the right, y down. Walls are deadly.

export var COLS = 15;
export var ROWS = 32;

export var DIRS = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 }
};
var CLOCKWISE = ['up', 'right', 'down', 'left'];
var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
var MAX_QUEUE = 2; // turns typed faster than the tick are kept, but not unboundedly

// Tick length in ms: starts slow, speeds up 6 ms per food, never below 130 ms.
export function interval(eaten) {
  return Math.max(130, 280 - 6 * eaten);
}

// rand() must return [0, 1); injectable for tests.
export function createGame(cols, rows, rand) {
  var g = {
    cols: cols || COLS,
    rows: rows || ROWS,
    rand: rand || Math.random,
    body: [], // head first
    occ: [], // occ[y * cols + x] === true when a segment is on that cell
    dir: 'up',
    queue: [],
    food: null,
    score: 0,
    over: false,
    won: false
  };
  // Length 3, heading up from the lower middle, so there is room ahead.
  var x = Math.floor(g.cols / 2);
  var y = Math.min(Math.floor(g.rows * 0.65), g.rows - 3);
  for (var i = 0; i < 3; i++) {
    g.body.push({ x: x, y: y + i });
    g.occ[(y + i) * g.cols + x] = true;
  }
  placeFood(g);
  return g;
}

// The direction the snake will have after the queued turns.
function lastDir(g) {
  return g.queue.length ? g.queue[g.queue.length - 1] : g.dir;
}

// Absolute turn (swipe). Reversing into the neck and repeats are ignored.
// Returns true if the turn was queued.
export function turn(g, dir) {
  if (g.over || !DIRS[dir] || g.queue.length >= MAX_QUEUE) return false;
  var cur = lastDir(g);
  if (dir === cur || dir === OPPOSITE[cur]) return false;
  g.queue.push(dir);
  return true;
}

// Relative turn (tap on the left or right half): 'left' = counter-clockwise.
export function turnSide(g, side) {
  var i = CLOCKWISE.indexOf(lastDir(g));
  return turn(g, CLOCKWISE[(i + (side === 'left' ? 3 : 1)) % 4]);
}

// Puts food on a uniformly random free cell; no free cell means the player won.
export function placeFood(g) {
  var free = g.cols * g.rows - g.body.length;
  if (free <= 0) {
    g.food = null;
    g.over = true;
    g.won = true;
    return null;
  }
  var n = Math.min(free - 1, Math.floor(g.rand() * free));
  for (var c = 0; c < g.cols * g.rows; c++) {
    if (g.occ[c]) continue;
    if (n === 0) {
      g.food = { x: c % g.cols, y: Math.floor(c / g.cols) };
      return g.food;
    }
    n--;
  }
  return null; // unreachable
}

// Advances one cell. Returns { head, tail, ate, over }:
// head = new head cell, tail = freed cell (null if the snake grew or died).
export function step(g) {
  if (g.over) return { head: null, tail: null, ate: false, over: true };
  if (g.queue.length) g.dir = g.queue.shift();
  var d = DIRS[g.dir];
  var h = g.body[0];
  var nx = h.x + d.x;
  var ny = h.y + d.y;
  if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) {
    g.over = true;
    return { head: null, tail: null, ate: false, over: true };
  }
  var ate = !!g.food && g.food.x === nx && g.food.y === ny;
  var tail = null;
  if (!ate) {
    // The tail moves away this tick, so the head may take its cell.
    tail = g.body.pop();
    g.occ[tail.y * g.cols + tail.x] = false;
  }
  if (g.occ[ny * g.cols + nx]) {
    if (tail) {
      g.body.push(tail); // leave the final position intact for the game-over screen
      g.occ[tail.y * g.cols + tail.x] = true;
    }
    g.over = true;
    return { head: null, tail: null, ate: false, over: true };
  }
  var head = { x: nx, y: ny };
  g.body.unshift(head);
  g.occ[ny * g.cols + nx] = true;
  if (ate) {
    g.score += 1;
    placeFood(g);
  }
  return { head: head, tail: tail, ate: ate, over: g.over };
}
