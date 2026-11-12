/* ===== Sketch → the most likely elementary function =====
   Input: pen strokes in graph coordinates + how graph units map to the screen.
   1. Clean up: trim pen-down/up hooks, bin along x and take medians (kills jitter, wobble and small backtracks).
   2. Fit every family (line, parabola, cubic, |x|, √, ln, exponential, 1/x, sine, constant; circle/ellipse for loops),
      fitting by least squares weighted toward perpendicular distance, then score by on-screen distance between sketch and curve.
   3. Pick the simplest family that fits about as well as the best one.
   4. Snap numbers to the nicest values that still match the sketch (y = x² − 1, not y = 0.97x² − 1.04). */
const SketchFit = (() => {
  // ---------- linear algebra ----------
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-14) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (!f) continue; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  // weighted least squares for coefficients of `basis`; returns { coef, sse } (sse in screen units²)
  let PHI = new Float64Array(0);
  function lsq(D, basis, W, sy) {
    const m = basis.length, n = D.X.length;
    if (PHI.length < n * m) PHI = new Float64Array(n * m * 2);
    const A = new Float64Array(m * m), b = new Float64Array(m);
    for (let i = 0; i < n; i++) {
      const x = D.X[i], o = i * m, w = W[i], y = D.Y[i];
      for (let r = 0; r < m; r++) { const v = basis[r](x); if (!isFinite(v)) return null; PHI[o + r] = v; }
      for (let r = 0; r < m; r++) { const pr = PHI[o + r] * w; b[r] += pr * y; for (let c = r; c < m; c++) A[r * m + c] += pr * PHI[o + c]; }
    }
    const M = []; for (let r = 0; r < m; r++) { const row = []; for (let c = 0; c < m; c++) row.push(c >= r ? A[r * m + c] : A[c * m + r]); row[r] += 1e-10 * (row[r] || 1); M.push(row); }
    const coef = solve(M, Array.from(b)); if (!coef || coef.some(v => !isFinite(v))) return null;
    let sse = 0;
    for (let i = 0; i < n; i++) { let y = 0; const o = i * m; for (let r = 0; r < m; r++) y += coef[r] * PHI[o + r]; const e = (y - D.Y[i]) * sy; sse += W[i] * e * e; }
    return { coef, sse };
  }
  function golden(f, a, b, it = 18) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
    for (let i = 0; i < it; i++) { if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); } else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); } }
    return fc < fd ? c : d;
  }

  // ---------- clean-up ----------
  function prepStrokes(strokes, S) {
    const out = [];
    for (const st of strokes) {
      if (st.length < 2) { if (st.length) out.push(st.slice()); continue; }
      const L = [0]; let acc = 0;
      for (let i = 1; i < st.length; i++) { acc += Math.hypot((st[i][0] - st[i - 1][0]) * S.sx, (st[i][1] - st[i - 1][1]) * S.sy); L.push(acc); }
      const trim = acc > 0.12 ? Math.min(0.035 * acc, 0.02) : 0;   // pen-down / pen-up hooks
      out.push(st.filter((p, i) => L[i] >= trim && L[i] <= acc - trim));
    }
    return out;
  }
  function prep(strokes, S) { return prepStrokes(strokes, S).flat(); }
  // resample every stroke evenly along its length (so steep parts count as much as flat ones), then smooth
  function sampleData(strokes, S) {
    const polys = [], pts = [];
    const step = 0.011;
    for (const st of strokes) {
      if (!st.length) continue;
      const sc = st.map(p => [p[0] * S.sx, p[1] * S.sy]);
      const out = [sc[0]]; let carry = 0;
      for (let i = 1; i < sc.length; i++) {
        let [ax, ay] = sc[i - 1]; const [bx, by] = sc[i]; let seg = Math.hypot(bx - ax, by - ay);
        while (carry + seg >= step) { const t = (step - carry) / seg; ax += (bx - ax) * t; ay += (by - ay) * t; out.push([ax, ay]); seg = Math.hypot(bx - ax, by - ay); carry = 0; }
        carry += seg;
      }
      if (out.length > 1 || sc.length === 1) out.push(sc[sc.length - 1]);
      // moving average along the stroke (±3 samples) removes tremor and tiny back-and-forth
      const sm = out.map((p, i) => { let sx = 0, sy = 0, n = 0; for (let j = Math.max(0, i - 3); j <= Math.min(out.length - 1, i + 3); j++) { sx += out[j][0]; sy += out[j][1]; n++; } return [sx / n, sy / n]; });
      polys.push(sm);
      for (const [u, v] of sm) pts.push([u / S.sx, v / S.sy]);
    }
    pts.sort((p, q) => p[0] - q[0]);
    const X = pts.map(p => p[0]), Y = pts.map(p => p[1]);
    const x0 = X[0], x1 = X[X.length - 1], R = x1 - x0;
    let y0 = Infinity, y1 = -Infinity; for (const y of Y) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { X, Y, x0, x1, y0, y1, R, bw: R / 48, polys };
  }
  function hasDataNear(D, x) {
    let lo = 0, hi = D.X.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (D.X[m] < x) lo = m + 1; else hi = m; }
    const near = Math.min(Math.abs(D.X[lo] - x), lo ? Math.abs(D.X[lo - 1] - x) : Infinity);
    return near <= 0.8 * D.bw;
  }
  function segDist(px, py, segs) {
    let best = Infinity;
    for (const s of segs) for (let i = 0; i + 1 < s.length; i++) {
      const [ax, ay] = s[i], [bx, by] = s[i + 1], vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
      let t = L ? ((px - ax) * vx + (py - ay) * vy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = px - (ax + t * vx), dy = py - (ay + t * vy), d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    for (const s of segs) if (s.length === 1) { const d = (px - s[0][0]) ** 2 + (py - s[0][1]) ** 2; if (d < best) best = d; }
    return Math.sqrt(best);
  }
  function curveSegs(f, xa, xb, S, n = 300) {
    const segs = []; let cur = [], prev = null;
    for (let i = 0; i <= n; i++) {
      const x = xa + (xb - xa) * i / n, y = f(x);
      if (!isFinite(y) || Math.abs(y * S.sy) > 40) { if (cur.length) segs.push(cur); cur = []; prev = null; continue; }
      const p = [x * S.sx, y * S.sy];
      if (prev && Math.abs(p[1] - prev[1]) > 0.6) { if (cur.length) segs.push(cur); cur = []; }
      cur.push(p); prev = p;
    }
    if (cur.length) segs.push(cur);
    return segs;
  }
  // symmetric on-screen distance between the sketch and a curve (fraction of the graph's size)
  function chamfer(f, D, S) {
    const pad = 0.015 * D.R, segs = curveSegs(f, D.x0 - pad, D.x1 + pad, S);
    if (!segs.length) return Infinity;
    let s1 = 0, n1 = 0; const st = D.X.length > 140 ? 2 : 1;
    for (let i = 0; i < D.X.length; i += st) { const d = segDist(D.X[i] * S.sx, D.Y[i] * S.sy, segs); s1 += d * d; n1++; }
    s1 /= n1;
    let s2 = 0, n2 = 0;
    for (const s of segs) for (let j = 0; j < s.length; j += 2) {
      const x = s[j][0] / S.sx; if (x < D.x0 || x > D.x1 || !hasDataNear(D, x)) continue;
      const d = Math.min(0.25, segDist(s[j][0], s[j][1], D.polys)); s2 += d * d; n2++;
    }
    s2 = n2 ? s2 / n2 : s1;
    return Math.sqrt((s1 + s2) / 2);
  }

  // ---------- families ----------
  // each: nl = shape parameters (searched), lin = parameters solved by least squares for given shape
  const sq = v => v * v;
  const FAM = {
    const: { k: 1, nl: [], lin: ['k'], basis: () => [() => 1], f: P => () => P.k },
    line: { k: 2, nl: [], lin: ['m', 'b'], basis: () => [x => x, () => 1], f: P => x => P.m * x + P.b },
    quad: { k: 3, nl: ['h'], lin: ['a', 'k'], basis: P => [x => sq(x - P.h), () => 1], f: P => x => P.a * sq(x - P.h) + P.k },
    cubic: { k: 4, nl: ['h'], lin: ['a', 'p', 'k'], basis: P => [x => (x - P.h) ** 3, x => x - P.h, () => 1], f: P => x => P.a * (x - P.h) ** 3 + P.p * (x - P.h) + P.k },
    abs: { k: 3, nl: ['h'], lin: ['a', 'k'], basis: P => [x => Math.abs(x - P.h), () => 1], f: P => x => P.a * Math.abs(x - P.h) + P.k },
    sqrt: { k: 3, nl: ['h'], lin: ['a', 'k'], basis: P => [x => Math.sqrt(Math.max(0, x - P.h)), () => 1], f: P => x => P.a * Math.sqrt(Math.max(0, x - P.h)) + P.k },
    log: { k: 3, nl: ['h'], lin: ['a', 'k'], basis: P => [x => Math.log(Math.max(x - P.h, P.eps || 1e-3)), () => 1], f: P => x => P.a * Math.log(Math.max(x - P.h, P.eps || 1e-3)) + P.k },
    exp: { k: 3, nl: ['b'], lin: ['a', 'k'], basis: P => [x => Math.exp(P.b * x), () => 1], f: P => x => P.a * Math.exp(P.b * x) + P.k },
    recip: { k: 3, nl: ['h'], lin: ['a', 'k'], basis: P => [x => 1 / (x - P.h), () => 1], f: P => x => P.a / (x - P.h) + P.k },
    sine: { k: 4, nl: ['w', 'h'], lin: ['a', 'k'], basis: P => [x => Math.sin(P.w * (x - P.h)), () => 1], f: P => x => P.a * Math.sin(P.w * (x - P.h)) + P.k },
  };
  const PRIOR = { const: 0, line: 0, quad: 0, cubic: 0.004, abs: 0.002, sqrt: 0.002, log: 0.002, exp: 0.002, recip: 0.003, sine: 0.003 };
  const LAMBDA = 0.004;

  function solveLin(fam, D, W, S, P) {
    const r = lsq(D, FAM[fam].basis(P), W, S.sy); if (!r) return null;
    const out = { ...P }; FAM[fam].lin.forEach((n, i) => { out[n] = r.coef[i]; });
    return { P: out, sse: r.sse };
  }
  function grid(a, b, n) { const o = []; for (let i = 0; i <= n; i++) o.push(a + (b - a) * i / n); return o; }
  function fitFamily(fam, D, S) {
    const N = D.X.length, R = D.R, ones = new Array(N).fill(1);
    let W = ones;
    let local = null;   // after the first pass: refine only near the current shape value
    const fitNL = (W) => {
      const best1 = (name, vals0, fixed = {}) => {
        let vals = vals0;
        if (local && local[name] != null) { const st = Math.abs(vals0[1] - vals0[0]) || 0.05 * R; vals = [local[name] - st, local[name], local[name] + st]; }
        let best = null;
        for (const v of vals) { const s = solveLin(fam, D, W, S, { ...fixed, [name]: v }); if (s && (!best || s.sse < best.sse)) best = { v, ...s }; }
        if (!best) return null;
        const i = vals.indexOf(best.v), lo = vals[Math.max(0, i - 1)], hi = vals[Math.min(vals.length - 1, i + 1)];
        if (hi > lo) { const v = golden(t => { const s = solveLin(fam, D, W, S, { ...fixed, [name]: t }); return s ? s.sse : Infinity; }, lo, hi); const s = solveLin(fam, D, W, S, { ...fixed, [name]: v }); if (s && s.sse <= best.sse) best = { v, ...s }; }
        return best;
      };
      switch (fam) {
        case 'const': case 'line': return solveLin(fam, D, W, S, {});
        case 'quad': {
          const r = lsq(D, [x => x * x, x => x, () => 1], W, S.sy); if (!r || Math.abs(r.coef[0]) < 1e-9) return null;
          const h0 = -r.coef[1] / (2 * r.coef[0]); return solveLin(fam, D, W, S, { h: h0 });
        }
        case 'cubic': {
          const r = lsq(D, [x => x * x * x, x => x * x, x => x, () => 1], W, S.sy); if (!r || Math.abs(r.coef[0]) < 1e-9) return null;
          return solveLin(fam, D, W, S, { h: -r.coef[1] / (3 * r.coef[0]) });
        }
        case 'abs': return best1('h', grid(D.x0 + 0.02 * R, D.x1 - 0.02 * R, 48));
        case 'sqrt': return best1('h', grid(D.x0 - 0.8 * R, D.x0 - 1e-4 * R, 48));
        case 'log': return best1('h', grid(D.x0 - 1.2 * R, D.x0 - 1e-3 * R, 48));
        case 'exp': { const bs = grid(-12 / R, 12 / R, 96).filter(b => Math.abs(b * R) > 0.4); return best1('b', bs); }
        case 'recip': {
          // the asymptote sits outside the sketch or in a gap between its branches
          const gaps = []; for (let i = 1; i < D.X.length; i++) if (D.X[i] - D.X[i - 1] > 3 * D.bw) gaps.push((D.X[i] + D.X[i - 1]) / 2);
          const hs = grid(D.x0 - 1.5 * R, D.x1 + 1.5 * R, 160).filter(h => h < D.x0 - 0.005 * R || h > D.x1 + 0.005 * R).concat(gaps).sort((p, q) => p - q);
          return best1('h', hs);
        }
        case 'sine': {
          let best = null;
          const ws = local ? [local.w * 0.97, local.w, local.w * 1.03] : grid(2 * Math.PI * 0.3 / R, 2 * Math.PI * 5 / R, 90);
          for (const w of ws) {
            const r = lsq(D, [x => Math.sin(w * x), x => Math.cos(w * x), () => 1], W, S.sy);
            if (r && (!best || r.sse < best.r.sse)) best = { w, r };
          }
          if (!best) return null;
          const step = local ? local.w * 0.03 : (2 * Math.PI * 4.7 / R) / 90;
          const wr = golden(w => { const r = lsq(D, [x => Math.sin(w * x), x => Math.cos(w * x), () => 1], W, S.sy); return r ? r.sse : Infinity; }, best.w - step, best.w + step);
          const r = lsq(D, [x => Math.sin(wr * x), x => Math.cos(wr * x), () => 1], W, S.sy); if (!r) return null;
          const [A, B] = r.coef, phi = Math.atan2(B, A);   // A sin + B cos = a sin(w x + phi)
          return solveLin(fam, D, W, S, { w: wr, h: -phi / wr });
        }
      }
      return null;
    };
    let res = fitNL(W); if (!res) return null;
    // re-weight toward perpendicular distance (steep parts shouldn't dominate), twice
    for (let it = 0; it < 2; it++) {
      local = res.P;
      const f = FAM[fam].f(res.P), dsc = S.sy / S.sx;
      W = D.X.map(x => { const e = 1e-4 * R, s = (f(x + e) - f(x - e)) / (2 * e) * dsc; return isFinite(s) ? 1 / (1 + s * s) : 0.05; });
      const r2 = fitNL(W); if (r2) res = r2;
    }
    const f = FAM[fam].f(res.P), err = chamfer(f, D, S);
    if (!isFinite(err)) return null;
    // reject degenerate shapes (e.g. a "parabola" that is really a straight line)
    if ((fam === 'quad' || fam === 'abs' || fam === 'sqrt' || fam === 'log' || fam === 'exp' || fam === 'recip' || fam === 'sine') && Math.abs(res.P.a) < 1e-9) return null;
    return { fam, P: res.P, W, err };
  }

  // ---------- nice numbers ----------
  const PI = Math.PI;
  function niceShift(v, unit) {
    const c = [0]; for (const s of [1, 0.5, 0.25, 0.1, 0.05, 0.01]) c.push(Math.round(v / (unit * s)) * unit * s);
    return [...new Set(c.map(x => +x.toFixed(6)))];
  }
  function niceScale(v) {
    const s = Math.sign(v) || 1, a = Math.abs(v), c = [s];
    const mag = Math.pow(10, Math.floor(Math.log10(a)));
    for (const st of [mag, mag / 2, mag / 4, mag / 10, mag / 20, mag / 100]) { const r = Math.round(a / st) * st; if (r > 0) c.push(s * r); }
    return [...new Set(c.map(x => +x.toFixed(6)))];
  }
  function niceFreq(w) {
    const c = [1, 2, 0.5, PI, PI / 2, 3, 2 * PI, PI / 4, 4, 1.5, 2.5, PI / 3, 3 * PI / 2];
    return c.filter(x => Math.abs(x - w) / w < 0.3).concat([Math.round(w * 10) / 10, Math.round(w * 100) / 100]);
  }
  function niceExpB(b) {
    const s = Math.sign(b), c = [1, Math.LN2, 0.5, 2, Math.log(3), Math.LN10, 0.25, 3].map(v => s * v);
    return c.filter(x => Math.abs(x - b) / Math.abs(b) < 0.45).concat([Math.round(b * 10) / 10, Math.round(b * 100) / 100]).filter(x => x);
  }
  function unitFor(range) { return Math.pow(10, Math.floor(Math.log10(range / 4))); }
  // fast closeness used while rounding: weighted (≈ perpendicular) RMS distance on screen
  function werr(fam, Q, D, S, W) {
    const f = FAM[fam].f(Q); let s = 0, sw = 0;
    for (let i = 0; i < D.X.length; i++) { const y = f(D.X[i]); if (!isFinite(y)) return Infinity; const e = (y - D.Y[i]) * S.sy; s += W[i] * e * e; sw += W[i]; }
    return Math.sqrt(s / sw);
  }
  // round the numbers to the simplest values that still match the sketch (small beam search)
  function snap(fit, D, S, view) {
    const fam = fit.fam, F = FAM[fam], W = fit.W, ux = unitFor(view.x1 - view.x0), uy = unitFor(view.y1 - view.y0);
    const e0 = werr(fam, fit.P, D, S, W), budget = e0 + Math.max(0.007, 0.6 * e0);
    const refit = (Q, fixed) => {
      const free = F.lin.filter(n => !fixed.has(n)); if (!free.length) return Q;
      const basis = F.basis(Q), fixedPart = x => F.lin.reduce((s, n, i) => fixed.has(n) ? s + Q[n] * basis[i](x) : s, 0);
      const D2 = { ...D, Y: D.Y.map((y, i) => y - fixedPart(D.X[i])) };
      const r = lsq(D2, free.map(n => basis[F.lin.indexOf(n)]), W, S.sy); if (!r) return null;
      const out = { ...Q }; free.forEach((n, i) => { out[n] = r.coef[i]; }); return out;
    };
    const nearest = c => D.X.reduce((m, x) => Math.min(m, Math.abs(x - c)), Infinity);
    const valid = (name, c) => !((fam === 'sqrt' || fam === 'log') && name === 'h' && c > D.x0 + 0.03 * D.R) && !(fam === 'recip' && name === 'h' && c > D.x0 && c < D.x1 && nearest(c) < 0.6 * D.bw);
    const steps = [];
    if (fam === 'sine') { steps.push(['w', P => niceFreq(P.w)]); steps.push(['h', P => [0, -PI / (2 * P.w), PI / P.w, PI / (2 * P.w)].map(h => +h.toFixed(9)).concat(niceShift(P.h, ux).slice(1))]); }
    else if (fam === 'exp') steps.push(['b', P => niceExpB(P.b)]);
    else if (F.nl.includes('h')) steps.push(['h', P => niceShift(P.h, ux)]);
    const order = { const: ['k'], line: ['m', 'b'], quad: ['a', 'k'], cubic: ['a', 'p', 'k'], abs: ['a', 'k'], sqrt: ['a', 'k'], log: ['a', 'k'], exp: ['a', 'k'], recip: ['a', 'k'], sine: ['a', 'k'] }[fam];
    for (const n of order) steps.push([n, P => (n === 'k' || n === 'b' || n === 'p') ? niceShift(P[n], uy) : niceScale(P[n])]);
    let beam = [{ P: { ...fit.P }, fixed: new Set(), cost: 0, e: e0 }];
    for (const [name, candsOf] of steps) {
      const next = [];
      for (const item of beam) {
        let found = 0;
        for (const c of candsOf(item.P)) {
          if (!isFinite(c) || !valid(name, c)) continue;
          const fixed = new Set([...item.fixed, name]);
          const Q = refit({ ...item.P, [name]: c }, fixed); if (!Q) continue;
          if (F.lin.includes(name)) Q[name] = c;
          const e = werr(fam, Q, D, S, W);
          const cc = fam === 'sine' && name === 'h' && [0, -PI / (2 * Q.w), PI / Q.w, PI / (2 * Q.w)].some(h => Math.abs(h - c) < 1e-6) ? 0 : numCost(c, name);
          if (e <= budget) { next.push({ P: Q, fixed, cost: item.cost + cc, e }); if (++found >= 3) break; }
        }
        if (!found) next.push({ ...item, fixed: new Set([...item.fixed, name]), cost: item.cost + numCost(item.P[name], name) });
      }
      next.sort((p, q) => (p.e + MU * 2 * p.cost) - (q.e + MU * 2 * q.cost));
      beam = next.slice(0, 5);
    }
    const P = beam[0].P;
    for (const k in P) P[k] = +(+P[k]).toFixed(6);
    return { fam, P, err: chamfer(F.f(P), D, S) };
  }
  // the family's telltale feature should actually be in the sketch
  function evidence(fam, P, D) {
    const R = D.R;
    switch (fam) {
      case 'recip': { const d = P.h < D.x0 ? D.x0 - P.h : P.h > D.x1 ? P.h - D.x1 : 0; return d / R > 0.3 ? 0.012 : 0; }
      case 'log': return (D.x0 - P.h) / R > 0.3 ? 0.009 : 0;
      case 'sqrt': return (D.x0 - P.h) / R > 0.2 ? 0.009 : 0;
      case 'abs': return (P.h - D.x0) / R < 0.1 || (D.x1 - P.h) / R < 0.1 ? 0.008 : 0;
      case 'quad': return (P.h < D.x0 - 0.35 * R || P.h > D.x1 + 0.35 * R) ? 0.008 : (P.h < D.x0 - 0.1 * R || P.h > D.x1 + 0.1 * R) ? 0.005 : 0;
      case 'exp': return Math.abs(P.b) * R < 1.6 ? 0.006 : 0;
      case 'cubic': return (P.h < D.x0 - 0.15 * R || P.h > D.x1 + 0.15 * R) ? 0.007 : 0;
      case 'sine': return P.w * R / (2 * PI) < 0.7 ? 0.009 : 0;
    }
    return 0;
  }
  function numCost(v, kind) {
    v = Math.abs(v);
    if (v < 1e-9) return 0;
    if (kind === 'w' && [1, 2, 0.5, PI, PI / 2, 2 * PI].some(c => Math.abs(c - v) < 1e-6)) return 0.4;
    if (kind === 'b') { if (Math.abs(v - 1) < 1e-6) return 0.15; if (Math.abs(v - Math.LN2) < 1e-6) return 0.3; if ([Math.log(3), Math.LN10].some(c => Math.abs(c - v) < 1e-6)) return 0.8; }
    if (Math.abs(v - 1) < 1e-9) return 0.3;
    if (Math.abs(v - Math.round(v)) < 1e-9) return v <= 10 ? 1 : 1.5;
    if (Math.abs(v * 2 - Math.round(v * 2)) < 1e-9) return 1.6;
    if (Math.abs(v * 10 - Math.round(v * 10)) < 1e-9) return 2.2;
    if (Math.abs(v * 4 - Math.round(v * 4)) < 1e-9) return 2.4;
    if (Math.abs(v * 100 - Math.round(v * 100)) < 1e-9) return 3;
    return 4;
  }
  function paramCost(fam, P) { let c = 0; for (const k in P) c += numCost(P[k], k); if (fam === 'sine') c -= numCost(P.h, 'h') > 0 && [0, -PI / (2 * P.w), PI / P.w, PI / (2 * P.w)].some(h => Math.abs(h - P.h) < 1e-6) ? numCost(P.h, 'h') : 0; return c; }
  const MU = 0.0014;

  // ---------- formulas ----------
  function num(v) { const s = (+v.toFixed(3)).toString(); return s === '-0' ? '0' : s; }
  function sh(h) { return h === 0 ? 'x' : h > 0 ? `(x - ${num(h)})` : `(x + ${num(-h)})`; }
  function terms(list, text) {   // [[coef, inner]] → "2x^2 - 3x + 1"
    let s = '';
    for (const [c, inner] of list) {
      if (c === 0) continue;
      const neg = c < 0, a = Math.abs(c);
      const body = inner ? (a === 1 ? inner : num(a) + (text ? (/^[0-9]/.test(inner) ? '×' : '') : '*') + inner) : num(a);
      s += s ? (neg ? ' - ' : ' + ') + body : (neg ? '-' : '') + body;
    }
    return s || '0';
  }
  const fmtW = (w, text) => { const m = [[PI, text ? 'π' : 'pi'], [PI / 2, text ? 'π/2' : 'pi/2'], [2 * PI, text ? '2π' : '2*pi'], [PI / 4, text ? 'π/4' : 'pi/4'], [PI / 3, text ? 'π/3' : 'pi/3'], [3 * PI / 2, text ? '3π/2' : '3*pi/2']].find(([v]) => Math.abs(v - w) < 1e-6); return m ? m[1] : num(w); };
  function formula(fam, P, text) {
    const K = c => c;
    switch (fam) {
      case 'const': return `y = ${num(P.k)}`;
      case 'line': return `y = ${terms([[P.m, 'x'], [P.b, '']], text)}`;
      case 'quad': return `y = ${terms([[P.a, sh(P.h) + '^2'], [P.k, '']], text)}`;
      case 'cubic': return `y = ${terms([[P.a, sh(P.h) + '^3'], [P.p, sh(P.h)], [P.k, '']], text)}`;
      case 'abs': return `y = ${terms([[P.a, text ? `|${sh(P.h).replace(/^\(|\)$/g, '')}|` : `abs(${sh(P.h).replace(/^\(|\)$/g, '')})`], [P.k, '']], text)}`;
      case 'sqrt': return `y = ${terms([[P.a, text ? `√(${sh(P.h).replace(/^\(|\)$/g, '')})` : `sqrt(${sh(P.h).replace(/^\(|\)$/g, '')})`], [P.k, '']], text)}`;
      case 'log': return `y = ${terms([[P.a, `ln(${sh(P.h).replace(/^\(|\)$/g, '')})`], [P.k, '']], text)}`;
      case 'exp': {
        const bases = [[Math.LN2, '2'], [-Math.LN2, '0.5'], [Math.log(3), '3'], [Math.LN10, '10']];
        const bb = bases.find(([v]) => Math.abs(v - P.b) < 1e-6);
        const pow = bb ? `${bb[1]}^x` : P.b === 1 ? 'e^x' : P.b === -1 ? (text ? 'e^(-x)' : 'e^(-x)') : text ? `e^(${terms([[P.b, 'x']], true)})` : `e^(${num(P.b)}*x)`;
        return `y = ${terms([[P.a, pow], [P.k, '']], text)}`;
      }
      case 'recip': {
        const den = sh(P.h).replace(/^\(|\)$/g, ''), a = Math.abs(P.a), frac = `${num(a)}/${P.h === 0 ? 'x' : `(${den})`}`;
        return `y = ${P.a < 0 ? '-' : ''}${frac}${P.k ? (P.k < 0 ? ' - ' : ' + ') + num(Math.abs(P.k)) : ''}`;
      }
      case 'sine': {
        const w = fmtW(P.w, text), isCos = Math.abs(P.h + PI / (2 * P.w)) < 1e-6, isNegSin = Math.abs(P.h - PI / P.w) < 1e-6, isNegCos = Math.abs(P.h - PI / (2 * P.w)) < 1e-6;
        let fn = 'sin', a = P.a, arg;
        const wx = w === '1' ? 'x' : (text ? (/[π/]/.test(w) && w.includes('/') ? `(${w})x` : `${w}x`) : `${w}*x`);
        if (P.h === 0) arg = wx; else if (isCos) { fn = 'cos'; arg = wx; } else if (isNegSin) { a = -a; arg = wx; } else if (isNegCos) { fn = 'cos'; a = -a; arg = wx; }
        else arg = w === '1' ? sh(P.h).replace(/^\(|\)$/g, '') : (text ? `${w}${sh(P.h)}` : `${w}*${sh(P.h)}`);
        return `y = ${terms([[a, `${fn}(${arg})`], [P.k, '']], text)}`;
      }
      case 'circle': {
        const xs = P.h === 0 ? 'x^2' : `${sh(P.h)}^2`, ys = P.k === 0 ? 'y^2' : `(y ${P.k > 0 ? '-' : '+'} ${num(Math.abs(P.k))})^2`;
        return `${xs} + ${ys} = ${num(+(P.r * P.r).toFixed(4))}`;
      }
      case 'ellipse': {
        const xs = P.h === 0 ? 'x^2' : `${sh(P.h)}^2`, ys = P.k === 0 ? 'y^2' : `(y ${P.k > 0 ? '-' : '+'} ${num(Math.abs(P.k))})^2`;
        return `${xs}/${num(+(P.rx * P.rx).toFixed(4))} + ${ys}/${num(+(P.ry * P.ry).toFixed(4))} = 1`;
      }
    }
    return '';
  }

  // ---------- loops: circle / ellipse ----------
  function fitLoop(pts, S, view) {
    // algebraic circle fit (x² + y² + Dx + Ey + F = 0)
    const D = { X: pts.map(p => p[0]), Y: pts.map(p => -(p[0] * p[0] + p[1] * p[1])) };
    const A = Array.from({ length: 3 }, () => [0, 0, 0]), b = [0, 0, 0];
    for (const [x, y] of pts) { const r = [x, y, 1], t = -(x * x + y * y); for (let i = 0; i < 3; i++) { b[i] += r[i] * t; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } }
    const c = solve(A, b); if (!c) return null;
    let h = -c[0] / 2, k = -c[1] / 2, r = Math.sqrt(h * h + k * k - c[2]);
    if (!isFinite(r)) return null;
    const ex = () => Math.sqrt(pts.reduce((s, [x, y]) => s + (Math.hypot((x - h) * S.sx, (y - k) * S.sy) - r * S.sx) ** 2, 0) / pts.length);
    let xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const rx = (Math.max(...xs) - Math.min(...xs)) / 2, ry = (Math.max(...ys) - Math.min(...ys)) / 2;
    const roundish = Math.abs(rx * S.sx - ry * S.sy) / Math.max(rx * S.sx, ry * S.sy) < 0.2;
    const ux = unitFor(view.x1 - view.x0);
    if (roundish) {
      const e0 = ex(), budget = e0 + Math.max(0.008, 0.4 * e0);
      for (const name of ['h', 'k']) { const save = name === 'h' ? h : k; for (const cnd of niceShift(save, ux)) { if (name === 'h') h = cnd; else k = cnd; if (ex() <= budget) break; if (name === 'h') h = save; else k = save; } }
      const rs = r; for (const cnd of niceScale(rs)) { r = cnd; if (ex() <= budget) break; r = rs; }
      return { fam: 'circle', P: { h: +h.toFixed(6), k: +k.toFixed(6), r: +r.toFixed(6) }, err: ex() };
    }
    let cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2, Rx = rx, Ry = ry;
    const ee = () => Math.sqrt(pts.reduce((s, [x, y]) => { const t = Math.atan2((y - cy) / Ry, (x - cx) / Rx); return s + ((x - cx - Rx * Math.cos(t)) * S.sx) ** 2 + ((y - cy - Ry * Math.sin(t)) * S.sy) ** 2; }, 0) / pts.length);
    const e0 = ee(), budget = e0 + Math.max(0.008, 0.4 * e0);
    for (const [get, set] of [[() => cx, v => { cx = v; }], [() => cy, v => { cy = v; }]]) { const s0 = get(); for (const cnd of niceShift(s0, ux)) { set(cnd); if (ee() <= budget) break; set(s0); } }
    for (const [get, set] of [[() => Rx, v => { Rx = v; }], [() => Ry, v => { Ry = v; }]]) { const s0 = get(); for (const cnd of niceScale(s0)) { set(cnd); if (ee() <= budget) break; set(s0); } }
    return { fam: 'ellipse', P: { h: +cx.toFixed(6), k: +cy.toFixed(6), rx: +Rx.toFixed(6), ry: +Ry.toFixed(6) }, err: ee() };
  }

  const NAMES = { const: 'Constant', line: 'Line', quad: 'Parabola', cubic: 'Cubic', abs: 'Absolute value', sqrt: 'Square root', log: 'Logarithm', exp: 'Exponential', recip: 'Reciprocal', sine: 'Sine wave', circle: 'Circle', ellipse: 'Ellipse' };
  /* strokes: [[[x, y], ...], ...] in graph units; view: {x0,x1,y0,y1}; W, H: graph size on screen (px) */
  function recognize(strokes, view, W, H) {
    const M = Math.max(W, H), S = { sx: W / (view.x1 - view.x0) / M, sy: H / (view.y1 - view.y0) / M };
    const raw = strokes.flat();
    if (raw.length < 4) return { error: 'too-short' };
    const pts = prep(strokes, S);
    if (pts.length < 6) return { error: 'too-short' };
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const wx = (x1 - x0) * S.sx, wy = (y1 - y0) * S.sy;
    if (Math.max(wx, wy) < 0.05) return { error: 'too-short' };
    if (wx < 0.05 && wy > 0.15) return { error: 'vertical', x: (x0 + x1) / 2 };
    // closed loop or a stroke that doubles back on itself → circle / ellipse
    let back = 0, fwd = 0;
    for (const st of strokes) for (let i = 1; i < st.length; i++) { const d = (st[i][0] - st[i - 1][0]) * S.sx; if (d > 0) fwd += d; else back -= d; }
    const all = strokes.flat(), s0 = all[0], s1 = all[all.length - 1];
    const closeEnds = Math.hypot((s0[0] - s1[0]) * S.sx, (s0[1] - s1[1]) * S.sy) < 0.3 * Math.hypot(wx, wy);
    if (Math.min(back, fwd) > 0.55 * wx && closeEnds && strokes.length <= 2) {
      const lp = fitLoop(raw, S, view);
      if (lp && lp.err > 0.045) return { error: 'messy' };
      if (lp) return { best: { ...lp, name: NAMES[lp.fam], expr: formula(lp.fam, lp.P, false), text: formula(lp.fam, lp.P, true) }, alts: [] };
    }
    const D = sampleData(prepStrokes(strokes, S), S);
    if (D.X.length < 8) return { error: 'too-short' };
    const fits = [];
    for (const fam of Object.keys(FAM)) { const f = fitFamily(fam, D, S); if (f) fits.push({ ...f, score: f.err + LAMBDA * FAM[fam].k + PRIOR[fam] }); }
    if (!fits.length) return { error: 'no-fit' };
    fits.sort((a, b) => a.score - b.score);
    if (fits[0].err > 0.06) return { error: 'messy', best: null };
    const top = fits.filter(f => f.score <= fits[0].score * 2.5 + 0.012).slice(0, 7);
    const snapped = top.map(f => { const s = snap(f, D, S, view); const ev = evidence(f.fam, s.P, D); const final = s.err + LAMBDA * FAM[f.fam].k + PRIOR[f.fam] + MU * paramCost(f.fam, s.P) + ev; return { fam: f.fam, name: NAMES[f.fam], P: s.P, err: s.err, ev, score: final, expr: formula(f.fam, s.P, false), text: formula(f.fam, s.P, true) }; });
    snapped.sort((a, b) => a.score - b.score);
    const b = snapped[0], alts = [];
    // other sensible readings: close in fit, and their telltale feature is in the sketch
    for (const o of snapped.slice(1)) { if (alts.length >= 3) break; if (o.ev > 0 || o.score > b.score * 1.8 + 0.006) continue; if (o.expr === b.expr || alts.some(a => a.expr === o.expr)) continue;
      const fb = FAM[b.fam] ? FAM[b.fam].f(b.P) : null, fo = FAM[o.fam].f(o.P); let diff = 0;
      if (fb) for (let i = 0; i <= 40; i++) { const x = D.x0 + D.R * i / 40, d = Math.abs((fo(x) - fb(x)) * S.sy); if (isFinite(d)) diff = Math.max(diff, d); }
      if (fb && diff < 0.02) continue;   // looks the same on screen
      alts.push(o); }
    return { best: b, alts };
  }
  return { recognize, formula, FAM, NAMES };
})();
