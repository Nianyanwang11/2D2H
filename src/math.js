/* ===== Math engine: tokenizer, parser, compiler, derivative, pretty printer ===== */
const MathEngine = (() => {
  const FN_ALIASES = { arcsin: 'asin', arccos: 'acos', arctan: 'atan' };
  const FUNCS = new Set(['sin','cos','tan','sec','csc','cot','asin','acos','atan','sinh','cosh','tanh','ln','log','sqrt','abs','exp']);
  const NAMES = ['arcsin','arccos','arctan','asin','acos','atan','sinh','cosh','tanh','sqrt','theta','sin','cos','tan','sec','csc','cot','abs','exp','log','ln','pi'];

  function normalize(src) {
    return String(src)
      .replace(/[×·∙⋅✕]/g, '*')
      .replace(/÷/g, '/')
      .replace(/[−–—]/g, '-')
      .replace(/²/g, '^2').replace(/³/g, '^3').replace(/¹/g, '^1')
      .replace(/[ϑΘ]/g, 'θ')
      .replace(/\[/g, '(').replace(/\]/g, ')')
      .replace(/\\cdot|\\times/g, '*')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(src) {
    const s = src;
    const toks = [];
    let i = 0, lit = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ') { i++; continue; }
      if (/[0-9.]/.test(c)) {
        let j = i, dot = false;
        while (j < s.length && (/[0-9]/.test(s[j]) || (s[j] === '.' && !dot))) { if (s[j] === '.') dot = true; j++; }
        const text = s.slice(i, j);
        if (text === '.') throw new Error('Stray "."');
        toks.push({ type: 'num', value: parseFloat(text), text, start: i, end: j, lit: lit++ });
        i = j; continue;
      }
      if (/[a-zA-Zθπ√]/.test(c)) {
        if (c === '√') { toks.push({ type: 'fn', name: 'sqrt', start: i, end: i + 1 }); i++; continue; }
        let j = i;
        while (j < s.length && /[a-zA-Zθπ]/.test(s[j])) j++;
        const run = s.slice(i, j);
        let k = 0;
        while (k < run.length) {
          let matched = null;
          for (const name of NAMES) { if (run.startsWith(name, k)) { matched = name; break; } }
          const st = i + k;
          if (matched) {
            k += matched.length;
            if (matched === 'pi') toks.push({ type: 'const', name: 'π', start: st, end: i + k });
            else if (matched === 'theta') toks.push({ type: 'var', name: 'θ', start: st, end: i + k });
            else toks.push({ type: 'fn', name: FN_ALIASES[matched] || matched, start: st, end: i + k });
          } else {
            const ch = run[k]; k++;
            if (ch === 'π') toks.push({ type: 'const', name: 'π', start: st, end: i + k });
            else if (ch === 'e') toks.push({ type: 'const', name: 'e', start: st, end: i + k });
            else toks.push({ type: 'var', name: ch, start: st, end: i + k });
          }
        }
        i = j; continue;
      }
      if ('+-*/^(),=!'.includes(c)) { toks.push({ type: 'op', v: c, start: i, end: i + 1 }); i++; continue; }
      if (c === '|') throw new Error('Use abs( ) for absolute value');
      throw new Error('Unknown symbol "' + c + '"');
    }
    return toks;
  }

  // ---- Parser ----
  function parseTokens(toks) {
    let p = 0;
    const peek = () => toks[p];
    const isOp = (t, v) => t && t.type === 'op' && t.v === v;
    const startsPrimary = (t) => t && (t.type === 'num' || t.type === 'var' || t.type === 'const' || t.type === 'fn' || isOp(t, '('));
    function expect(v) { if (!isOp(peek(), v)) throw new Error('Expected "' + v + '"'); p++; }

    function expr() {
      let a = term();
      while (isOp(peek(), '+') || isOp(peek(), '-')) {
        const o = toks[p++].v; const b = term();
        a = { t: 'op', o, a, b };
      }
      return a;
    }
    function term() {
      let a = unary();
      for (;;) {
        const t = peek();
        if (isOp(t, '*') || isOp(t, '/')) { p++; const b = unary(); a = { t: 'op', o: t.v, a, b }; }
        else if (startsPrimary(t)) { const b = power(); a = { t: 'op', o: '*', a, b, imp: true }; }
        else break;
      }
      return a;
    }
    function unary() {
      if (isOp(peek(), '-')) { p++; return { t: 'neg', a: unary() }; }
      if (isOp(peek(), '+')) { p++; return unary(); }
      return power();
    }
    function power() {
      let base = postfix();
      if (isOp(peek(), '^')) { p++; const e = unary(); return { t: 'op', o: '^', a: base, b: e }; }
      return base;
    }
    function postfix() {
      let n = primary();
      while (isOp(peek(), '!')) { p++; n = { t: 'fn', n: 'fact', a: [n] }; }
      return n;
    }
    function implicitArg() {
      let a = power();
      while (peek() && startsPrimary(peek()) && peek().type !== 'fn' && !isOp(peek(), '(')) {
        a = { t: 'op', o: '*', a, b: power(), imp: true };
      }
      return a;
    }
    function primary() {
      const t = peek();
      if (!t) throw new Error('Unexpected end');
      if (t.type === 'num') { p++; return { t: 'num', v: t.value, lit: t.lit }; }
      if (t.type === 'var') { p++; return { t: 'var', n: t.name }; }
      if (t.type === 'const') { p++; return { t: 'const', n: t.name }; }
      if (t.type === 'fn') {
        p++;
        let powExp = null;
        if (isOp(peek(), '^')) { p++; powExp = unary(); }
        let arg;
        if (isOp(peek(), '(')) { p++; arg = expr(); expect(')'); }
        else arg = implicitArg();
        let node = { t: 'fn', n: t.name, a: [arg] };
        if (powExp) node = { t: 'op', o: '^', a: node, b: powExp };
        return node;
      }
      if (isOp(t, '(')) {
        p++;
        const first = expr();
        if (isOp(peek(), ',')) {
          const items = [first];
          while (isOp(peek(), ',')) { p++; items.push(expr()); }
          expect(')');
          return { t: 'tuple', items };
        }
        expect(')');
        return { t: 'group', a: first };
      }
      throw new Error('Unexpected "' + (t.v || t.name) + '"');
    }
    const node = expr();
    if (p < toks.length) throw new Error('Unexpected "' + (toks[p].v || toks[p].name || toks[p].text) + '"');
    return node;
  }

  function stripGroups(n) {
    if (!n) return n;
    if (n.t === 'group') return stripGroups(n.a);
    if (n.t === 'op') return { ...n, a: stripGroups(n.a), b: stripGroups(n.b) };
    if (n.t === 'neg') return { t: 'neg', a: stripGroups(n.a) };
    if (n.t === 'fn') return { ...n, a: n.a.map(stripGroups) };
    if (n.t === 'tuple') return { t: 'tuple', items: n.items.map(stripGroups) };
    return n;
  }

  function parse(src) {
    const toks = tokenize(normalize(src));
    if (!toks.length) throw new Error('Empty');
    return stripGroups(parseTokens(toks));
  }

  // Split a statement at top-level "=" and "," (depth 0)
  function splitTop(str, ch) {
    const out = []; let depth = 0, last = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ch && depth === 0) { out.push(str.slice(last, i)); last = i + 1; }
    }
    out.push(str.slice(last));
    return out;
  }

  // ---- Variables ----
  function freeVars(n, set = new Set()) {
    if (!n) return set;
    if (n.t === 'var') set.add(n.n);
    else if (n.t === 'op') { freeVars(n.a, set); freeVars(n.b, set); }
    else if (n.t === 'neg' || n.t === 'group') freeVars(n.a, set);
    else if (n.t === 'fn') n.a.forEach(x => freeVars(x, set));
    else if (n.t === 'tuple') n.items.forEach(x => freeVars(x, set));
    return set;
  }

  // ---- Compiler ----
  function fact(n) { if (n < 0 || !Number.isInteger(n)) return NaN; let r = 1; for (let i = 2; i <= n && i < 171; i++) r *= i; return n > 170 ? Infinity : r; }
  function powf(a, b) {
    if (a < 0 && !Number.isInteger(b)) {
      for (let q = 1; q <= 15; q += 2) {
        const pp = b * q;
        if (Math.abs(pp - Math.round(pp)) < 1e-9) { const r = Math.pow(-a, b); return Math.round(pp) % 2 === 0 ? r : -r; }
      }
      return NaN;
    }
    return Math.pow(a, b);
  }
  const F = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    sec: x => 1 / Math.cos(x), csc: x => 1 / Math.sin(x), cot: x => 1 / Math.tan(x),
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    ln: Math.log, log: Math.log10, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
    fact, pow: powf
  };
  const ARGMAP = { x: 'x', y: 'y', t: 't', 'θ': 'th', z: 'z' };

  function gen(n, args) {
    switch (n.t) {
      case 'num': return '(' + n.v + ')';
      case 'var': return args.includes(n.n) ? ARGMAP[n.n] : '(S[' + JSON.stringify(n.n) + '])';
      case 'const': return n.n === 'π' ? 'Math.PI' : 'Math.E';
      case 'neg': return '(-' + gen(n.a, args) + ')';
      case 'group': return gen(n.a, args);
      case 'op':
        if (n.o === '^') return 'F.pow(' + gen(n.a, args) + ',' + gen(n.b, args) + ')';
        return '(' + gen(n.a, args) + n.o + gen(n.b, args) + ')';
      case 'fn': return 'F.' + n.n + '(' + gen(n.a[0], args) + ')';
      default: throw new Error('Cannot evaluate this');
    }
  }
  // Returns fn(scope, x, y, t, th, z)
  function compile(node, args = ['x', 'y', 't', 'θ', 'z']) {
    const body = gen(node, args);
    const f = new Function('S', 'F', 'x', 'y', 't', 'th', 'z', '"use strict"; return ' + body + ';');
    return (S, x, y, t, th, z) => f(S, F, x, y, t, th, z);
  }

  // ---- Simplifier ----
  const N = v => ({ t: 'num', v });
  const isNum = (n, v) => n && n.t === 'num' && (v === undefined || Math.abs(n.v - v) < 1e-12);
  function eq(a, b) { return JSON.stringify(strip(a)) === JSON.stringify(strip(b)); }
  function strip(n) { if (!n || typeof n !== 'object') return n; const o = {}; for (const k of Object.keys(n)) if (k !== 'lit' && k !== 'imp') o[k] = Array.isArray(n[k]) ? n[k].map(strip) : (typeof n[k] === 'object' ? strip(n[k]) : n[k]); return o; }

  function simplify(n) {
    if (!n) return n;
    if (n.t === 'num' || n.t === 'var' || n.t === 'const') return { t: n.t, v: n.v, n: n.n };
    if (n.t === 'group') return simplify(n.a);
    if (n.t === 'fn') {
      const args = n.a.map(simplify);
      if (n.n === 'ln' && args[0].t === 'const' && args[0].n === 'e') return N(1);
      if ((n.n === 'ln' || n.n === 'log') && isNum(args[0], 1)) return N(0);
      return { t: 'fn', n: n.n, a: args };
    }
    if (n.t === 'neg') {
      const a = simplify(n.a);
      if (a.t === 'num') return N(-a.v);
      if (a.t === 'neg') return a.a;
      if (a.t === 'op' && a.o === '*' && a.a.t === 'num') return simplify({ t: 'op', o: '*', a: N(-a.a.v), b: a.b });
      return { t: 'neg', a };
    }
    const a = simplify(n.a), b = simplify(n.b), o = n.o;
    if (a.t === 'num' && b.t === 'num') {
      if (o === '+') return N(a.v + b.v);
      if (o === '-') return N(a.v - b.v);
      if (o === '*') return N(a.v * b.v);
      if (o === '/' && b.v !== 0 && Number.isInteger(a.v / b.v)) return N(a.v / b.v);
      if (o === '^' && Number.isInteger(b.v) && Math.abs(b.v) < 20 && Number.isInteger(Math.pow(a.v, b.v))) return N(Math.pow(a.v, b.v));
    }
    switch (o) {
      case '+':
        if (isNum(a, 0)) return b;
        if (isNum(b, 0)) return a;
        if (b.t === 'neg') return simplify({ t: 'op', o: '-', a, b: b.a });
        if (b.t === 'num' && b.v < 0) return { t: 'op', o: '-', a, b: N(-b.v) };
        if (b.t === 'op' && b.o === '*' && b.a.t === 'num' && b.a.v < 0) return { t: 'op', o: '-', a, b: simplify({ t: 'op', o: '*', a: N(-b.a.v), b: b.b }) };
        if (eq(a, b)) return simplify({ t: 'op', o: '*', a: N(2), b: a });
        return { t: 'op', o, a, b };
      case '-':
        if (isNum(b, 0)) return a;
        if (isNum(a, 0)) return simplify({ t: 'neg', a: b });
        if (b.t === 'neg') return simplify({ t: 'op', o: '+', a, b: b.a });
        if (b.t === 'num' && b.v < 0) return { t: 'op', o: '+', a, b: N(-b.v) };
        if (eq(a, b)) return N(0);
        return { t: 'op', o, a, b };
      case '*':
        if (isNum(a, 0) || isNum(b, 0)) return N(0);
        if (isNum(a, 1)) return b;
        if (isNum(b, 1)) return a;
        if (isNum(a, -1)) return simplify({ t: 'neg', a: b });
        if (isNum(b, -1)) return simplify({ t: 'neg', a });
        if (b.t === 'num' && a.t !== 'num') return simplify({ t: 'op', o: '*', a: b, b: a });
        if (a.t === 'num' && b.t === 'op' && b.o === '*' && b.a.t === 'num') return simplify({ t: 'op', o: '*', a: N(a.v * b.a.v), b: b.b });
        if (a.t === 'neg') return simplify({ t: 'neg', a: { t: 'op', o: '*', a: a.a, b } });
        if (b.t === 'neg') return simplify({ t: 'neg', a: { t: 'op', o: '*', a, b: b.a } });
        if (eq(a, b)) return { t: 'op', o: '^', a, b: N(2) };
        if (a.t === 'op' && a.o === '/' && isNum(a.a, 1)) return simplify({ t: 'op', o: '/', a: b, b: a.b });
        if (b.t === 'op' && b.o === '/' && isNum(b.a, 1)) return simplify({ t: 'op', o: '/', a, b: b.b });
        if (a.t === 'num' && b.t === 'op' && b.o === '/' && b.a.t === 'num') return simplify({ t: 'op', o: '/', a: N(a.v * b.a.v), b: b.b });
        return { t: 'op', o, a, b };
      case '/':
        if (isNum(a, 0)) return N(0);
        if (isNum(b, 1)) return a;
        if (eq(a, b)) return N(1);
        if (a.t === 'neg') return simplify({ t: 'neg', a: { t: 'op', o: '/', a: a.a, b } });
        return { t: 'op', o, a, b };
      case '^':
        if (isNum(b, 0)) return N(1);
        if (isNum(b, 1)) return a;
        if (isNum(a, 0)) return N(0);
        if (isNum(a, 1)) return N(1);
        if (a.t === 'op' && a.o === '^' && a.b.t === 'num' && b.t === 'num') return { t: 'op', o: '^', a: a.a, b: N(a.b.v * b.v) };
        return { t: 'op', o, a, b };
    }
    return { t: 'op', o, a, b };
  }

  // ---- Derivative (d/dv); other variables are constants ----
  function d(n, v) {
    const D = x => d(x, v);
    const op = (o, a, b) => ({ t: 'op', o, a, b });
    const fn = (name, a) => ({ t: 'fn', n: name, a: [a] });
    switch (n.t) {
      case 'num': case 'const': return N(0);
      case 'var': return N(n.n === v ? 1 : 0);
      case 'group': return D(n.a);
      case 'neg': return { t: 'neg', a: D(n.a) };
      case 'op': {
        const { a, b } = n;
        if (n.o === '+' || n.o === '-') return op(n.o, D(a), D(b));
        if (n.o === '*') return op('+', op('*', D(a), b), op('*', a, D(b)));
        if (n.o === '/') return op('/', op('-', op('*', D(a), b), op('*', a, D(b))), op('^', b, N(2)));
        if (n.o === '^') {
          const bConst = !freeVars(b).has(v);
          const aConst = !freeVars(a).has(v);
          if (bConst) return op('*', op('*', b, op('^', a, op('-', b, N(1)))), D(a));
          if (aConst) return op('*', op('*', n, fn('ln', a)), D(b));
          return op('*', n, op('+', op('*', D(b), fn('ln', a)), op('/', op('*', b, D(a)), a)));
        }
        break;
      }
      case 'fn': {
        const u = n.a[0], du = D(u);
        const chain = g => op('*', g, du);
        switch (n.n) {
          case 'sin': return chain(fn('cos', u));
          case 'cos': return chain({ t: 'neg', a: fn('sin', u) });
          case 'tan': return chain(op('^', fn('sec', u), N(2)));
          case 'sec': return chain(op('*', fn('sec', u), fn('tan', u)));
          case 'csc': return chain({ t: 'neg', a: op('*', fn('csc', u), fn('cot', u)) });
          case 'cot': return chain({ t: 'neg', a: op('^', fn('csc', u), N(2)) });
          case 'asin': return chain(op('/', N(1), fn('sqrt', op('-', N(1), op('^', u, N(2))))));
          case 'acos': return chain({ t: 'neg', a: op('/', N(1), fn('sqrt', op('-', N(1), op('^', u, N(2))))) });
          case 'atan': return chain(op('/', N(1), op('+', N(1), op('^', u, N(2)))));
          case 'sinh': return chain(fn('cosh', u));
          case 'cosh': return chain(fn('sinh', u));
          case 'tanh': return chain(op('-', N(1), op('^', fn('tanh', u), N(2))));
          case 'ln': return chain(op('/', N(1), u));
          case 'log': return chain(op('/', N(1), op('*', u, fn('ln', N(10)))));
          case 'exp': return chain(fn('exp', u));
          case 'sqrt': return chain(op('/', N(1), op('*', N(2), fn('sqrt', u))));
          case 'abs': return chain(op('/', u, fn('abs', u)));
        }
        throw new Error('No derivative rule for ' + n.n);
      }
    }
    throw new Error('Cannot differentiate');
  }
  function derivative(node, v = 'x') {
    let s = simplify(d(node, v));
    for (let i = 0; i < 3; i++) s = simplify(s);
    return s;
  }

  // ---- Pretty printer (HTML) ----
  function fmt(v) {
    if (!isFinite(v)) return isNaN(v) ? 'undefined' : (v > 0 ? '∞' : '−∞');
    if (Math.abs(v) < 1e-12) return '0';
    if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v).replace('-', '−');
    const a = Math.abs(v);
    let s;
    if (a >= 1e6 || a < 1e-4) s = v.toExponential(3);
    else s = String(parseFloat(v.toPrecision(6)));
    return s.replace('-', '−');
  }
  const PREC = n => n.t === 'op' ? ({ '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 })[n.o] : n.t === 'neg' ? 1.5 : 5;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function pp(n, opt = {}) {
    const P = (c, min) => (PREC(c) < min || (c.t === 'num' && c.v < 0 && min > 1)) ? '(' + pp(c, opt) + ')' : pp(c, opt);
    const litWrap = (n, s) => (opt.litHtml && n.lit !== undefined) ? opt.litHtml(n, s) : s;
    switch (n.t) {
      case 'num': return litWrap(n, fmt(n.v));
      case 'var': return (opt.varHtml ? opt.varHtml(n.n) : '<i>' + esc(n.n) + '</i>');
      case 'const': return n.n === 'π' ? 'π' : '<i>e</i>';
      case 'group': return '(' + pp(n.a, opt) + ')';
      case 'neg': return '−' + P(n.a, 2);
      case 'tuple': return '(' + n.items.map(x => pp(x, opt)).join(', ') + ')';
      case 'fn': {
        const arg = pp(n.a[0], opt);
        if (n.n === 'sqrt') return '√(' + arg + ')';
        if (n.n === 'abs') return '|' + arg + '|';
        if (n.n === 'fact') return P(n.a[0], 5) + '!';
        return n.n + '(' + arg + ')';
      }
      case 'op': {
        const { a, b, o } = n;
        if (o === '+') {
          if (b.t === 'num' && b.v < 0) return pp(a, opt) + ' − ' + fmt(-b.v);
          return pp(a, opt) + ' + ' + P(b, 1.5);
        }
        if (o === '-') return pp(a, opt) + ' − ' + P(b, 2);
        if (o === '*') {
          const right = b.t === 'op' && b.o === '^' ? b.a : b;
          const juxt = (a.t === 'num' || a.t === 'var' || a.t === 'const' || (a.t === 'op' && a.o === '^' && a.a.t !== 'num')) &&
            (right.t === 'var' || right.t === 'const' || right.t === 'fn' || right.t === 'group' || (PREC(b) < 2 && b.t !== 'neg'));
          const left = a.t === 'num' ? pp(a, opt) : P(a, 2);
          const gap = (a.t === 'var' || a.t === 'const') && right.t === 'fn' ? '\u2009' : '';
          if (juxt && !(a.t === 'num' && b.t === 'num')) return left + gap + (PREC(b) < 2 ? '(' + pp(b, opt) + ')' : P(b, 2));
          return left + '·' + P(b, 2.5);
        }
        if (o === '/') return (a.t === 'num' ? pp(a, opt) : P(a, 2)) + '/' + P(b, 3);
        if (o === '^') return P(a, 5) + '<sup>' + pp(b, opt) + '</sup>';
      }
    }
    return '?';
  }
  // plain-text form (for re-parsing)
  function toText(n) {
    const P = (c, min) => PREC(c) < min ? '(' + toText(c) + ')' : toText(c);
    switch (n.t) {
      case 'num': return n.v < 0 ? '(' + n.v + ')' : String(n.v);
      case 'var': return n.n === 'θ' ? 'theta' : n.n;
      case 'const': return n.n === 'π' ? 'pi' : 'e';
      case 'group': return '(' + toText(n.a) + ')';
      case 'neg': return '-' + P(n.a, 2);
      case 'fn': return n.n + '(' + toText(n.a[0]) + ')';
      case 'tuple': return '(' + n.items.map(toText).join(', ') + ')';
      case 'op': return P(n.a, n.o === '^' ? 5 : PREC(n)) + ' ' + n.o + ' ' + P(n.b, n.o === '-' || n.o === '/' ? PREC(n) + 0.5 : (n.o === '^' ? 4 : PREC(n)));
    }
  }

  // ---- Numeric helpers ----
  function simpson(f, a, b, n = 400) {
    if (a === b) return 0;
    if (n % 2) n++;
    const h = (b - a) / n;
    let s = f(a) + f(b);
    for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * f(a + i * h);
    return s * h / 3;
  }
  function roots(g, lo = -50, hi = 50, steps = 4000) {
    const out = [];
    const h = (hi - lo) / steps;
    let x0 = lo, y0 = g(x0);
    for (let i = 1; i <= steps; i++) {
      const x1 = lo + i * h, y1 = g(x1);
      if (isFinite(y0) && isFinite(y1)) {
        if (y0 === 0) out.push(x0);
        else if (y0 * y1 < 0) {
          let a = x0, b = x1, fa = y0;
          for (let k = 0; k < 60; k++) { const m = (a + b) / 2, fm = g(m); if (fa * fm <= 0) b = m; else { a = m; fa = fm; } }
          const r = (a + b) / 2;
          if (Math.abs(g(r)) < 1e-6 * Math.max(1, Math.abs(y0) + Math.abs(y1))) out.push(r);
        }
      }
      x0 = x1; y0 = y1;
    }
    const ded = [];
    for (const r of out) if (!ded.some(q => Math.abs(q - r) < 1e-7)) ded.push(Math.abs(r) < 1e-10 ? 0 : r);
    return ded;
  }

  return { normalize, tokenize, parse, splitTop, freeVars, compile, derivative, simplify, pp, toText, fmt, simpson, roots, F };
})();

/* ===== Statement analysis: decides graph type / arithmetic / solve ===== */
function analyzeStatement(rawExpr) {
  const ME = MathEngine;
  const src = ME.normalize(rawExpr);
  const res = { src, kind: 'unknown' };
  const RESERVED = new Set(['x', 'y', 'z', 'r', 't', 'θ']);
  const params = new Set();
  const addParams = (n, exclude) => { for (const v of ME.freeVars(n)) if (!exclude.includes(v)) params.add(v); };
  try {
    // Shapes drawn on a 3D graph: sphere(r), ellipsoid(a, c), hemisphere(r), cube(s), box(a, b, c), cylinder(r, h), cone(r, h), vcone(r, h),
    // dcone(r, h), paraboloid(r, h), dome(r, h), hyperboloid(a, c, h), hyperboloidtwo(a, c, h), saddle(k, s), tetra(a, b, c)
    const sm = src.match(/^(sphere|ellipsoid|hemisphere|cube|box|cylinder|cone|vcone|dcone|paraboloid|dome|hyperboloid|hyperboloidtwo|saddle|tetra)\s*\(([^()]*)\)$/i);
    if (sm) {
      const type = sm[1].toLowerCase(), args = ME.splitTop(sm[2], ',').map(a => ME.parse(a.trim()));
      const need = { sphere: 1, ellipsoid: 2, hemisphere: 1, cube: 1, box: 3, cylinder: 2, cone: 2, vcone: 2, dcone: 2, paraboloid: 2, dome: 2, hyperboloid: 3, hyperboloidtwo: 3, saddle: 2, tetra: 3 }[type];
      if (args.length !== need) throw new Error(`${type} needs ${need} number${need > 1 ? 's' : ''}`);
      res.kind = 'solid'; res.solid = type; res.args = args; args.forEach(a => addParams(a, [])); res.params = [...params]; return res;
    }
    // Parametric: "x = f(t), y = g(t)" or "(f(t), g(t))"
    const commaParts = ME.splitTop(src, ',');
    if (commaParts.length === 3 && commaParts.every(p => /=/.test(p))) {
      const defs = {};
      for (const part of commaParts) { const [l, r] = ME.splitTop(part, '='); const lhs = l.trim(); if (['x', 'y', 'z'].includes(lhs)) defs[lhs] = ME.parse(r); }
      if (defs.x && defs.y && defs.z) {
        res.kind = 'curve3d'; res.fx = defs.x; res.fy = defs.y; res.fz = defs.z;
        [defs.x, defs.y, defs.z].forEach(n => addParams(n, ['t'])); res.params = [...params]; return res;
      }
    }
    if (commaParts.length === 2 && commaParts.every(p => /=/.test(p))) {
      const defs = {};
      for (const part of commaParts) {
        const [l, r] = ME.splitTop(part, '=');
        const lhs = l.trim();
        if (lhs === 'x' || lhs === 'y') defs[lhs] = ME.parse(r);
      }
      if (defs.x && defs.y) {
        res.kind = 'parametric'; res.fx = defs.x; res.fy = defs.y;
        addParams(defs.x, ['t']); addParams(defs.y, ['t']);
        res.params = [...params]; return res;
      }
    }
    const sides = ME.splitTop(src, '=');
    if (sides.length > 2) throw new Error('Too many "=" signs');
    if (sides.length === 2 && sides[1].trim() === '') {
      // Arithmetic with trailing "="
      const lhs = ME.parse(sides[0]);
      const fv = [...ME.freeVars(lhs)];
      if (fv.some(v => ['x', 'y', 'z', 'r', 't', 'θ'].includes(v))) { res.kind = 'incomplete'; return res; }
      res.kind = 'evaluate'; res.lhs = lhs; fv.forEach(v => params.add(v)); res.params = [...params]; return res;
    }
    if (sides.length === 1) {
      const node = ME.parse(sides[0]);
      if (node.t === 'tuple' && node.items.length === 3) {
        res.kind = 'curve3d'; res.fx = node.items[0]; res.fy = node.items[1]; res.fz = node.items[2];
        addParams(node, ['t']); res.params = [...params]; return res;
      }
      if (node.t === 'tuple' && node.items.length === 2) {
        res.kind = 'parametric'; res.fx = node.items[0]; res.fy = node.items[1];
        addParams(node, ['t']); res.params = [...params]; return res;
      }
      const fv = ME.freeVars(node);
      if (fv.has('x') && !fv.has('y')) { res.kind = 'function'; res.f = node; res.name = 'y'; addParams(node, ['x']); res.params = [...params]; return res; }
      if (!fv.size || [...fv].every(v => !RESERVED.has(v))) { res.kind = 'value'; res.lhs = node; fv.forEach(v => params.add(v)); res.params = [...params]; return res; }
      res.kind = 'unknown'; res.error = 'Not sure how to graph this'; return res;
    }
    let L = sides[0].trim(), R = sides[1].trim();
    // f(x) = ...
    const fdef2 = L.match(/^([a-zA-Z])\s*\(\s*x\s*,\s*y\s*\)$/);
    if (fdef2) { const f = ME.parse(R); res.kind = 'surface'; res.f = f; res.name = fdef2[1] + '(x, y)'; addParams(f, ['x', 'y']); res.params = [...params]; return res; }
    const fdef = L.match(/^([a-zA-Z])\s*\(\s*x\s*\)$/);
    if (fdef) { const f = ME.parse(R); res.kind = 'function'; res.f = f; res.name = fdef[1] + '(x)'; addParams(f, ['x']); res.params = [...params]; return res; }
    let lhs = ME.parse(L), rhs = ME.parse(R);
    // swap "2x + 1 = y"
    if (rhs.t === 'var' && ['y', 'r', 'z'].includes(rhs.n) && !(lhs.t === 'var')) { [lhs, rhs] = [rhs, lhs]; }
    const fvR = ME.freeVars(rhs), fvL = ME.freeVars(lhs);
    if (lhs.t === 'var' && lhs.n === 'y' && !fvR.has('y')) {
      if (fvR.has('x') || ![...fvR].some(v => RESERVED.has(v))) { res.kind = 'function'; res.f = rhs; res.name = 'y'; addParams(rhs, ['x']); res.params = [...params]; return res; }
    }
    if (lhs.t === 'var' && lhs.n === 'r' && !fvR.has('r') && !fvR.has('x') && !fvR.has('y')) {
      const th = fvR.has('θ') ? 'θ' : 't';
      res.kind = 'polar'; res.f = rhs; res.tvar = th; addParams(rhs, ['θ', 't']); res.params = [...params];
      res.nonTrigTheta = usesOutsideTrig(rhs, th); return res;
    }
    if (lhs.t === 'var' && lhs.n === 'z' && !fvR.has('z') && !fvR.has('t') && !fvR.has('θ') && !fvR.has('r')) {
      res.kind = 'surface'; res.f = rhs; addParams(rhs, ['x', 'y']); res.params = [...params]; return res;
    }
    // assignment: a = 3
    if (lhs.t === 'var' && !RESERVED.has(lhs.n) && ![...fvR].some(v => RESERVED.has(v))) {
      res.kind = 'assign'; res.name = lhs.n; res.rhs = rhs; fvR.forEach(v => params.add(v)); res.params = [...params]; return res;
    }
    const all = new Set([...fvL, ...fvR]);
    const diff = { t: 'op', o: '-', a: lhs, b: rhs };
    if (all.has('z') && (all.has('x') || all.has('y'))) { res.kind = 'implicit3d'; res.g = diff; addParams(diff, ['x', 'y', 'z']); res.params = [...params]; return res; }
    if (all.has('x') && all.has('y')) { res.kind = 'implicit'; res.g = diff; addParams(diff, ['x', 'y']); res.params = [...params]; return res; }
    const solveVars = [...all].filter(v => !params.has(v) && (v === 'x' || v === 't' || v === 'θ' || v === 'y'));
    if (solveVars.length === 1) {
      res.kind = 'solve'; res.g = diff; res.v = solveVars[0]; addParams(diff, [solveVars[0]]); res.params = [...params]; return res;
    }
    if (![...all].some(v => RESERVED.has(v))) {
      res.kind = 'check'; res.lhs = lhs; res.rhs = rhs; all.forEach(v => params.add(v)); res.params = [...params]; return res;
    }
    res.kind = 'unknown'; res.error = 'Not sure how to graph this';
  } catch (e) { res.kind = 'error'; res.error = e.message; }
  return res;
}
function usesOutsideTrig(n, v, inTrig = false) {
  if (!n) return false;
  if (n.t === 'var') return n.n === v && !inTrig;
  if (n.t === 'fn') return n.a.some(a => usesOutsideTrig(a, v, inTrig || ['sin', 'cos', 'tan', 'sec', 'csc', 'cot'].includes(n.n)));
  if (n.t === 'op') return usesOutsideTrig(n.a, v, inTrig) || usesOutsideTrig(n.b, v, inTrig);
  if (n.t === 'neg' || n.t === 'group') return usesOutsideTrig(n.a, v, inTrig);
  return false;
}
if (typeof module !== 'undefined') module.exports = { MathEngine, analyzeStatement };
