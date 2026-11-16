(function () {
  'use strict';

  /* ============================================================
     1. Expression engine
     Tokenizer -> recursive-descent parser -> number.
     No eval(): only known functions/constants are reachable.
     ============================================================ */

  const CONSTANTS = {
    pi: Math.PI,
    e: Math.E,
    tau: Math.PI * 2,
    phi: (1 + Math.sqrt(5)) / 2,
  };

  // Shared angle-mode state
  let angleMode = 'deg';
  const toRad = (x) => (angleMode === 'deg' ? (x * Math.PI) / 180 : x);
  const fromRad = (x) => (angleMode === 'deg' ? (x * 180) / Math.PI : x);

  // Trig keys take degrees in DEG mode. But an argument written as a radian
  // angle (anything mentioning pi/tau) is already radians, so hand it to the
  // trig function untouched. That makes sin(pi/6) = 0.5 in DEG mode while
  // sin(30) = 0.5 also still holds.
  const RADIAN_HINT = /\b(pi|tau)\b/i;
  const TRIG_FORWARD = { sin: 1, cos: 1, tan: 1 };

  // name: [arity, implementation]
  const FUNCTIONS = {
    sin: [1, (x) => Math.sin(toRad(x))],
    cos: [1, (x) => Math.cos(toRad(x))],
    tan: [1, (x) => Math.tan(toRad(x))],
    asin: [1, (x) => fromRad(Math.asin(x))],
    acos: [1, (x) => fromRad(Math.acos(x))],
    atan: [1, (x) => fromRad(Math.atan(x))],
    atan2: [2, (a, b) => fromRad(Math.atan2(a, b))],
    sinh: [1, Math.sinh],
    cosh: [1, Math.cosh],
    tanh: [1, Math.tanh],
    asinh: [1, (x) => Math.asinh(x)],
    acosh: [1, (x) => Math.acosh(x)],
    atanh: [1, (x) => Math.atanh(x)],
    ln: [1, Math.log],
    log: [1, Math.log10],
    log2: [1, Math.log2],
    exp: [1, Math.exp],
    sqrt: [1, Math.sqrt],
    cbrt: [1, Math.cbrt],
    inv: [1, reciprocal],
    abs: [1, Math.abs],
    round: [1, Math.round],
    floor: [1, Math.floor],
    ceil: [1, Math.ceil],
    mod: [2, (a, b) => a % b],
    pow: [2, Math.pow],
    root: [2, (a, b) => Math.pow(a, 1 / b)],
    hypot: [2, Math.hypot],
    min: [2, Math.min],
    max: [2, Math.max],
  };

  class CalcError extends Error {}

  const isDigit = (c) => c >= '0' && c <= '9';
  const isIdentStart = (c) => /[a-zA-Z_]/.test(c);
  const isIdentPart = (c) => /[a-zA-Z0-9_]/.test(c);

  function tokenize(src) {
    const tokens = [];
    let i = 0;

    while (i < src.length) {
      const c = src[i];

      if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }

      // number: 12  12.5  .5  1e9  2.5e-3
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
        let j = i;
        while (j < src.length && isDigit(src[j])) j++;
        if (src[j] === '.') {
          j++;
          while (j < src.length && isDigit(src[j])) j++;
        }
        if (src[j] === 'e' || src[j] === 'E') {
          let k = j + 1;
          if (src[k] === '+' || src[k] === '-') k++;
          if (isDigit(src[k])) {
            k++;
            while (k < src.length && isDigit(src[k])) k++;
            j = k;
          }
        }
        const value = parseFloat(src.slice(i, j));
        if (Number.isNaN(value)) throw new CalcError('Malformed number');
        tokens.push({ type: 'num', value: value, start: i, end: j });
        i = j;
        continue;
      }

      if (isIdentStart(c)) {
        let j = i;
        while (j < src.length && isIdentPart(src[j])) j++;
        tokens.push({ type: 'ident', value: src.slice(i, j), start: i, end: j });
        i = j;
        continue;
      }

      if ('+-*/^%!(),'.indexOf(c) !== -1) {
        tokens.push({ type: c, start: i, end: i + 1 });
        i++;
        continue;
      }

      throw new CalcError('Unexpected "' + c + '"');
    }

    return tokens;
  }

  function reciprocal(x) {
    if (x === 0) throw new CalcError('Cannot divide by zero');
    return 1 / x;
  }

  function factorial(n) {
    if (n < 0 || !Number.isInteger(n)) {
      throw new CalcError('x! needs a whole number  0 or more');
    }
    if (n > 170) throw new CalcError('x! is too large');
    let out = 1;
    for (let i = 2; i <= n; i++) out *= i;
    return out;
  }

  function evaluate(source, ans) {
    if (!source.trim()) return null;
    const tokens = tokenize(source);
    if (!tokens.length) return null;
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const startsPrimary = (t) => t && (t.type === 'num' || t.type === 'ident' || t.type === '(');
    const expect = (type) => {
      const t = tokens[pos];
      if (!t || t.type !== type) throw new CalcError('Expected "' + type + '"');
      pos++;
    };

    function parsePrimary() {
      const t = next();
      if (!t) throw new CalcError('Expression is incomplete');
      if (t.type === 'num') return t.value;
      if (t.type === '(') {
        const v = parseAdditive();
        expect(')');
        return v;
      }
      if (t.type === 'ident') {
        const name = t.value.toLowerCase();
        if (name === 'ans') return ans;
        if (Object.prototype.hasOwnProperty.call(CONSTANTS, name)) return CONSTANTS[name];
        if (Object.prototype.hasOwnProperty.call(FUNCTIONS, name)) {
          const spec = FUNCTIONS[name];
          if (spec[0] === 2) {
            // Two-argument functions always use call syntax: mod(10,3).
            // Parsing the args with parseAdditive leaves the ',' and ')'
            // for us, so the function owns its own parentheses.
            expect('(');
            const a = parseAdditive();
            expect(',');
            const b = parseAdditive();
            expect(')');
            if ((name === 'mod' || name === 'root') && b === 0) {
              throw new CalcError('Cannot divide by zero');
            }
            const out = spec[1](a, b);
            if (Number.isNaN(out)) throw new CalcError(name + '() is not defined there');
            if (!Number.isFinite(out)) throw new CalcError(name + '() is out of range');
            return out;
          }
          // Raw text of the argument, used to spot radian-angle arguments.
          const argStart = pos;
          let argValue = parseUnary();
          const argSrc = source.slice(tokens[argStart].start, tokens[pos - 1].end);
          if (TRIG_FORWARD[name] && angleMode === 'deg' && RADIAN_HINT.test(argSrc)) {
            // Undo the deg->rad step the function will apply internally.
            argValue = fromRad(argValue);
          }
          const out = spec[1](argValue);
          if (Number.isNaN(out)) throw new CalcError(name + '() is not defined there');
          if (!Number.isFinite(out)) throw new CalcError(name + '() is out of range');
          return out;
        }
        throw new CalcError('Unknown "' + t.value + '"');
      }
      throw new CalcError('Unexpected "' + t.type + '"');
    }

    function parsePostfix() {
      let v = parsePrimary();
      for (;;) {
        const t = peek();
        if (t && t.type === '!') { next(); v = factorial(v); }
        else if (t && t.type === '%') { next(); v = v / 100; }
        else break;
      }
      return v;
    }

    function parsePower() {
      const base = parsePostfix();
      if (peek() && peek().type === '^') {
        next();
        return Math.pow(base, parseUnary()); // right-associative: 2^3^2 = 2^9
      }
      return base;
    }

    function parseUnary() {
      const t = peek();
      if (t && t.type === '-') { next(); return -parseUnary(); }
      if (t && t.type === '+') { next(); return parseUnary(); }
      return parsePower();
    }

    function parseMultiplicative() {
      let left = parseUnary();
      for (;;) {
        const t = peek();
        if (t && (t.type === '*' || t.type === '/')) {
          next();
          const right = parseUnary();
          if (t.type === '/' && right === 0) throw new CalcError('Cannot divide by zero');
          left = t.type === '*' ? left * right : left / right;
        } else if (startsPrimary(t)) {
          left = left * parseUnary(); // implicit multiplication: 2pi, 3(4+5)
        } else {
          break;
        }
      }
      return left;
    }

    function parseAdditive() {
      let left = parseMultiplicative();
      while (peek() && (peek().type === '+' || peek().type === '-')) {
        const op = next().type;
        const right = parseMultiplicative();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    }

    const value = parseAdditive();
    if (pos < tokens.length) throw new CalcError('Unexpected "' + tokens[pos].value + '"');
    if (Number.isNaN(value)) throw new CalcError('Result is not a number');
    if (!Number.isFinite(value)) throw new CalcError('Result is out of range');
    return value;
  }

  /* ============================================================
     2. Formatting helpers
     ============================================================ */

  const SUP = { '0': '\u2070', '1': '\u00B9', '2': '\u00B2', '3': '\u00B3', '4': '\u2074',
                '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079' };

  function formatNumber(n) {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    const abs = Math.abs(n);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) {
      return n.toExponential(8).replace(/\.?0+e/, 'e').replace('e', ' \u00D7 10^');
    }
    return String(parseFloat(n.toPrecision(12)));
  }

  // Render stored ASCII source for humans: sqrt -> âˆš, * -> Â·, ^2 -> Â²
  function pretty(src) {
    return src
      .replace(/\bsqrt\b/g, '\u221A')
      .replace(/\bcbrt\b/g, '\u221B')
      .replace(/\bpi\b/g, '\u03C0')
      .replace(/\btau\b/g, '\u03C4')
      .replace(/\bans\b/gi, 'Ans')
      .replace(/\*+/g, '\u00B7')
      .replace(/\^(\d)/g, (m, d) => '^' + SUP[d])
      .replace(/\s+/g, ' ');
  }

  // Accept typed/pasted Unicode and map it to engine syntax
  function normalize(src) {
    return src
      .replace(/\u00F7/g, '/')   // Ã·
      .replace(/\u00D7/g, '*')   // Ã—
      .replace(/[\u2212\u2013\u2014]/g, '-') // âˆ’ â€“ â€”
      .replace(/\u03C0/g, 'pi')  // Ï€
      .replace(/\u221A/g, 'sqrt(')// âˆš
      .replace(/\u221B/g, 'cbrt(')// âˆ›
      .replace(/\u00B7/g, '*');  // Â·
  }

  /* ============================================================
     3. UI wiring
     ============================================================ */

  const exprEl = document.getElementById('expr');
  const resultEl = document.getElementById('result');
  const padEl = document.getElementById('pad');
  const listEl = document.getElementById('history');
  const angleBtn = document.getElementById('btnAngle');
  const invBtn = document.getElementById('btnInv');
  const themeBtn = document.getElementById('themeBtn');
  const themeIcon = document.getElementById('themeIcon');
  const themeLabel = document.getElementById('themeLabel');

  /* ---------- Theme ---------- */
  const THEME_KEY = 'sciCalc.theme';
  const ICON_MOON = '\u263E'; // shown while dark
  const ICON_SUN = '\u2600';   // shown while light

  function readTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) { /* storage blocked, fall back to defaults */ }
    return null;
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const dark = theme === 'dark';
    themeIcon.textContent = dark ? ICON_MOON : ICON_SUN;
    themeLabel.textContent = dark ? 'Dark' : 'Light';
    const action = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
    themeBtn.title = action;
    themeBtn.setAttribute('aria-label', action);
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  themeBtn.addEventListener('click', function () {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
  });

  applyTheme(getTheme());

  // Follow the OS only while the user has not made an explicit choice.
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onSchemeChange = (event) => {
      if (!readTheme()) applyTheme(event.matches ? 'light' : 'dark');
    };
    if (mq.addEventListener) mq.addEventListener('change', onSchemeChange);
    else if (mq.addListener) mq.addListener(onSchemeChange);
  }

  const MAX_HISTORY = 60;
  const STORE_KEY = 'sciCalc.history.v1';

  let ans = 0;
  let inv = false;
  let history = loadHistory();

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.slice(0, MAX_HISTORY) : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(history)); } catch (e) { /* memory only */ }
  }

  function autoSize() {
    exprEl.style.height = 'auto';
    exprEl.style.height = Math.min(exprEl.scrollHeight, 120) + 'px';
  }

  function insert(text) {
    const start = exprEl.selectionStart || 0;
    const end = exprEl.selectionEnd || 0;
    const value = exprEl.value;
    exprEl.value = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length;
    exprEl.setSelectionRange(caret, caret);
    exprEl.focus();
    onInput();
  }

  // Toggling the sign has to cope with a wrapped value the user (or an
  // earlier press) produced, so each case unwraps before the next wraps.
  const NUM = '\\d*\\.?\\d+(?:[eE][+-]?\\d+)?';
  const RX_WHOLE_WRAPPED = new RegExp('^\\(([+-]?' + NUM + ')\\)$');
  const RX_WHOLE_NEG = new RegExp('^-(' + NUM + ')$');
  const RX_NEG_WRAPPED = new RegExp('([+\\-*/^,(]|^)\\(-(' + NUM + ')\\)$');
  const RX_NEG_PLAIN = new RegExp('([+\\-*/^(,]|^)-(' + NUM + ')$');
  const RX_NEG_WHOLE = new RegExp('^-\\((.*)\\)$');
  const RX_BINARY_MINUS = new RegExp('[0-9).]-(' + NUM + ')$');

  function toggleSign() {
    const v = exprEl.value.replace(/\s+$/, '');
    let out = null;
    let m;

    // "3-(-" -> "3-"
    if (out === null && v.slice(-2) === '(-') out = v.slice(0, -2);
    // "-(2-3)" -> "2-3"
    if (out === null && (m = v.match(RX_NEG_WHOLE))) out = m[1];
    // "(-5)" -> "5"
    if (out === null && (m = v.match(RX_WHOLE_WRAPPED))) out = m[1].replace(/^[+-]/, '');
    // "-5" -> "5"
    if (out === null && (m = v.match(RX_WHOLE_NEG))) out = m[1];
    // "2+(-3)" -> "2+3"
    if (out === null && (m = v.match(RX_NEG_WRAPPED))) {
      out = v.slice(0, v.length - m[0].length) + m[1] + m[2];
    }
    // "2*-3" -> "2*3"
    if (out === null && (m = v.match(RX_NEG_PLAIN))) {
      out = v.slice(0, v.length - m[0].length) + m[1] + m[2];
    }
    // "2-3" -> "-(2-3)"
    if (out === null && RX_BINARY_MINUS.test(v)) {
      out = '-(' + v + ')';
    }
    // "2+3" -> "2+(-3)"
    if (out === null && (m = v.match(new RegExp(NUM + '$')))) {
      out = v.slice(0, v.length - m[0].length) + '(-' + m[0] + ')';
    }
    // Nothing numeric yet, e.g. "3-" or "sqrt("
    if (out === null) { insert('(-'); return; }

    exprEl.value = out;
    const caret = exprEl.value.length;
    exprEl.setSelectionRange(caret, caret);
    onInput();
  }

  // Close parentheses the user left open, so "sin(30" + "=" just works.
  function balance(src) {
    const opened = (src.match(/\(/g) || []).length;
    const closed = (src.match(/\)/g) || []).length;
    return opened > closed ? src + ')'.repeat(opened - closed) : src;
  }

  function onInput() {
    autoSize();
    const src = balance(normalize(exprEl.value));
    if (!src.trim()) {
      resultEl.textContent = '';
      resultEl.classList.remove('err');
      return;
    }
    try {
      const value = evaluate(src, ans);
      resultEl.textContent = '= ' + formatNumber(value);
      resultEl.classList.remove('err');
    } catch (e) {
      resultEl.textContent = e instanceof CalcError ? e.message : 'Invalid expression';
      resultEl.classList.add('err');
    }
  }

  function run() {
    const src = balance(normalize(exprEl.value));
    let value;
    try {
      value = evaluate(src, ans);
    } catch (e) {
      onInput();
      return;
    }
    if (value === null) return;

    ans = value;
    history.unshift({ expr: src, result: value, mode: angleMode });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    saveHistory();
    renderHistory();

    exprEl.value = formatNumber(value).replace(/ \u00D7 10\^/g, 'e');
    onInput();
  }

  function clearAll() {
    exprEl.value = '';
    onInput();
    exprEl.focus();
  }

  function backspace() {
    const start = exprEl.selectionStart || 0;
    const end = exprEl.selectionEnd || 0;
    const value = exprEl.value;
    let nextCaret;
    if (start !== end) {
      exprEl.value = value.slice(0, start) + value.slice(end);
      nextCaret = start;
    } else {
      nextCaret = Math.max(0, start - 1);
      exprEl.value = value.slice(0, nextCaret) + value.slice(start);
    }
    exprEl.setSelectionRange(nextCaret, nextCaret);
    exprEl.focus();
    onInput();
  }

  function setAngle() {
    angleMode = angleMode === 'deg' ? 'rad' : 'deg';
    angleBtn.textContent = angleMode.toUpperCase();
    onInput();
  }

  function setInv() {
    inv = !inv;
    invBtn.classList.toggle('inv-on', inv);
    padEl.querySelectorAll('[data-inv-label]').forEach((btn) => {
      btn.textContent = inv ? btn.dataset.invLabel : btn.dataset.label;
    });
  }

  // Directional pad navigation: move the caret through the expression.
  function moveCaret(delta) {
    const s = exprEl.selectionStart || 0;
    const e = exprEl.selectionEnd || 0;
    const nextS = Math.min(exprEl.value.length, Math.max(0, s + delta));
    const nextE = Math.min(exprEl.value.length, Math.max(0, e + delta));
    exprEl.setSelectionRange(nextS, nextE);
    exprEl.focus();
  }

  function moveCaretTo(pos) {
    const p = Math.max(0, Math.min(exprEl.value.length, pos));
    exprEl.setSelectionRange(p, p);
    exprEl.focus();
  }

  // Only the arrows on the circular D-pad button are clickable.
  var dirPadBtn = document.getElementById('dirPad');
  if (dirPadBtn) {
    var dpUp = dirPadBtn.querySelector('.dp-up');
    var dpDown = dirPadBtn.querySelector('.dp-down');
    var dpLeft = dirPadBtn.querySelector('.dp-left');
    var dpRight = dirPadBtn.querySelector('.dp-right');
    if (dpUp) dpUp.addEventListener('click', function (ev) { ev.stopPropagation(); moveCaretTo(0); });
    if (dpDown) dpDown.addEventListener('click', function (ev) { ev.stopPropagation(); moveCaretTo(exprEl.value.length); });
    if (dpLeft) dpLeft.addEventListener('click', function (ev) { ev.stopPropagation(); moveCaret(-1); });
    if (dpRight) dpRight.addEventListener('click', function (ev) { ev.stopPropagation(); moveCaret(1); });
  }

  function renderHistory() {
    listEl.innerHTML = '';
    history.forEach((item) => {
      const li = document.createElement('li');

      const expr = document.createElement('div');
      expr.className = 'h-expr';
      expr.textContent = pretty(item.expr) + (item.mode === 'rad' ? '  [rad]' : '');
      expr.title = 'Recall this expression';
      expr.addEventListener('click', () => {
        exprEl.value = item.expr;
        onInput();
        exprEl.focus();
      });

      const res = document.createElement('div');
      res.className = 'h-res';
      res.textContent = formatNumber(item.result);
      res.title = 'Insert this result';
      res.addEventListener('click', () => insert(formatNumber(item.result).replace(/ \u00D7 10\^/g, 'e')));

      li.appendChild(expr);
      li.appendChild(res);
      listEl.appendChild(li);
    });
  }

  // Remember original (unshifted) button labels
  padEl.querySelectorAll('[data-inv-label]').forEach((btn) => {
    btn.dataset.label = btn.textContent;
  });

  padEl.addEventListener('click', (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;

    if (btn.dataset.action === 'eval') { run(); return; }
    if (btn.dataset.action === 'clear') { clearAll(); return; }
    if (btn.dataset.action === 'back') { backspace(); return; }
    if (btn.dataset.action === 'negate') { toggleSign(); return; }
    if (btn.dataset.action === 'angle') { setAngle(); return; }
    if (btn.dataset.action === 'inv') { setInv(); return; }
    if (btn.dataset.action) {
      // Directional pad: left/right move the caret through the expression.
      if (btn.dataset.action === 'dir-left') { moveCaret(-1); return; }
      if (btn.dataset.action === 'dir-right') { moveCaret(1); return; }
      return;
    }

    if (btn.dataset.insert !== undefined) {
      insert(inv && btn.dataset.invInsert ? btn.dataset.invInsert : btn.dataset.insert);
    }
  });

  document.getElementById('clearHistory').addEventListener('click', () => {
    history = [];
    saveHistory();
    renderHistory();
  });

  const KEYS = {
    '+': '+', '-': '-', '*': '*', '/': '/', '^': '^',
    '%': '%', '!': '!', '(': '(', ')': ')', ',': ',', '.': '.',
  };

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === 'Enter' || event.key === '=') { event.preventDefault(); run(); return; }
    if (event.key === 'Escape') { event.preventDefault(); clearAll(); return; }
    if (event.key === 'Backspace') { event.preventDefault(); backspace(); return; }
    if (event.key === 'Delete') { exprEl.value = ''; onInput(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveCaretTo(0); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCaretTo(exprEl.value.length); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); moveCaret(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); moveCaret(1); return; }
    if (event.key === 'p' || event.key === 'P') { event.preventDefault(); insert('pi'); return; }
    if (event.key === 'a' || event.key === 'A') { event.preventDefault(); insert('ans'); return; }

    if (/^[0-9]$/.test(event.key)) { insert(event.key); return; }
    if (KEYS[event.key]) { insert(KEYS[event.key]); return; }
  });

  exprEl.addEventListener('input', onInput);
  renderHistory();
  onInput();
  exprEl.focus();
})();
