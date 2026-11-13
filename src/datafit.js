/* ===== DataFit: the function that best fits a table of values =====
   DataFit.fit2D(xs, ys)      → [fits], best first: y = f(x)
   DataFit.fit3D(xs, ys, zs)  → [fits], best first: z = f(x, y)
   Each fit: { fam, name, expr ("y = 2*x + 1", for the math engine), f(x[, y]), coef, k, rss, r2, score }

   Least squares in every family that suits the data, then the simplest family that explains it:
   a corrected AIC with a noise floor set by how precisely the numbers were written (values written
   to whole numbers can't tell y = x² from a cubic that bends a hair), plus a small preference for
   the families a class meets first (linear, quadratic, exponential…). Coefficients are then rounded
   to the cleanest numbers that fit as well (2 instead of 1.99998, 2^x instead of e^(0.6931x)). */
const DataFit = (() => {
  const LN = Math.log;

  /* --- linear least squares (Householder QR on scaled columns) --- */
  function lstsq(rows, y) {
    const n = rows.length, k = rows[0].length; if (n < k) return null;
    const sc = new Array(k).fill(0);
    for (const r of rows) for (let j = 0; j < k; j++) sc[j] = Math.max(sc[j], Math.abs(r[j]));
    for (let j = 0; j < k; j++) if (!(sc[j] > 0) || !isFinite(sc[j])) return null;
    const A = rows.map(r => r.map((v, j) => v / sc[j])), b = y.slice();
    for (let j = 0; j < k; j++) {
      let nrm = 0; for (let i = j; i < n; i++) nrm += A[i][j] * A[i][j];
      nrm = Math.sqrt(nrm); if (nrm < 1e-13) return null;
      const alpha = A[j][j] > 0 ? -nrm : nrm, v = new Array(n).fill(0);
      v[j] = A[j][j] - alpha; for (let i = j + 1; i < n; i++) v[i] = A[i][j];
      let vv = 0; for (let i = j; i < n; i++) vv += v[i] * v[i];
      if (vv < 1e-300) continue;
      for (let c = j; c < k; c++) { let d = 0; for (let i = j; i < n; i++) d += v[i] * A[i][c]; d = 2 * d / vv; for (let i = j; i < n; i++) A[i][c] -= d * v[i]; }
      let d = 0; for (let i = j; i < n; i++) d += v[i] * b[i]; d = 2 * d / vv; for (let i = j; i < n; i++) b[i] -= d * v[i];
    }
    const x = new Array(k).fill(0);
    for (let j = k - 1; j >= 0; j--) { let s = b[j]; for (let c = j + 1; c < k; c++) s -= A[j][c] * x[c]; if (Math.abs(A[j][j]) < 1e-12) return null; x[j] = s / A[j][j]; }
    return x.map((v, j) => v / sc[j]);
  }
  /* --- nonlinear least squares (Levenberg–Marquardt, numerical Jacobian) --- */
  function lm(model, p0, X, y, iters = 200) {
    let p = p0.slice();
    const res = q => { let s = 0; for (let i = 0; i < y.length; i++) { const r = model(q, X[i]) - y[i]; s += r * r; } return s; };
    let cost = res(p), lam = 1e-3;
    if (!isFinite(cost)) return null;
    const k = p.length;
    for (let it = 0; it < iters; it++) {
      const J = [], r = [];
      for (let i = 0; i < y.length; i++) {
        const f0 = model(p, X[i]); r.push(f0 - y[i]); const row = [];
        for (let j = 0; j < k; j++) { const h = 1e-6 * (Math.abs(p[j]) + 1e-3), q = p.slice(); q[j] += h; row.push((model(q, X[i]) - f0) / h); }
        J.push(row);
      }
      const JTJ = Array.from({ length: k }, () => new Array(k).fill(0)), JTr = new Array(k).fill(0);
      for (let i = 0; i < J.length; i++) for (let a = 0; a < k; a++) { JTr[a] += J[i][a] * r[i]; for (let b = 0; b < k; b++) JTJ[a][b] += J[i][a] * J[i][b]; }
      let improved = false;
      for (let tries = 0; tries < 12 && !improved; tries++) {
        const M = JTJ.map((row, a) => row.map((v, b) => v + (a === b ? lam * (v || 1e-12) : 0)));
        const d = solve(M, JTr.map(v => -v)); if (!d) { lam *= 10; continue; }
        const q = p.map((v, j) => v + d[j]), c = res(q);
        if (isFinite(c) && c < cost) { const rel = (cost - c) / Math.max(cost, 1e-300); p = q; cost = c; lam = Math.max(lam / 3, 1e-12); improved = true; if (rel < 1e-12) return { p, cost }; }
        else lam *= 4;
      }
      if (!improved) break;
    }
    return { p, cost };
  }
  function solve(M, v) {
    const n = v.length, A = M.map((r, i) => r.concat([v[i]]));
    for (let c = 0; c < n; c++) {
      let pv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
      if (Math.abs(A[pv][c]) < 1e-300) return null;
      [A[c], A[pv]] = [A[pv], A[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; if (f) for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map((r, i) => r[n] / r[i]);
  }

  /* --- numbers --- */
  const decimals = v => { const s = String(v); if (/e/i.test(s)) return 6; const i = s.indexOf('.'); return i < 0 ? 0 : Math.min(6, s.length - i - 1); };
  const roundTo = (v, d) => { const m = Math.pow(10, d); return Math.round(v * m) / m; };
  const sig = (v, n) => v === 0 ? 0 : Number(v.toPrecision(n));
  function num(v) {   // a number as the math engine reads it: no exponent, no float noise
    if (!isFinite(v)) return 'NaN';
    let t = String(sig(v, 10));
    if (/e/i.test(t)) t = Math.abs(v) < 1 ? v.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') : v.toFixed(0);
    return t;
  }
  // c·u summed: "2*x^2 - x + 1" (coefficient 1 dropped, signs folded in)
  function sum(terms) {
    let out = '';
    for (const [c, u] of terms) {
      if (c === 0 || !isFinite(c)) continue;
      const a = Math.abs(c), body = u ? (a === 1 ? u : num(a) + '*' + u) : num(a);
      out += out ? (c < 0 ? ' - ' : ' + ') + body : (c < 0 ? '-' : '') + body;
    }
    return out || '0';
  }
  const PI_FR = (() => { const o = []; for (const q of [1, 2, 3, 4, 6, 12]) for (let p = 1; p <= 2 * q; p++) { if (gcd(p, q) !== 1) continue; o.push({ v: Math.PI * p / q, t: (p === 1 ? 'pi' : p + '*pi') + (q === 1 ? '' : '/' + q) }); } return o; })();
  function gcd(a, b) { return b ? gcd(b, a % b) : a; }

  /* --- families --- */
  const FAM2 = {
    linear: { name: 'Linear', k: 2, prior: 0, lin: x => [x, 1], f: (c, x) => c[0] * x + c[1], expr: c => sum([[c[0], 'x'], [c[1], '']]) },
    quadratic: { name: 'Quadratic', k: 3, prior: 0.4, lin: x => [x * x, x, 1], f: (c, x) => (c[0] * x + c[1]) * x + c[2], expr: c => sum([[c[0], 'x^2'], [c[1], 'x'], [c[2], '']]) },
    cubic: { name: 'Cubic', k: 4, prior: 1.2, lin: x => [x * x * x, x * x, x, 1], f: (c, x) => ((c[0] * x + c[1]) * x + c[2]) * x + c[3], expr: c => sum([[c[0], 'x^3'], [c[1], 'x^2'], [c[2], 'x'], [c[3], '']]) },
    exponential: { name: 'Exponential', k: 2, prior: 0.5, f: (c, x) => c[0] * Math.exp(c[1] * x), expr: (c, o) => o && o.base ? sum([[c[0], o.base + '^x']]) : sum([[c[0], `e^(${sum([[c[1], 'x']])})`]]) },
    logarithmic: { name: 'Logarithmic', k: 2, prior: 1.2, ok: X => X.every(x => x > 0), lin: x => [LN(x), 1], f: (c, x) => c[0] * LN(x) + c[1], expr: c => sum([[c[0], 'ln(x)'], [c[1], '']]) },
    power: { name: 'Power', k: 2, prior: 1.2, ok: X => X.every(x => x > 0), f: (c, x) => c[0] * Math.pow(x, c[1]), expr: c => c[1] === -1 ? sum([[c[0], '1/x']]).replace(/^(-?)(\d[\d.]*)\*1\/x$/, '$1$2/x') : sum([[c[0], c[1] === 0.5 ? 'sqrt(x)' : c[1] === 1 ? 'x' : `x^${c[1] < 0 ? '(' + num(c[1]) + ')' : num(c[1])}`]]) },
    inverse: { name: 'Inverse', k: 2, prior: 1.0, ok: X => X.every(x => x !== 0), lin: x => [1 / x, 1], f: (c, x) => c[0] / x + c[1], expr: c => sum([[c[0], '1/x'], [c[1], '']]).replace(/(^|[ -])(\d[\d.]*)\*1\/x/, '$1$2/x') },
    sine: { name: 'Sine', k: 4, prior: 2.5, f: (c, x) => c[0] * Math.sin(c[1] * x + c[2]) + c[3], expr: (c, o) => sum([[c[0], `sin(${o && o.bt ? o.bt + '*x' : sum([[c[1], 'x']])}${c[2] ? (c[2] < 0 ? ' - ' : ' + ') + num(Math.abs(c[2])) : ''})`], [c[3], '']]) },
    constant: { name: 'Constant', k: 1, prior: 0, lin: () => [1], f: (c) => c[0], expr: c => num(c[0]) },
  };
  const FAM3 = {
    plane: { name: 'Plane', k: 3, prior: 0, lin: (x, y) => [x, y, 1], f: (c, x, y) => c[0] * x + c[1] * y + c[2], expr: c => sum([[c[0], 'x'], [c[1], 'y'], [c[2], '']]) },
    paraboloid: { name: 'Paraboloid', k: 2, prior: 0.3, lin: (x, y) => [x * x + y * y, 1], f: (c, x, y) => c[0] * (x * x + y * y) + c[1], expr: c => Math.abs(c[0]) === 1 ? sum([[c[0], 'x^2'], [c[0], 'y^2'], [c[1], '']]) : sum([[c[0], '(x^2 + y^2)'], [c[1], '']]) },
    quadric: { name: 'Quadratic surface', k: 3, prior: 0.6, lin: (x, y) => [x * x, y * y, 1], f: (c, x, y) => c[0] * x * x + c[1] * y * y + c[2], expr: c => sum([[c[0], 'x^2'], [c[1], 'y^2'], [c[2], '']]) },
    product: { name: 'Saddle (xy)', k: 2, prior: 0.8, lin: (x, y) => [x * y, 1], f: (c, x, y) => c[0] * x * y + c[1], expr: c => sum([[c[0], 'x*y'], [c[1], '']]) },
    bilinear: { name: 'Bilinear', k: 4, prior: 1.6, lin: (x, y) => [x, y, x * y, 1], f: (c, x, y) => c[0] * x + c[1] * y + c[2] * x * y + c[3], expr: c => sum([[c[0], 'x'], [c[1], 'y'], [c[2], 'x*y'], [c[3], '']]) },
    cone: { name: 'Cone', k: 2, prior: 1.0, lin: (x, y) => [Math.hypot(x, y), 1], f: (c, x, y) => c[0] * Math.hypot(x, y) + c[1], expr: c => sum([[c[0], 'sqrt(x^2 + y^2)'], [c[1], '']]) },
    quadratic2: { name: 'Quadratic (full)', k: 6, prior: 1.6, lin: (x, y) => [x * x, y * y, x * y, x, y, 1], f: (c, x, y) => c[0] * x * x + c[1] * y * y + c[2] * x * y + c[3] * x + c[4] * y + c[5], expr: c => sum([[c[0], 'x^2'], [c[1], 'y^2'], [c[2], 'x*y'], [c[3], 'x'], [c[4], 'y'], [c[5], '']]) },
  };

  // the noise floor: numbers written to d decimals are only known to ±half a unit in the last place
  // (a tenth of the last written place: whole numbers that a simple function hits exactly are taken as exact)
let FLOOR_K = 0.1;
function floorOf(ys, sst, k = FLOOR_K) { const q = Math.pow(10, -Math.max(...ys.map(decimals))) * k; return Math.max(ys.length * q * q, 1e-14 * Math.max(1, sst)); }
// what rounding to the written places alone adds to the squared error (digits finer than this mean nothing)
const roundFloor = (ys, sst) => floorOf(ys, sst, Math.sqrt(1 / 12));
  function score(n, k, rss, floor, prior) {
    const r = Math.max(rss, floor), pen = n - k - 1 > 0 ? 2 * k * (k + 1) / (n - k - 1) : 4 * k * (k + 1);
    return n * LN(r / n) + 2 * k + pen + prior;
  }
  // round each coefficient to the cleanest value that still fits as well
  // (the fit may get worse by about one point's worth of scatter: no digits the data can't support)
  function nice(c0, rssOf, rss0, floor, extra, n, refit) {
    let c = c0.slice(); const tol = rss0 + Math.min(1.5 * Math.max(floor, rss0 / Math.max(1, (n || c.length + 1) - c.length)), Math.max(1.5 * floor, 0.08 * rss0));
    for (let i = 0; i < c.length; i++) {
      const v = c[i]; if (!isFinite(v)) continue;
      const cands = [0, Math.round(v)];
      if (extra && extra[i]) cands.push(...extra[i]);
      for (let d = 1; d <= 6; d++) cands.push(roundTo(v, d));
      for (let s = 1; s <= 8; s++) cands.push(sig(v, s));
      let done = false;
      for (const cand of cands) {
        let t = c.slice(); t[i] = typeof cand === 'object' ? cand.v : cand;
        if (refit && i < c.length - 1) t = refit(i, t) || t;   // the coefficients after it settle to the rounded one
        if (rssOf(t) <= tol) { const tag = c.tag; c = t; if (tag) c.tag = tag; if (typeof cand === 'object') (c.tag = c.tag || {})[i] = cand; done = true; break; }
      }
      if (!done) c[i] = sig(v, 6);
    }
    return c;
  }

  function fit2D(xs, ys) {
    const P = []; for (let i = 0; i < xs.length; i++) if (isFinite(xs[i]) && isFinite(ys[i])) P.push([xs[i], ys[i]]);
    const n = P.length; if (n < 2) return [];
    const X = P.map(p => p[0]), Y = P.map(p => p[1]);
    const xr = Math.max(...X) - Math.min(...X); if (!(xr > 0)) return [];
    const my = Y.reduce((a, b) => a + b, 0) / n, sst = Y.reduce((a, y) => a + (y - my) ** 2, 0);
    const floor = floorOf(Y, sst), rf = roundFloor(Y, sst), out = [];
    const rssF = F => c => { let s = 0; for (let i = 0; i < n; i++) { const r = F.f(c, X[i]) - Y[i]; s += r * r; } return isFinite(s) ? s : Infinity; };
    const refitOf = lin => lin && ((i, t) => { const free = t.length - i - 1, rows = X.map(lin), yy = Y.map((y, r) => { let v = y; for (let j = 0; j <= i; j++) v -= t[j] * rows[r][j]; return v; }); const sol = lstsq(rows.map(r => r.slice(i + 1)), yy); return sol && free ? t.slice(0, i + 1).concat(sol) : null; });
    const add = (fam, coef, opts) => {
      const F = FAM2[fam], R = rssF(F), rss = R(coef); if (!isFinite(rss)) return;
      let c = nice(coef, R, rss, rf, opts && opts.extra, n, refitOf(F.lin));
      const o = {};
      if (fam === 'exponential' && c.tag && c.tag[1]) o.base = c.tag[1].t;
      if (fam === 'sine' && c.tag && c.tag[1]) o.bt = c.tag[1].t;
      c = c.slice();
      const rs = R(c), expr = 'y = ' + F.expr(c, o);
      out.push({ fam, name: F.name, expr, coef: c, k: F.k, rss: rs, r2: sst > 0 ? 1 - rs / sst : (rs <= floor ? 1 : 0), score: score(n, F.k, rs, floor, F.prior), f: x => F.f(c, x) });
    };
    if (sst <= floor) { add('constant', [my]); return out; }
    for (const fam of ['linear', 'quadratic', 'cubic', 'logarithmic', 'inverse']) {
      const F = FAM2[fam];
      if (n < (fam === 'linear' ? 2 : F.k + 1) || (F.ok && !F.ok(X))) continue;
      const c = lstsq(X.map(F.lin), Y); if (c) add(fam, c);
    }
    // exponential y = a·e^(bx): start from the straight line through ln|y|
    if (n >= 3 && (Y.every(y => y > 0) || Y.every(y => y < 0))) {
      const s = Y[0] > 0 ? 1 : -1, c = lstsq(X.map(x => [x, 1]), Y.map(y => LN(s * y)));
      if (c) {
        const r = lm((p, x) => p[0] * Math.exp(p[1] * x), [s * Math.exp(c[1]), c[0]], X, Y);
        if (r) { const bases = [2, 3, 4, 5, 10, 0.5, 0.25, 0.1].map(b => ({ v: LN(b), t: String(b) })); add('exponential', r.p, { extra: { 1: bases } }); }
      }
    }
    // power y = a·x^b: start from the straight line through (ln x, ln|y|)
    if (n >= 3 && X.every(x => x > 0) && (Y.every(y => y > 0) || Y.every(y => y < 0))) {
      const s = Y[0] > 0 ? 1 : -1, c = lstsq(X.map(x => [LN(x), 1]), Y.map(y => LN(s * y)));
      if (c) { const r = lm((p, x) => p[0] * Math.pow(x, p[1]), [s * Math.exp(c[1]), c[0]], X, Y); if (r) add('power', r.p, { extra: { 1: [{ v: 0.5, t: '0.5' }] } }); }
    }
    // sine y = a·sin(bx + c) + d: try frequencies, keep the best, then refine
    if (n >= 6) {
      const sorted = X.slice().sort((a, b) => a - b); let dmin = Infinity; for (let i = 1; i < n; i++) if (sorted[i] - sorted[i - 1] > 1e-12) dmin = Math.min(dmin, sorted[i] - sorted[i - 1]);
      const w0 = 2 * Math.PI / (2 * xr), w1 = Math.PI / Math.max(dmin, xr / 200);
      let best = null;
      for (let i = 0; i <= 240; i++) {
        const w = w0 * Math.pow(w1 / w0, i / 240), c = lstsq(X.map(x => [Math.sin(w * x), Math.cos(w * x), 1]), Y); if (!c) continue;
        let rss = 0; for (let j = 0; j < n; j++) { const r = c[0] * Math.sin(w * X[j]) + c[1] * Math.cos(w * X[j]) + c[2] - Y[j]; rss += r * r; }
        if (!best || rss < best.rss) best = { w, c, rss };
      }
      if (best) {
        const A = Math.hypot(best.c[0], best.c[1]), ph = Math.atan2(best.c[1], best.c[0]);
        const r = lm((p, x) => p[0] * Math.sin(p[1] * x + p[2]) + p[3], [A, best.w, ph, best.c[2]], X, Y);
        if (r) {
          let [a, b, c, d] = r.p; if (b < 0) { b = -b; c = -c; a = -a; } if (a < 0) { a = -a; c += Math.PI; }
          c = Math.atan2(Math.sin(c), Math.cos(c));
          add('sine', [a, b, c, d], { extra: { 1: PI_FR } });
        }
      }
    }
    // a cubic whose x³ rounded away is just the quadratic again (same for a quadratic without x²)
    return out.filter(f => isFinite(f.score) && !((f.fam === 'cubic' || f.fam === 'quadratic') && f.coef[0] === 0)).sort((a, b) => a.score - b.score);
  }

  function fit3D(xs, ys, zs) {
    const P = []; for (let i = 0; i < xs.length; i++) if (isFinite(xs[i]) && isFinite(ys[i]) && isFinite(zs[i])) P.push([xs[i], ys[i], zs[i]]);
    const n = P.length; if (n < 3) return [];
    const Z = P.map(p => p[2]), mz = Z.reduce((a, b) => a + b, 0) / n, sst = Z.reduce((a, z) => a + (z - mz) ** 2, 0), floor = floorOf(Z, sst), rf = roundFloor(Z, sst), out = [];
    for (const fam in FAM3) {
      const F = FAM3[fam]; if (n < F.k + 1 && !(fam === 'plane' && n === 3)) continue;
      const c0 = lstsq(P.map(p => F.lin(p[0], p[1])), Z); if (!c0) continue;
      const R = c => { let s = 0; for (const p of P) { const r = F.f(c, p[0], p[1]) - p[2]; s += r * r; } return s; };
      const rows = P.map(p => F.lin(p[0], p[1])), refit = (i, t) => { const yy = Z.map((z, r) => { let v = z; for (let j = 0; j <= i; j++) v -= t[j] * rows[r][j]; return v; }); const sol = lstsq(rows.map(r => r.slice(i + 1)), yy); return sol ? t.slice(0, i + 1).concat(sol) : null; };
      const c = nice(c0, R, R(c0), rf, null, n, refit).slice(), rs = R(c);
      out.push({ fam, name: F.name, expr: 'z = ' + F.expr(c), coef: c, k: F.k, rss: rs, r2: sst > 0 ? 1 - rs / sst : 1, score: score(n, F.k, rs, floor, F.prior), f: (x, y) => F.f(c, x, y) });
    }
    return out.sort((a, b) => a.score - b.score);
  }
  return { fit2D, fit3D, decimals, setFloor: k => { FLOOR_K = k; } };
})();
