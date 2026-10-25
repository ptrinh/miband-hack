// Calculator engine (pure, no platform APIs) — MIT License.
// Immediate-execution semantics like a pocket calculator: 2 + 3 x 4 = 20.

var MAX_DIGITS = 10;
var SIG_DIGITS = 10;

export function initialState() {
  return { display: '0', acc: null, op: null, fresh: true, error: false };
}

// Round to SIG_DIGITS significant digits so 0.1 + 0.2 shows 0.3, then keep it
// short enough for the narrow screen.
export function format(x) {
  if (!isFinite(x)) return 'Error';
  var r = parseFloat(x.toPrecision(SIG_DIGITS));
  if (r === 0) return '0'; // also normalises -0
  var s = String(r);
  if (s.length > 12) {
    s = r.toExponential(5).replace(/\.?0+e/, 'e').replace('e+', 'e');
  }
  return s;
}

function apply(a, op, b) {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? NaN : a / b;
  }
  return b;
}

function digitCount(s) {
  return s.replace(/[^0-9]/g, '').length;
}

function errorState() {
  return { display: 'Error', acc: null, op: null, fresh: true, error: true };
}

// Returns a new state; never mutates the input.
export function press(state, key) {
  var s = {
    display: state.display, acc: state.acc, op: state.op,
    fresh: state.fresh, error: state.error
  };

  if (key === 'C') return initialState();

  if (s.error) {
    // After an error only a digit or '.' starts over.
    if (/^[0-9.]$/.test(key)) s = initialState();
    else return s;
  }

  if (/^[0-9]$/.test(key)) {
    if (s.fresh || s.display === '0') {
      s.display = key;
    } else if (s.display === '-0') {
      s.display = '-' + key;
    } else if (digitCount(s.display) < MAX_DIGITS) {
      s.display += key;
    }
    s.fresh = false;
    return s;
  }

  if (key === '.') {
    if (s.fresh) {
      s.display = '0.';
    } else if (s.display.indexOf('.') < 0 && s.display.indexOf('e') < 0 &&
               digitCount(s.display) < MAX_DIGITS) {
      s.display += '.';
    }
    s.fresh = false;
    return s;
  }

  if (key === 'DEL') {
    if (s.fresh) return s;
    var d = s.display.slice(0, -1);
    if (d === '' || d === '-') d = '0';
    s.display = d;
    return s;
  }

  if (key === 'NEG') {
    if (s.display === '0' || s.display === 'Error') return s;
    s.display = s.display.charAt(0) === '-' ? s.display.slice(1) : '-' + s.display;
    if (s.fresh && s.op === null) s.acc = null; // negating a result keeps it editable as a value
    return s;
  }

  if (key === '+' || key === '-' || key === '*' || key === '/') {
    var cur = parseFloat(s.display);
    if (s.op !== null && !s.fresh) {
      var r = apply(s.acc, s.op, cur);
      if (!isFinite(r)) return errorState();
      s.acc = parseFloat(r.toPrecision(SIG_DIGITS));
      s.display = format(s.acc);
    } else if (s.op === null || s.acc === null) {
      s.acc = cur;
    }
    // If an operator was just pressed (fresh), this simply replaces it.
    s.op = key;
    s.fresh = true;
    return s;
  }

  if (key === '=') {
    if (s.op === null) {
      s.fresh = true;
      return s;
    }
    var b = parseFloat(s.display);
    var res = apply(s.acc, s.op, b);
    if (!isFinite(res)) return errorState();
    return { display: format(res), acc: null, op: null, fresh: true, error: false };
  }

  return s;
}

var OP_LABEL = { '+': '+', '-': '-', '*': '×', '/': '÷' };

// Small line above the main display, e.g. "12 x".
export function expression(state) {
  if (state.error || state.op === null || state.acc === null) return '';
  return format(state.acc) + ' ' + OP_LABEL[state.op];
}
