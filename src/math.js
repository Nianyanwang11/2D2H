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
      if (n.n === 'sqrt' && args[0].t === 'num' && args[0].v >= 0 && Number.isInteger(Math.sqrt(args[0].v))) return N(Math.sqrt(args[0].v));
      if (n.n === 'ln' && args[0].t === 'num' && args[0].v === 1) return N(0);
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
        if (b.t === 'op' && b.o === '*' && b.a.t === 'num' && b.a.v < 0) return simplify({ t: 'op', o: '+', a, b: { t: 'op', o: '*', a: N(-b.a.v), b: b.b } });
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

/* ===== Functions written on the page: f(x) = …, f(x, y) = …, g(t) = …, r(θ) = … =====
   Once a function is defined, every other line can use it: "f(2) =", "f(1, 2) =", "z = f(x, y)", "y = f(x) + 1". */
const FDEF_RE = /^\s*([a-zA-Z])\s*\(\s*([a-zA-Zθ](?:\s*,\s*[a-zA-Zθ]){0,2})\s*\)\s*=(.*)$/;
function parseFnDef(raw) {
  const m = MathEngine.normalize(raw || '').match(FDEF_RE); if (!m) return null;
  const name = m[1], vars = m[2].split(',').map(s => s.trim()), body = m[3].trim();
  if (!body || name === 'e' || vars.includes(name) || new Set(vars).size !== vars.length) return null;
  return { name, vars, body };
}
// replace whole-variable tokens at once (so f(y, x) can swap them)
function substVars(src, vars, repl) {
  const s = MathEngine.normalize(src), toks = MathEngine.tokenize(s);
  let out = '', last = 0;
  for (const t of toks) { const k = t.type === 'var' ? vars.indexOf(t.name) : -1; if (k < 0) continue; out += s.slice(last, t.start) + '(' + repl[k] + ')'; last = t.end; }
  return out + s.slice(last);
}
function expandFnCalls(src, fns, depth = 0) {
  if (depth > 5) throw new Error('A function is defined in terms of itself');
  const s = MathEngine.normalize(src);
  let toks; try { toks = MathEngine.tokenize(s); } catch (e) { return s; }
  let out = '', last = 0, changed = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], F = t.type === 'var' && fns[t.name], nx = toks[i + 1];
    if (!F || !nx || nx.type !== 'op' || nx.v !== '(') continue;
    let d = 0, j = i + 1;
    for (; j < toks.length; j++) { const q = toks[j]; if (q.type === 'op' && q.v === '(') d++; else if (q.type === 'op' && q.v === ')' && --d === 0) break; }
    if (j >= toks.length) continue;
    const args = MathEngine.splitTop(s.slice(nx.end, toks[j].start), ',').map(a => a.trim());
    if (args.some(a => !a)) continue;
    if (args.length !== F.vars.length) throw new Error(`${t.name} takes ${F.vars.length} value${F.vars.length > 1 ? 's' : ''}: ${t.name}(${F.vars.join(', ')})`);
    const body = substVars(F.body, F.vars, args.map(a => expandFnCalls(a, fns, depth + 1)));
    out += s.slice(last, t.start) + '(' + expandFnCalls(body, fns, depth + 1) + ')';
    last = toks[j].end; i = j; changed = true;
  }
  return changed ? out + s.slice(last) : s;
}

/* ===== Calculus written by hand: derivatives, integrals, limits =====
   The reader writes them as diff(e, x), d/dx(e), f'(x), f''(2), f_x(1, 2), int(e, x), int(e, x, a, b),
   lim(e, x, a), liml / limr (from the left / right), lim(e, (x, y), (a, b)). They are worked out here and
   replaced by plain math: a formula (2*x) or a number (1/3), so the rest of the app treats them like any line. */
const Calc = (() => {
  const ME = MathEngine, N = v => ({ t: 'num', v }), op = (o, a, b) => ({ t: 'op', o, a, b }), fn = (n, a) => ({ t: 'fn', n, a: [a] }), neg = a => ({ t: 'neg', a });
  const V = n => ({ t: 'var', n });
  const S = n => { let s = ME.simplify(n); for (let i = 0; i < 3; i++) s = ME.simplify(s); return s; };
  const has = (n, v) => ME.freeVars(n).has(v);
  const fail = () => new Error('No formula found');
  // run a compiled expression with named values (x, y, t, θ, z go by position; any other letter by name)
  const run = (g, vals) => g(vals, vals.x, vals.y, vals.t, vals['θ'], vals.z);
  const isE = n => n.t === 'const' && n.n === 'e';
  const lin = (u, v) => { try { const a = ME.derivative(u, v); return has(a, v) ? null : a; } catch (e) { return null; } };
  function polyDeg(n, v) { let d = n; for (let k = 0; k <= 8; k++) { if (!has(d, v)) return k; try { d = ME.derivative(d, v); } catch (e) { return -1; } } return -1; }
  // c·v^k terms with numeric c and k (polynomials, 1/x², √x …), or null
  function mono(n, v) {
    const one = (k, c) => new Map([[k, c]]);
    const add = (A, B, sg) => { const M = new Map(A); for (const [k, c] of B) M.set(k, (M.get(k) || 0) + sg * c); return M; };
    const mul = (A, B) => { const M = new Map(); for (const [i, a] of A) for (const [j, b] of B) M.set(i + j, (M.get(i + j) || 0) + a * b); return M; };
    switch (n.t) {
      case 'num': return one(0, n.v);
      case 'const': return one(0, n.n === 'π' ? Math.PI : Math.E);
      case 'var': return n.n === v ? one(1, 1) : null;
      case 'group': return mono(n.a, v);
      case 'neg': { const A = mono(n.a, v); return A && add(new Map(), A, -1); }
      case 'op': {
        const A = mono(n.a, v); if (!A) return null;
        if (n.o === '^') { if (n.b.t !== 'num') return null; const e = n.b.v; if (A.size === 1) { const [[k, c]] = [...A]; if (c < 0 && !Number.isInteger(e)) return null; return one(k * e, Math.pow(c, e)); } if (Number.isInteger(e) && e >= 0 && e <= 8) { let M = one(0, 1); for (let i = 0; i < e; i++) M = mul(M, A); return M; } return null; }
        const B = mono(n.b, v); if (!B) return null;
        if (n.o === '+' || n.o === '-') return add(A, B, n.o === '+' ? 1 : -1);
        if (n.o === '*') return mul(A, B);
        if (n.o === '/') { if (B.size !== 1) return null; const [[k, c]] = [...B]; if (!c) return null; return mul(A, one(-k, 1 / c)); }
        return null;
      }
      case 'fn': if (n.n === 'sqrt') { const A = mono(n.a[0], v); if (A && A.size === 1) { const [[k, c]] = [...A]; if (c >= 0) return one(k / 2, Math.sqrt(c)); } } return null;
    }
    return null;
  }
  function I(n, v, depth = 0) {
    if (depth > 14) throw fail();
    n = S(n);
    if (!has(n, v)) return op('*', n, V(v));
    const M = mono(n, v);
    if (M) {
      let out = null;
      for (const [k, c] of [...M].sort((a, b) => b[0] - a[0])) {
        if (!c) continue;
        const t = Math.abs(k + 1) < 1e-12 ? op('*', N(c), fn('ln', fn('abs', V(v)))) : op('*', N(c / (k + 1)), op('^', V(v), N(k + 1)));
        out = out ? op('+', out, t) : t;
      }
      return out || N(0);
    }
    switch (n.t) {
      case 'neg': return neg(I(n.a, v, depth + 1));
      case 'group': return I(n.a, v, depth);
      case 'op': {
        const { a, b, o } = n;
        if (o === '+' || o === '-') return op(o, I(a, v, depth + 1), I(b, v, depth + 1));
        if (o === '*') {
          if (!has(a, v)) return op('*', a, I(b, v, depth + 1));
          if (!has(b, v)) return op('*', b, I(a, v, depth + 1));
          // p·ln(u): the logarithm is the part to differentiate
          for (const [p, g] of [[a, b], [b, a]]) if (g.t === 'fn' && g.n === 'ln' && polyDeg(p, v) >= 0) { const A = lin(g.a[0], v); if (A) { const P = I(p, v, depth + 1); return op('-', op('*', P, g), I(op('/', op('*', P, A), g.a[0]), v, depth + 1)); } }
          // by parts, differentiating the polynomial factor until it's gone
          for (const [p, g] of [[a, b], [b, a]]) { const dg = polyDeg(p, v); if (dg > 0 && dg <= 6) { try { const G = I(g, v, depth + 1); return op('-', op('*', p, G), I(op('*', ME.derivative(p, v), G), v, depth + 1)); } catch (e) { } } }
          throw fail();
        }
        if (o === '/') {
          if (!has(b, v)) return op('/', I(a, v, depth + 1), b);
          if (!has(a, v)) {
            const A = lin(b, v); if (A) return op('*', op('/', a, A), fn('ln', fn('abs', b)));
            if (b.t === 'op' && b.o === '+') for (const [c, w] of [[b.a, b.b], [b.b, b.a]]) if (!has(c, v) && w.t === 'op' && w.o === '^' && w.b.t === 'num' && w.b.v === 2) { const A2 = lin(w.a, v); if (A2) { const r = fn('sqrt', c); return op('*', op('/', a, op('*', A2, r)), fn('atan', op('/', w.a, r))); } }
            if (b.t === 'fn' && b.n === 'sqrt') { const q = b.a[0]; if (q.t === 'op' && q.o === '-' && !has(q.a, v) && q.b.t === 'op' && q.b.o === '^' && q.b.b.t === 'num' && q.b.b.v === 2) { const A2 = lin(q.b.a, v); if (A2) return op('*', op('/', a, A2), fn('asin', op('/', q.b.a, fn('sqrt', q.a)))); } return I(op('*', a, op('^', q, N(-0.5))), v, depth + 1); }
            if (b.t === 'op' && b.o === '^' && !has(b.b, v)) return I(op('*', a, op('^', b.a, neg(b.b))), v, depth + 1);
          }
          if (b.t === 'var' || (b.t === 'op' && b.o === '^' && !has(b.b, v))) return I(op('*', a, b.t === 'var' ? op('^', b, N(-1)) : op('^', b.a, neg(b.b))), v, depth + 1);
          throw fail();
        }
        if (o === '^') {
          if (!has(b, v)) {
            if (a.t === 'fn' && b.t === 'num' && b.v === 2) { const A = lin(a.a[0], v); if (A && a.n === 'sec') return op('/', fn('tan', a.a[0]), A); if (A && a.n === 'csc') return neg(op('/', fn('cot', a.a[0]), A)); }
            const A = lin(a, v);
            if (!A) { if (b.t === 'num' && Number.isInteger(b.v) && b.v >= 2 && b.v <= 6) { let e = a; for (let i = 1; i < b.v; i++) e = op('*', e, a); return I(e, v, depth + 1); } throw fail(); }
            if (b.t === 'num' && b.v === -1) return op('/', fn('ln', fn('abs', a)), A);
            const n1 = S(op('+', b, N(1))); return op('/', op('^', a, n1), op('*', A, n1));
          }
          if (!has(a, v)) { const A = lin(b, v); if (!A) throw fail(); return op('/', n, isE(a) ? A : op('*', A, fn('ln', a))); }
          throw fail();
        }
        break;
      }
      case 'fn': {
        const u = n.a[0], A = lin(u, v); if (!A) throw fail();
        const R = r => op('/', r, A);
        switch (n.n) {
          case 'sin': return R(neg(fn('cos', u)));
          case 'cos': return R(fn('sin', u));
          case 'exp': return R(n);
          case 'tan': return R(neg(fn('ln', fn('abs', fn('cos', u)))));
          case 'sec': return R(fn('ln', fn('abs', op('+', fn('sec', u), fn('tan', u)))));
          case 'sinh': return R(fn('cosh', u));
          case 'cosh': return R(fn('sinh', u));
          case 'ln': return R(op('-', op('*', u, fn('ln', u)), u));
          case 'sqrt': return R(op('*', N(2 / 3), op('^', u, N(1.5))));
        }
        throw fail();
      }
    }
    throw fail();
  }
  // a formula is only kept if its derivative really gives back the integrand (checked at a few points)
  const PROBE = [0.37, 1.13, 1.71, 2.29, 0.61];
  function checked(F, f, v) {
    const dF = ME.compile(ME.derivative(F, v)), g = ME.compile(f), others = [...new Set([...ME.freeVars(f), ...ME.freeVars(F)])].filter(x => x !== v);
    let ok = 0;
    for (let i = 0; i < PROBE.length; i++) {
      const sc = {}; others.forEach((o, j) => { sc[o] = 0.83 + 0.29 * j + 0.11 * i; }); sc[v] = PROBE[i];
      let a, b; try { a = run(dF, sc); b = run(g, sc); } catch (e) { continue; }
      if (!isFinite(a) || !isFinite(b)) continue;
      if (Math.abs(a - b) > 1e-6 * Math.max(1, Math.abs(b))) return false;
      ok++;
    }
    return ok >= 2;
  }
  function antiderivative(f, v) { const F = S(I(f, v)); if (!checked(F, f, v)) throw fail(); return F; }
  const subst = (node, v, by) => {
    const walk = n => { if (!n || typeof n !== 'object') return n; if (n.t === 'var' && n.n === v) return by; const o = Array.isArray(n) ? [] : {}; for (const k in n) o[k] = Array.isArray(n[k]) ? n[k].map(walk) : (n[k] && typeof n[k] === 'object' ? walk(n[k]) : n[k]); return o; };
    return walk(node);
  };
  // numbers come out as the cleanest form: 1/3, 3*pi/4, 1/0 (∞)
  function numText(x) {
    if (x === Infinity) return '(1/0)';
    if (x === -Infinity) return '(-1/0)';
    if (!isFinite(x)) return '(0/0)';
    if (Math.abs(x) < 1e-12) return '0';
    const frac = y => { for (let q = 1; q <= 400; q++) { const p = Math.round(y * q); if (Math.abs(p / q - y) < 1e-9 * Math.max(1, Math.abs(y))) return [p, q]; } return null; };
    let r = frac(x); if (r) return r[1] === 1 ? `(${r[0]})` : `(${r[0]}/${r[1]})`;
    r = frac(x / Math.PI); if (r && r[1] <= 12 && Math.abs(r[0]) <= 24) return `(${r[0] === 1 ? '' : r[0] === -1 ? '-' : r[0] + '*'}pi${r[1] === 1 ? '' : '/' + r[1]})`;
    return '(' + String(+x.toPrecision(12)) + ')';
  }
  const bound = t => { const s = t.replace(/\s+/g, ''); if (/^\+?(inf|∞|infinity)$/i.test(s)) return Infinity; if (/^-(inf|∞|infinity)$/i.test(s)) return -Infinity; return null; };
  // numeric limit of a one-variable function at a (±∞ allowed), from one side or both
  function limit1(g, a, side, ctx) {
    const seq = s => { const out = []; for (let k = 2; k <= 8; k++) { const h = Math.pow(10, -k), x = a === Infinity ? Math.pow(10, k) : a === -Infinity ? -Math.pow(10, k) : a + s * h; let y; try { y = g(x); } catch (e) { y = NaN; } out.push(y); } return out; };
    const settle = ys => {
      const f = ys.filter(y => !isNaN(y)); if (f.length < 3) return NaN;
      const t = f.slice(-4);
      const grows = t.every((y, i) => !i || Math.abs(y) > 2.5 * Math.abs(t[i - 1])) && Math.abs(t[t.length - 1]) > 1e4;
      if ((grows || t.every(y => y > 1e7)) && t.every(y => y > 0)) return Infinity;
      if ((grows || t.every(y => y < -1e7)) && t.every(y => y < 0)) return -Infinity;
      const L = t[t.length - 1], spread = Math.max(...t.slice(-3)) - Math.min(...t.slice(-3));
      if (!isFinite(L) || spread > 1e-3 * Math.max(1, Math.abs(L))) return NaN;
      return Math.abs(L - Math.round(L)) < 1e-6 ? Math.round(L) : L;
    };
    if (!isFinite(a)) return settle(seq(1));
    const R = side >= 0 ? settle(seq(1)) : null, L = side <= 0 ? settle(seq(-1)) : null;
    if (side > 0) return R;
    if (side < 0) return L;
    const same = (p, q) => (p === q) || (isFinite(p) && isFinite(q) && Math.abs(p - q) < 1e-5 * Math.max(1, Math.abs(p)));
    if (same(L, R)) return R;
    if (ctx) ctx.note = `from the left it goes to ${ME.fmt(L)}, from the right to ${ME.fmt(R)}`;
    return NaN;
  }
  // two variables: the limit has to agree along every path tried (lines, a parabola)
  function limit2(g, a, b, ctx) {
    const paths = [[1, 0], [0, 1], [1, 1], [1, -1], [1, 2], [2, -1], ['p', 1]];
    let val = null;
    for (const [m, k] of paths) {
      const h = m === 'p' ? t => g(a + t, b + t * t) : t => g(a + m * t, b + k * t);
      let probe = 0; for (let k = 2; k <= 8; k++) { let y; try { y = h(Math.pow(10, -k)); } catch (e) { y = NaN; } if (!isNaN(y)) probe++; }
      if (!probe) continue;   // the function isn't defined along this path (y = x for (x² − y²)/(x − y))
      const L = limit1(h, 0, 0);
      if (isNaN(L)) { if (ctx) ctx.note = 'it has no single value along one of the paths'; return NaN; }
      if (val === null) val = L;
      else if (!(val === L || (isFinite(val) && isFinite(L) && Math.abs(val - L) < 1e-5 * Math.max(1, Math.abs(val))))) { if (ctx) ctx.note = `along different paths it goes to ${ME.fmt(val)} and ${ME.fmt(L)}`; return NaN; }
    }
    return val;
  }
  const evalNum = t => { const v = ME.compile(ME.parse(t))({}, 0); if (!isFinite(v)) throw new Error(`the point or bound “${t}” must be a number`); return v; };
  // formulas as written by hand: x^3/3 instead of 0.3333*x^3, no spaces
  // (fifths and tenths stay decimals: 9.8t, not 49t/5)
  function frac(y) { for (let q = 1; q <= 100; q++) { if (q % 5 === 0) continue; const p = Math.round(y * q); if (Math.abs(p / q - y) < 1e-9 * Math.max(1, Math.abs(y))) return [p, q]; } return null; }
  function tidy(n) {
    if (!n || typeof n !== 'object') return n;
    if (n.t === 'op' && n.o === '*' && n.a.t === 'num' && !Number.isInteger(n.a.v)) { const r = frac(n.a.v); if (r) { const top = Math.abs(r[0]) === 1 ? tidy(n.b) : op('*', N(Math.abs(r[0])), tidy(n.b)), q = op('/', top, N(r[1])); return r[0] < 0 ? neg(q) : q; } }
    if (n.t === 'num' && !Number.isInteger(n.v)) { const r = frac(n.v); if (r && r[1] <= 100) return r[0] < 0 ? neg(op('/', N(-r[0]), N(r[1]))) : op('/', N(r[0]), N(r[1])); }
    const o = Array.isArray(n) ? [] : {}; for (const k in n) o[k] = Array.isArray(n[k]) ? n[k].map(tidy) : (n[k] && typeof n[k] === 'object' ? tidy(n[k]) : n[k]); return o;
  }
  // (x²/2)·y² → x²y²/2: the fraction bar goes last, so the handwriting can't be read as x²/(2y²)
  function divLast(n) {
    if (!n || typeof n !== 'object') return n;
    const o = Array.isArray(n) ? [] : {}; for (const k in n) o[k] = Array.isArray(n[k]) ? n[k].map(divLast) : (n[k] && typeof n[k] === 'object' ? divLast(n[k]) : n[k]);
    if (o.t === 'op' && o.o === '*') {
      if (o.a.t === 'op' && o.a.o === '/' && o.a.b.t === 'num') return op('/', divLast(op('*', o.a.a, o.b)), o.a.b);
      if (o.b.t === 'op' && o.b.o === '/' && o.b.b.t === 'num') return op('/', divLast(op('*', o.a, o.b.a)), o.b.b);
    }
    return o;
  }
  const text = n => ME.toText(divLast(tidy(n))).replace(/\s+/g, '').replace(/\+-/g, '-').replace(/-\(-/g, '+(');
  return { antiderivative, subst, numText, bound, limit1, limit2, S, has, evalNum, V, op, run, text, frac };
})();
const CALC_RE = /(diff|int|liml|limr|lim)\s*\(|[a-zA-Z]'+\s*\(|[a-zA-Z]_[a-z]+\s*\(|\bd\s*\^?\s*\d*\s*\/\s*d\s*[a-z]/;
function calcExpand(src, fns, ctx, depth = 0) {
  const ME = MathEngine;
  if (depth > 8) throw new Error('Too deeply nested');
  let s = String(src).replace(/[′’]/g, "'").replace(/″/g, "''").replace(/∞/g, 'inf').replace(/∂/g, 'd');
  // d/dx(…), d^2/dx^2(…) → diff(…, x, x)
  for (let guard = 0; guard < 12; guard++) {
    const m = s.match(/\bd\s*\^?\s*(\d*)\s*\/\s*d\s*([a-z])\s*\^?\s*\d*\s*\(/); if (!m) break;
    const i = m.index, open = i + m[0].length - 1; let d = 0, j = open;
    for (; j < s.length; j++) { if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) break; }
    if (j >= s.length) throw new Error('A "(" is missing its ")"');
    s = s.slice(0, i) + 'diff(' + s.slice(open + 1, j) + ', ' + Array(Math.max(1, +m[1] || 1)).fill(m[2]).join(', ') + ')' + s.slice(j + 1);
  }
  const head = /(diff|int|liml|limr|lim)\s*\(|([a-zA-Z])('+)\s*\(|([a-zA-Z])_([a-z]+)\s*\(/g;
  let out = '', last = 0, m;
  while ((m = head.exec(s))) {
    const i = m.index;
    if (i > 0 && /[a-zA-Z]/.test(s[i - 1])) continue;   // part of a longer name
    const open = i + m[0].length - 1; let d = 0, j = open;
    for (; j < s.length; j++) { if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) break; }
    if (j >= s.length) throw new Error('A "(" is missing its ")"');
    const raw = ME.splitTop(s.slice(open + 1, j), ',').map(a => a.trim());
    const prep = a => expandFnCalls(calcExpand(a, fns, ctx, depth + 1), fns);
    // the variable, when it wasn't written: the only one there is, or the one picked in the menu
    const pick = (vars, op) => {
      if (vars.length <= 1) return vars[0] || 'x';
      ctx.pos = ctx.pos || 0; const w = (ctx.wrt || '')[ctx.pos];
      if (w && vars.includes(w)) { ctx.pos++; return w; }
      const e = new Error('Choose the variable'); e.choose = { vars, op, step: ctx.pos + 1, done: (ctx.wrt || '').slice(0, ctx.pos) }; throw e;
    };
    const varsOf = t => { const fv = ME.freeVars(ME.parse(t)); const vs = ['x', 'y', 'z', 't'].filter(v => fv.has(v)); return vs.length ? vs : ['x']; };
    let rep;
    if (m[1] === 'diff') {
      if (raw.length < 2) { const e0 = prep(raw[0]); raw.push(pick(varsOf(e0), 'diff')); raw[0] = e0; }
      let node = ME.parse(prep(raw[0])), lastV = null;
      for (const a of raw.slice(1)) {
        if (/^\d+$/.test(a)) { for (let k = 1; k < +a; k++) node = ME.derivative(node, lastV); continue; }
        if (!/^[a-zθ]$/.test(a)) throw new Error('Differentiate with respect to a letter, like x');
        node = ME.derivative(node, a); lastV = a;
      }
      rep = '(' + ME.toText(Calc.S(node)) + ')'; ctx.calc = ctx.calc || 'derivative';
    } else if (m[1] === 'int') {
      if (raw.length === 1 || raw.length === 3) { const e0 = prep(raw[0]); raw.splice(1, 0, pick(varsOf(e0), 'int')); raw[0] = e0; }
      if (raw.length !== 2 && raw.length !== 4) throw new Error('An integral needs its variable, and both bounds for a definite one');
      const v = raw[1]; if (!/^[a-zθ]$/.test(v)) throw new Error('Integrate with respect to a letter, like x');
      const f = ME.parse(prep(raw[0]));
      let F = null; try { F = Calc.antiderivative(f, v); } catch (e) { F = null; }
      if (raw.length === 2) { if (!F) throw new Error('No formula found for this integral (a definite one, with bounds, can still be worked out)'); rep = '(' + ME.toText(F) + ')'; ctx.calc = 'integral'; ctx.plusC = true; }
      else {
        const [A, B] = [raw[2], raw[3]].map(t => { const b = Calc.bound(t); return b != null ? b : null; });
        const atB = (t, inf) => {
          if (inf != null) {   // F at ±∞: its limit
            if (!F) throw new Error('No formula found for this integral');
            const others = [...ME.freeVars(F)].filter(x => x !== v); if (others.length) throw new Error('An infinite bound needs a numeric integrand');
            const g = ME.compile(F), L = Calc.limit1(x => Calc.run(g, { [v]: x }), inf, 0); if (!isFinite(L)) throw new Error('This integral diverges');
            return { t: 'num', v: L };
          }
          return Calc.subst(F, v, ME.parse(prep(t)));
        };
        if (F) {
          const val = Calc.S(Calc.op('-', atB(raw[3], B), atB(raw[2], A)));
          const fv = ME.freeVars(val);
          rep = fv.size ? '(' + ME.toText(val) + ')' : Calc.numText(ME.compile(val)({}, 0));
        } else {
          const others = [...ME.freeVars(f)].filter(x => x !== v);
          if (others.length || A != null || B != null) throw new Error('No formula found for this integral');
          const a = Calc.evalNum(prep(raw[2])), b = Calc.evalNum(prep(raw[3])), g = ME.compile(f);
          const val = ME.simpson(x => Calc.run(g, { [v]: x }), a, b, 4000);
          if (!isFinite(val)) throw new Error('This integral has no finite value');
          rep = Calc.numText(val);
        }
        ctx.calc = 'integral';
      }
    } else if (m[1] === 'lim' || m[1] === 'liml' || m[1] === 'limr') {
      if (raw.length < 3) throw new Error('Write the limit as lim(…, x, a)');
      const side = m[1] === 'liml' ? -1 : m[1] === 'limr' ? 1 : 0;
      const f = ME.compile(ME.parse(prep(raw[0])));
      const tv = raw[1].replace(/[()\s]/g, '').split(','), tp = ME.splitTop(raw[2].replace(/^\(|\)$/g, ''), ',').map(t => t.trim());
      let L;
      if (tv.length === 2) {
        const a = Calc.evalNum(prep(tp[0])), b = Calc.evalNum(prep(tp[1] || '0'));
        L = Calc.limit2((x, y) => Calc.run(f, { [tv[0]]: x, [tv[1]]: y }), a, b, ctx);
      } else {
        const v = tv[0], inf = Calc.bound(raw[2]), a = inf != null ? inf : Calc.evalNum(prep(raw[2]));
        L = Calc.limit1(x => Calc.run(f, { [v]: x }), a, side, ctx);
      }
      if (isNaN(L)) ctx.dne = true;
      rep = Calc.numText(L); ctx.calc = 'limit';
    } else if (m[3]) {   // f'(…), f''(…)
      const F = fns[m[2]]; if (!F) throw new Error(`Define ${m[2]} first, like ${m[2]}(x) = …`);
      let node = ME.parse(expandFnCalls(calcExpand(F.body, fns, ctx, depth + 1), fns));
      // f'(x, y): a partial derivative; which variable is picked in the menu (f'' asks twice)
      for (let k = 0; k < m[3].length; k++) node = ME.derivative(node, F.vars.length === 1 ? F.vars[0] : pick(F.vars, 'diff'));
      if (raw.length !== F.vars.length) throw new Error(`${m[2]}${m[3]} takes ${F.vars.length} value${F.vars.length > 1 ? 's' : ''}`);
      rep = '(' + substVars(ME.toText(Calc.S(node)), F.vars, raw.map(prep)) + ')'; ctx.calc = ctx.calc || 'derivative';
    } else {   // f_x(…), f_xy(…)
      const F = fns[m[4]]; if (!F) { continue; }
      const order = m[5].split(''); if (order.some(v => !F.vars.includes(v))) throw new Error(`${m[4]} is a function of ${F.vars.join(', ')}`);
      let node = ME.parse(expandFnCalls(calcExpand(F.body, fns, ctx, depth + 1), fns));
      for (const v of order) node = ME.derivative(node, v);
      if (raw.length !== F.vars.length) throw new Error(`${m[4]}_${m[5]} takes ${F.vars.length} values`);
      rep = '(' + substVars(ME.toText(Calc.S(node)), F.vars, raw.map(prep)) + ')'; ctx.calc = ctx.calc || 'derivative';
    }
    out += s.slice(last, i) + rep; last = j + 1; head.lastIndex = j + 1;
  }
  return out + s.slice(last);
}

/* ===== Statement analysis: decides graph type / arithmetic / solve ===== */
function analyzeStatement(rawExpr, fns, opts = {}) {
  const ME = MathEngine;
  const src0 = ME.normalize(rawExpr);
  const def = parseFnDef(src0);
  let src = src0;
  // functions defined on other lines, then derivatives, integrals and limits: worked out and replaced by their results
  const calc = { wrt: opts.wrt || '', pos: 0 };
  try {
    const others = {}; for (const k in fns || {}) if (!def || k !== def.name) others[k] = fns[k];
    const k0 = def ? src0.indexOf('=') + 1 : 0;
    let body = src0.slice(k0);
    for (let it = 0; it < 4; it++) {
      if (CALC_RE.test(body)) body = calcExpand(body, others, calc);
      const nb = Object.keys(others).length ? expandFnCalls(body, others) : body;
      if (nb === body) break;
      body = nb;
    }
    if (k0) body = ' ' + body.trim();
    src = src0.slice(0, k0) + body;
    if (src.replace(/\s+/g, '') === src0.replace(/\s+/g, '')) src = src0;
  } catch (e) {
    // which variable? (f'(x, y), ∫ xy, …): the menu asks, one step at a time
    if (e.choose) return { src: src0, kind: 'choose', choose: e.choose, params: [] };
    return { src: src0, kind: 'error', error: e.message };
  }
  const res = { src, kind: 'unknown' };
  if (calc.wrt) res.wrt = calc.wrt.slice(0, calc.pos);
  if (src !== src0) { res.expanded = true; res.orig = src0; }
  if (calc.calc) { res.calc = calc.calc; if (calc.dne) res.dne = calc.note || true; if (calc.plusC) res.plusC = true; }
  // a definition in other letters is graphed in x (and y): f(t) = t² → y = x², shown as f(t) = t²
  if (def && !(def.vars.length === 1 && def.vars[0] === 'x') && !(def.vars.length === 2 && def.vars[0] === 'x' && def.vars[1] === 'y')) {
    const body = src.slice(src.indexOf('=') + 1);
    try {
      if (def.vars.length === 1 && def.name === 'r' && (def.vars[0] === 'θ' || def.vars[0] === 't')) return analyzeStatement('r = ' + body);
      if (def.vars.length <= 2) {
        const to = def.vars.length === 1 ? ['x'] : ['x', 'y'];
        const out = analyzeStatement(`${def.name}(${to.join(', ')}) = ${substVars(body, def.vars, to)}`);
        if (out.kind === 'function' || out.kind === 'surface') { out.name = `${def.name}(${def.vars.join(', ')})`; out.vmap = {}; to.forEach((v, i) => { out.vmap[v] = def.vars[i]; }); if (src !== src0) { out.expanded = true; out.orig = src0; } }
        return out;
      }
      // three variables: can't be graphed, but other lines can use it (f(1, 2, 3) =)
      const f = ME.parse(body), p = new Set(); for (const v of ME.freeVars(f)) if (!def.vars.includes(v)) p.add(v);
      return { src, kind: 'define', name: `${def.name}(${def.vars.join(', ')})`, f, vars: def.vars, params: [...p] };
    } catch (e) { return { src, kind: 'error', error: e.message }; }
  }
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
      if (fv.some(v => ['x', 'y', 'z', 'r', 't', 'θ'].includes(v))) {
        // "f'(x) =", "d/dx(x³) =", "∫ x² dx =": the answer is a formula, written after the "=" (and it can be graphed)
        if (res.expanded) {
          const node = Calc.S(lhs), vs = ME.freeVars(node);
          res.answer = Calc.text(node) + (res.plusC ? '+C' : ''); res.name = res.orig.split('=')[0].trim(); res.f = node;
          if (!vs.has('y') && !vs.has('z')) { res.kind = 'function'; addParams(node, ['x']); res.params = [...params]; return res; }
          if (!vs.has('z')) { res.kind = 'surface'; addParams(node, ['x', 'y']); res.params = [...params]; return res; }
          res.kind = 'formula'; res.params = []; return res;
        }
        res.kind = 'incomplete'; return res;
      }
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
