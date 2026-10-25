// Run: node test/calc-check.mjs
import assert from 'node:assert/strict';
import { initialState, press, format, expression } from '../src/common/calc.js';

function run(keys) {
  let s = initialState();
  for (const k of keys.split(' ')) s = press(s, k);
  return s;
}
const cases = [
  ['0 . 1 + 0 . 2 =', '0.3'],
  ['1 + 2 * 3 =', '9'],
  ['1 0 / 0 =', 'Error'],
  ['1 0 / 0 = 5', '5'],
  ['1 0 / 0 = +', 'Error'],
  ['1 / 3 =', '0.3333333333'],
  ['2 / 3 =', '0.6666666667'],
  ['9 9 9 9 9 9 9 9 9 9 9 9', '9999999999'],
  ['9 9 9 9 9 9 9 9 9 9 * 9 9 9 9 9 9 9 9 9 9 =', '1e20'],
  ['1 . . 5', '1.5'],
  ['. 5 + . 5 =', '1'],
  ['5 - 8 =', '-3'],
  ['5 NEG * 2 =', '-10'],
  ['1 2 3 DEL', '12'],
  ['3 + * 2 =', '6'],
  ['3 + 4 = 2', '2'],
  ['3 + 4 = + 1 =', '8'],
  ['1 . 1 * 1 . 1 =', '1.21'],
  ['0 . 0 0 0 0 0 0 1 * 1 =', '1e-7'],
  ['C', '0'],
  ['7 C', '0'],
];
for (const [k, want] of cases) assert.equal(run(k).display, want, k);
assert.equal(expression(run('1 2 *')), '12 ×');
assert.equal(format(0.1 * 3), '0.3');
assert.equal(format(-0), '0');
console.log(`ok ${cases.length + 3} checks`);
