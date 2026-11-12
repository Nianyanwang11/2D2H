/* ===== InkShape: draw a shape, hold the pencil still, and it becomes a clean one (like GoodNotes) =====
   recognize(pts, px)  pts: [[x, y], ...] in any units, px = how long one screen pixel is in those units
                       → { type: 'line' | 'circle' | 'ellipse' | 'triangle' | 'rectangle' | 'square' | 'polygon'
                                  | 'polyline' | 'arc', ...geometry } or null (leave the stroke as drawn)
   points(shape, step) → points along the shape (closed shapes end where they start)
   adjust(shape, anchor, pen, px) → the shape after the pencil, still down, moved from anchor to pen:
                       a line's end follows the pencil; other shapes grow or shrink about their centre
   Shaky, overshooting and slightly open strokes are expected; anything that isn't clearly a shape is left alone. */
const InkShape = (() => {
  const H = Math.hypot, PI = Math.PI;
  function resample(pts, step) {
    if (!pts.length) return [];
    const out = [[pts[0][0], pts[0][1]]];
    let px = pts[0][0], py = pts[0][1], carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const qx = pts[i][0], qy = pts[i][1];
      let seg = H(qx - px, qy - py);
      while (carry + seg >= step && seg > 0) {
        const t = (step - carry) / seg; px += (qx - px) * t; py += (qy - py) * t; seg = H(qx - px, qy - py); carry = 0; out.push([px, py]);
      }
      carry += seg; px = qx; py = qy;
    }
    const l = pts[pts.length - 1], o = out[out.length - 1];
    if (H(l[0] - o[0], l[1] - o[1]) > step * 0.3) out.push([l[0], l[1]]);
    return out;
  }
  const segD = (p, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy; let t = L ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L : 0; t = Math.max(0, Math.min(1, t)); return H(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy); };
  function dp(P, i0, i1, eps, keep) {   // Douglas–Peucker on P[i0..i1]
    let best = -1, bd = eps;
    for (let i = i0 + 1; i < i1; i++) { const d = segD(P[i], P[i0], P[i1]); if (d > bd) { bd = d; best = i; } }
    if (best < 0) return;
    dp(P, i0, best, eps, keep); keep.push(best); dp(P, best, i1, eps, keep);
  }
  const meanDistToPoly = (P, V, closed) => {
    let s = 0;
    for (const p of P) { let m = Infinity; const n = closed ? V.length : V.length - 1; for (let i = 0; i < n; i++) m = Math.min(m, segD(p, V[i], V[(i + 1) % V.length])); s += m; }
    return s / P.length;
  };
  const angOf = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const turn = (a, b, c) => { let d = angOf(b, c) - angOf(a, b); while (d > PI) d -= 2 * PI; while (d < -PI) d += 2 * PI; return Math.abs(d); };
  // drop vertices where the outline barely turns, and vertices crowded together
  function cleanVerts(V, closed, minLen) {
    let changed = true;
    while (changed && V.length > (closed ? 3 : 2)) {
      changed = false;
      const n = V.length;
      for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
        const a = V[(i - 1 + n) % n], b = V[i], c = V[(i + 1) % n];
        if (turn(a, b, c) < 0.38 || H(b[0] - a[0], b[1] - a[1]) < minLen) { V.splice(i, 1); changed = true; break; }
      }
    }
    return V;
  }
  const rot = (p, c, a) => { const s = Math.sin(a), co = Math.cos(a), x = p[0] - c[0], y = p[1] - c[1]; return [c[0] + x * co - y * s, c[1] + x * s + y * co]; };
  // turn a nearly level or upright shape so it is exactly level or upright
  function level(V, closed, tol = 5 * PI / 180) {
    let bestDiff = Infinity;
    const n = closed ? V.length : V.length - 1;
    for (let i = 0; i < n; i++) {
      const a = angOf(V[i], V[(i + 1) % V.length]), q = Math.round(a / (PI / 2)) * (PI / 2), d = q - a;
      if (Math.abs(d) < Math.abs(bestDiff)) bestDiff = d;
    }
    if (Math.abs(bestDiff) > tol) return V;
    const c = V.reduce((s, p) => [s[0] + p[0] / V.length, s[1] + p[1] / V.length], [0, 0]);
    return V.map(p => rot(p, c, bestDiff));
  }
  function snapAngle(a, b, tol = 4 * PI / 180) {   // a line close to level, upright or 45° becomes exactly that
    const ang = angOf(a, b), q = Math.round(ang / (PI / 4)) * (PI / 4);
    if (Math.abs(q - ang) > tol) return b;
    const L = H(b[0] - a[0], b[1] - a[1]);
    return [a[0] + L * Math.cos(q), a[1] + L * Math.sin(q)];
  }
  function fitCircle(P) {   // algebraic (Kåsa) fit: x² + y² + Dx + Ey + F = 0
    let sx = 0, sy = 0; for (const p of P) { sx += p[0]; sy += p[1]; } const mx = sx / P.length, my = sy / P.length;
    let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
    for (const p of P) { const u = p[0] - mx, v = p[1] - my; Suu += u * u; Svv += v * v; Suv += u * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u; }
    const det = Suu * Svv - Suv * Suv; if (Math.abs(det) < 1e-9) return null;
    const b1 = (Suuu + Suvv) / 2, b2 = (Svvv + Svuu) / 2;
    const uc = (b1 * Svv - b2 * Suv) / det, vc = (b2 * Suu - b1 * Suv) / det;
    const c = [mx + uc, my + vc]; let r = 0; for (const p of P) r += H(p[0] - c[0], p[1] - c[1]); r /= P.length;
    let e = 0; for (const p of P) e += Math.abs(H(p[0] - c[0], p[1] - c[1]) - r); e /= P.length;
    return { c, r, err: e / Math.max(r, 1e-9) };
  }
  function fitEllipse(P) {   // principal axes, half the extent along each, error as a share of the radius
    let mx = 0, my = 0; for (const p of P) { mx += p[0]; my += p[1]; } mx /= P.length; my /= P.length;
    let xx = 0, yy = 0, xy = 0; for (const p of P) { const u = p[0] - mx, v = p[1] - my; xx += u * u; yy += v * v; xy += u * v; }
    const ang = 0.5 * Math.atan2(2 * xy, xx - yy), ca = Math.cos(ang), sa = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of P) { const u = (p[0] - mx) * ca + (p[1] - my) * sa, v = -(p[0] - mx) * sa + (p[1] - my) * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const a = (u1 - u0) / 2, b = (v1 - v0) / 2, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const c = [mx + cu * ca - cv * sa, my + cu * sa + cv * ca];
    if (a < 1e-9 || b < 1e-9) return null;
    let e = 0; for (const p of P) { const u = (p[0] - c[0]) * ca + (p[1] - c[1]) * sa, v = -(p[0] - c[0]) * sa + (p[1] - c[1]) * ca; e += Math.abs(Math.sqrt((u / a) ** 2 + (v / b) ** 2) - 1); }
    return { c, a, b, ang, err: e / P.length };
  }

  // the pencil wobbles a little while it's held still at the end (and as it lands): drop that
  function trimHold(pts, px) {
    let e = pts.length - 1; const last = pts[e];
    while (e > 1 && H(pts[e - 1][0] - last[0], pts[e - 1][1] - last[1]) < 5 * px) e--;
    let s = 0; const first = pts[0];
    while (s < e - 1 && H(pts[s + 1][0] - first[0], pts[s + 1][1] - first[1]) < 3 * px) s++;
    const out = pts.slice(s, e); out.push(last); return out;
  }
  // a real corner turns sharply right at the vertex; a smooth bend (a wave, an S) turns gradually
  function sharpCorners(P, idx, V) {
    const m = Math.max(3, Math.round(P.length * 0.04));
    for (let k = 1; k < idx.length - 1; k++) {
      const i = idx[k]; if (i - m < 0 || i + m >= P.length) return false;
      const local = turn(P[i - m], P[i], P[i + m]), whole = turn(V[k - 1], V[k], V[k + 1]);
      if (whole < 0.6 || local < 0.6 * whole) return false;
    }
    return true;
  }
  function recognize(pts, px = 1) {
    if (!pts || pts.length < 2) return null;
    const P0 = resample(trimHold(pts, px), 2 * px), n = P0.length;
    // a light moving average takes out the tremor, so lengths and corners are those of the intended shape
    const P = P0.map((p, i) => { if (i < 2 || i > n - 3) return p; let x = 0, y = 0; for (let k = -2; k <= 2; k++) { x += P0[i + k][0]; y += P0[i + k][1]; } return [x / 5, y / 5]; });
    if (n < 6) return null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const D = H(x1 - x0, y1 - y0), L = (n - 1) * 2 * px;
    if (L < 22 * px || D < 14 * px) return null;
    let L2 = 0; for (let i = 1; i < n; i++) L2 += H(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    const A = P[0], B = P[n - 1], chord = H(B[0] - A[0], B[1] - A[1]);
    // a straight line
    let dev = 0, dev2 = 0; for (const p of P) { const d = segD(p, A, B); dev = Math.max(dev, d); dev2 += d * d; } dev2 = Math.sqrt(dev2 / n);
    if (chord > 0.88 * L2 && dev2 <= Math.max(2.5 * px, 0.035 * chord) && dev <= Math.max(6 * px, 0.09 * chord)) return { type: 'line', a: A.slice(), b: snapAngle(A, B) };
    // closed: the end comes back to the start, or runs on past it (an overshoot) or stops just short
    const near = (p, i0, i1) => { let m = Infinity; for (let i = i0; i < i1; i++) m = Math.min(m, H(P[i][0] - p[0], P[i][1] - p[1])); return m; };
    const q = Math.floor(n * 0.3);
    const closed = chord < Math.max(0.22 * D, 0.1 * L2) || near(B, 0, q) < 0.12 * D || near(A, n - q, n) < 0.12 * D;
    if (closed) {
      // the loop's corners: split at the point farthest from the start, simplify both halves
      let far = 0, fd = 0; for (let i = 1; i < n; i++) { const d = H(P[i][0] - A[0], P[i][1] - A[1]); if (d > fd) { fd = d; far = i; } }
      const keep = [0]; dp(P, 0, far, 0.07 * D, keep); keep.push(far); dp(P, far, n - 1, 0.07 * D, keep);
      keep.sort((a, b) => a - b);
      let V = keep.map(i => P[i].slice());
      V = cleanVerts(V, true, 0.12 * D);
      const ell = fitEllipse(P);
      const R = ell ? (ell.a + ell.b) / 2 : D / 2;
      const polyErr = V.length >= 3 ? meanDistToPoly(P, V, true) / R : Infinity;
      const ellErr = ell ? ell.err : Infinity;
      const sharp = V.length >= 3 && V.length <= 6;
      if (sharp && (polyErr < 0.6 * ellErr || polyErr < 0.035) && polyErr < 0.085) return polygon(V);
      if (ellErr < 0.13) {
        if (ell.b / ell.a > 0.86) return { type: 'circle', c: ell.c, r: R };
        let ang = ell.ang; const q = Math.round(ang / (PI / 2)) * (PI / 2); if (Math.abs(q - ang) < 7 * PI / 180) ang = q;
        return { type: 'ellipse', c: ell.c, a: ell.a, b: ell.b, ang };
      }
      if (sharp && polyErr < 0.085) return polygon(V);
      return null;
    }
    // open: a corner-to-corner polyline (axes, an angle) or a circular arc
    const keep = [0]; dp(P, 0, n - 1, 0.06 * D, keep); keep.push(n - 1); keep.sort((a, b) => a - b);
    let V = cleanVerts(keep.map(i => P[i].slice()), false, 0.1 * D);
    const idx = V.map(v => P.findIndex(p => p[0] === v[0] && p[1] === v[1]));
    const plErr = V.length >= 3 && V.length <= 4 && sharpCorners(P0, idx, V) ? meanDistToPoly(P, V, false) / D : Infinity;
    const cf = fitCircle(P);
    let arc = null;
    if (cf && cf.err < 0.06 && cf.r < 4 * D) {
      let sweep = 0, prev = Math.atan2(P[0][1] - cf.c[1], P[0][0] - cf.c[0]); const a0 = prev;
      for (let i = 1; i < n; i++) { const a = Math.atan2(P[i][1] - cf.c[1], P[i][0] - cf.c[0]); let d = a - prev; while (d > PI) d -= 2 * PI; while (d < -PI) d += 2 * PI; sweep += d; prev = a; }
      if (Math.abs(sweep) > 0.6 && Math.abs(sweep) < 5.8) arc = { type: 'arc', c: cf.c, r: cf.r, a0, sweep, err: cf.err };
    }
    if (plErr < 0.03 && (!arc || plErr < arc.err * 0.5)) {
      // an L or a set of axes drawn nearly level and upright becomes exactly level and upright
      const orth = V.every((p, i) => i === 0 || (() => { const a = angOf(V[i - 1], p), q = Math.round(a / (PI / 2)) * (PI / 2); return Math.abs(q - a) < 7 * PI / 180; })());
      if (orth) for (let i = 1; i < V.length; i++) { const a = V[i - 1], b = V[i]; if (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])) b[1] = a[1]; else b[0] = a[0]; }
      return { type: 'polyline', v: V, orth };
    }
    if (arc) { delete arc.err; return arc; }
    return null;
  }
  function polygon(V) {
    if (V.length === 4) {
      const ang = [0, 1, 2, 3].map(i => turn(V[(i + 3) % 4], V[i], V[(i + 1) % 4]));
      if (ang.every(a => Math.abs(a - PI / 2) < 0.3)) {   // a rectangle: average the sides' directions
        let s = 0, co = 0; for (let i = 0; i < 4; i++) { const a = angOf(V[i], V[(i + 1) % 4]) * 4; s += Math.sin(a); co += Math.cos(a); }
        let th = Math.atan2(s, co) / 4; const q = Math.round(th / (PI / 2)) * (PI / 2); if (Math.abs(q - th) < 6 * PI / 180) th = q;
        const c = V.reduce((m, p) => [m[0] + p[0] / 4, m[1] + p[1] / 4], [0, 0]), ca = Math.cos(th), sa = Math.sin(th);
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const p of V) { const u = (p[0] - c[0]) * ca + (p[1] - c[1]) * sa, v = -(p[0] - c[0]) * sa + (p[1] - c[1]) * ca; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
        let w = (u1 - u0) / 2, h = (v1 - v0) / 2; const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, cc = [c[0] + cu * ca - cv * sa, c[1] + cu * sa + cv * ca];
        const square = Math.abs(w - h) < 0.12 * Math.max(w, h); if (square) w = h = (w + h) / 2;
        const corners = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([u, v]) => [cc[0] + u * ca - v * sa, cc[1] + u * sa + v * ca]);
        return { type: square ? 'square' : 'rectangle', v: corners };
      }
    }
    return { type: V.length === 3 ? 'triangle' : 'polygon', v: level(V, true) };
  }

  function points(sh, step) {
    const out = [];
    const line = (a, b, last) => { const k = Math.max(1, Math.ceil(H(b[0] - a[0], b[1] - a[1]) / step)); for (let i = 0; i < k + (last ? 1 : 0); i++) out.push([a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k]); };
    if (sh.type === 'line') line(sh.a, sh.b, true);
    else if (sh.type === 'polyline') { for (let i = 0; i + 1 < sh.v.length; i++) line(sh.v[i], sh.v[i + 1], i + 2 === sh.v.length); }
    else if (sh.v) { for (let i = 0; i < sh.v.length; i++) line(sh.v[i], sh.v[(i + 1) % sh.v.length], false); out.push(sh.v[0].slice()); }
    else if (sh.type === 'circle' || sh.type === 'ellipse') {
      const a = sh.r || sh.a, b = sh.r || sh.b, ang = sh.ang || 0, k = Math.max(48, Math.min(240, Math.ceil(2 * PI * Math.max(a, b) / step)));
      for (let i = 0; i <= k; i++) { const t = 2 * PI * i / k, u = a * Math.cos(t), v = b * Math.sin(t); out.push([sh.c[0] + u * Math.cos(ang) - v * Math.sin(ang), sh.c[1] + u * Math.sin(ang) + v * Math.cos(ang)]); }
    } else if (sh.type === 'arc') {
      const k = Math.max(12, Math.min(240, Math.ceil(Math.abs(sh.sweep) * sh.r / step)));
      for (let i = 0; i <= k; i++) { const t = sh.a0 + sh.sweep * i / k; out.push([sh.c[0] + sh.r * Math.cos(t), sh.c[1] + sh.r * Math.sin(t)]); }
    }
    return out;
  }
  const center = sh => sh.c ? sh.c : sh.v ? sh.v.reduce((m, p) => [m[0] + p[0] / sh.v.length, m[1] + p[1] / sh.v.length], [0, 0]) : null;
  function adjust(sh, anchor, pen, px = 1) {
    if (sh.type === 'line') return { ...sh, b: snapAngle(sh.a, pen) };
    if (sh.type === 'polyline') {
      const v = sh.v.map(p => p.slice()), a = v[v.length - 2]; let b = pen.slice();
      if (sh.orth) { if (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])) b[1] = a[1]; else b[0] = a[0]; }
      v[v.length - 1] = b; return { ...sh, v };
    }
    const c = center(sh), d0 = H(anchor[0] - c[0], anchor[1] - c[1]);
    if (d0 < 6 * px) return sh;
    const k = Math.max(0.15, Math.min(6, H(pen[0] - c[0], pen[1] - c[1]) / d0));
    const sc = p => [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k];
    if (sh.v) return { ...sh, v: sh.v.map(sc) };
    if (sh.type === 'circle') return { ...sh, r: sh.r * k };
    if (sh.type === 'ellipse') return { ...sh, a: sh.a * k, b: sh.b * k };
    if (sh.type === 'arc') return { ...sh, r: sh.r * k };
    return sh;
  }
  const NAMES = { line: 'Line', circle: 'Circle', ellipse: 'Ellipse', triangle: 'Triangle', rectangle: 'Rectangle', square: 'Square', polygon: 'Polygon', polyline: 'Lines', arc: 'Arc' };
  return { recognize, points, adjust, NAMES };
})();
if (typeof module !== 'undefined') module.exports = { InkShape };
