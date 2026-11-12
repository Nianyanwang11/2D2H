/* ===== SolidFit: hand-drawn solids → sphere, cube/box, cylinder or cone =====
   Works in screen pixels (y down). The ink is compared with a few line-drawing templates
   (the way solids are drawn in a textbook), each fitted to the drawing's bounding box:
     sphere    a circle (an equator ellipse is optional)
     cylinder  top ellipse, two sides, front half of the bottom (the back half is optional)
     cone      apex, two sides, front half of the base (apex up), or an "ice cream" cone (apex down)
     box/cube  a rectangle (front face only), or front + back faces with the corners joined
   Score = how far the ink is from the template + how much of the template's visible lines
   have no ink near them, both relative to the drawing's size. Shaky, overshooting and
   multi-stroke drawings still land on the right template; scribbles score badly and are refused. */
const SolidFit = (() => {
  const HYPOT = Math.hypot;
  function resample(st, step) {
    const out = [[st[0][0], st[0][1]]];
    let px = st[0][0], py = st[0][1], carry = 0;
    for (let i = 1; i < st.length; i++) {
      const qx = st[i][0], qy = st[i][1];
      let seg = HYPOT(qx - px, qy - py);
      while (carry + seg >= step) {
        const t = (step - carry) / seg;
        px += (qx - px) * t; py += (qy - py) * t; seg = HYPOT(qx - px, qy - py); carry = 0;
        out.push([px, py]);
      }
      carry += seg; px = qx; py = qy;
    }
    const l = st[st.length - 1];
    if (HYPOT(l[0] - out[out.length - 1][0], l[1] - out[out.length - 1][1]) > step * 0.4) out.push([l[0], l[1]]);
    return out;
  }
  function smooth(p) {
    if (p.length < 5) return p;
    return p.map((q, i) => {
      if (i < 2 || i > p.length - 3) return q;
      let x = 0, y = 0; for (let k = -2; k <= 2; k++) { x += p[i + k][0]; y += p[i + k][1]; }
      return [x / 5, y / 5];
    });
  }
  // ---- template pieces, sampled every `sp` px ----
  function line(out, ax, ay, bx, by, sp) {
    const n = Math.max(1, Math.ceil(HYPOT(bx - ax, by - ay) / sp));
    for (let i = 0; i <= n; i++) out.push(ax + (bx - ax) * i / n, ay + (by - ay) * i / n);
  }
  function arc(out, cx, cy, rx, ry, a0, a1, sp) {   // angles in radians, y down: a = 0 right, π/2 bottom
    const len = Math.abs(a1 - a0) * Math.max(rx, ry, 1);
    const n = Math.max(4, Math.ceil(len / sp));
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
  }
  // mean of capped nearest distances from every point of A to the point set B (flat arrays)
  function meanNear(A, B, cap) {
    let s = 0; const nA = A.length >> 1, nB = B.length >> 1;
    if (!nA) return 0; if (!nB) return cap;
    const c2 = cap * cap;
    for (let i = 0; i < nA; i++) {
      const x = A[2 * i], y = A[2 * i + 1]; let m = c2;
      for (let j = 0; j < nB; j++) { const dx = B[2 * j] - x; if (dx * dx >= m) continue; const dy = B[2 * j + 1] - y, d = dx * dx + dy * dy; if (d < m) m = d; }
      s += Math.sqrt(m);
    }
    return s / nA;
  }
  const PRIOR = { sphere: 0, ellipsoid: 0.003, rect: 0, cylinder: 0.004, cone: 0.004, vcone: 0.005, boxback: 0.006,
    hemisphere: 0.004, dome: 0.004, paraboloid: 0.005, dcone: 0.006, hyperboloid: 0.007, hyperboloidtwo: 0.008, tetra: 0.004, saddle: 0.008 };
  // a curve through points given as functions of s in [-1, 1]
  function curve(out, fx, fy, sp, n = 60) { for (let i = 0; i <= n; i++) { const t = -1 + 2 * i / n; out.push(fx(t), fy(t)); } }
  function thin(arr, maxN) { const n = arr.length >> 1; if (n <= maxN) return Float64Array.from(arr); const k = n / maxN, out = new Float64Array(maxN * 2); for (let i = 0; i < maxN; i++) { const j = Math.floor(i * k); out[2 * i] = arr[2 * j]; out[2 * i + 1] = arr[2 * j + 1]; } return out; }

  /* strokes: [[[x, y], ...], ...] in screen px (y down) */
  function recognize(strokes) {
    strokes = strokes.filter(s => s && s.length > 1);
    if (!strokes.length) return { error: 'too-short' };
    let X0 = Infinity, X1 = -Infinity, Y0 = Infinity, Y1 = -Infinity, len = 0;
    for (const st of strokes) for (let i = 0; i < st.length; i++) {
      const [x, y] = st[i]; X0 = Math.min(X0, x); X1 = Math.max(X1, x); Y0 = Math.min(Y0, y); Y1 = Math.max(Y1, y);
      if (i) len += HYPOT(x - st[i - 1][0], y - st[i - 1][1]);
    }
    const W = X1 - X0, H = Y1 - Y0, D = HYPOT(W, H);
    if (D < 24 || len < 40) return { error: 'too-short' };
    if (Math.min(W, H) < 0.12 * Math.max(W, H)) return { error: 'flat' };
    const sp = D / 140, cap = 0.2 * D;
    const inkArr = [];
    for (const st of strokes) for (const p of smooth(resample(st, sp))) inkArr.push(p[0], p[1]);
    const ink = thin(inkArr, 220);
    const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
    const cands = [];
    const evalT = (type, ess, opt, dims, extra = 0) => {
      const all = thin(ess.concat(opt), 420), E = thin(ess, 260);
      const a = meanNear(ink, all, cap) / D, b = meanNear(E, ink, cap) / D;
      cands.push({ type, dims, inkErr: a, cover: b, score: a + 0.85 * b + PRIOR[type] + extra });
    };
    // sphere: a round outline (the bbox ellipse); an oval one is an ellipsoid; equators are optional extras
    const asp = W / H, la = Math.abs(Math.log(asp));
    {
      const ess = [], opt = [], rx = W / 2, ry = H / 2;
      arc(ess, cx, cy, rx, ry, 0, 2 * Math.PI, sp);
      for (const k of [0.1, 0.18, 0.26, 0.34]) arc(opt, cx, cy, rx, ry * k * 2, 0, 2 * Math.PI, sp);
      if (la < 0.33) evalT('sphere', ess, opt, { r: (W + H) / 4 }, Math.max(0, la - 0.14) * 0.12);
      if (la > 0.08) { const o2 = []; arc(o2, cx, cy, rx, ry * 0.4, 0, 2 * Math.PI, sp); evalT('ellipsoid', ess, o2, { a: W / 2, c: H / 2 }, Math.max(0, 0.22 - la) * 0.05); }
    }
    // cylinder / cones: ellipses of half-height ry (relative to the width)
    const RY = [0.05, 0.07, 0.09, 0.11, 0.14, 0.18, 0.22, 0.27, 0.33, 0.4];
    for (const k of RY) {
      const ry = k * W, rx = W / 2, flat = Math.max(0, 0.09 - k) * 0.2;   // a nearly flat base would just be a line
      if (k >= 0.07 && H - 2 * ry > 0.22 * W) {   // cylinder (a very flat top would just be a line)
        const ess = [], opt = [], yt = Y0 + ry, yb = Y1 - ry;
        arc(ess, cx, yt, rx, ry, 0, 2 * Math.PI, sp);
        line(ess, X0, yt, X0, yb, sp); line(ess, X1, yt, X1, yb, sp);
        arc(ess, cx, yb, rx, ry, 0, Math.PI, sp); arc(opt, cx, yb, rx, ry, Math.PI, 2 * Math.PI, sp);
        evalT('cylinder', ess, opt, { r: rx, h: yb - yt }, Math.max(0, 0.11 - k) * 0.2);
      }
      if (H - ry > 0.3 * W) {
        for (const off of [-0.12, 0, 0.12]) {   // apex up: a point on top, base ellipse at the bottom
          const ax = cx + off * W, yb = Y1 - ry, ess = [], opt = [];
          line(ess, ax, Y0, X0, yb, sp); line(ess, ax, Y0, X1, yb, sp);
          arc(ess, cx, yb, rx, ry, 0, Math.PI, sp); arc(opt, cx, yb, rx, ry, Math.PI, 2 * Math.PI, sp);
          evalT('cone', ess, opt, { r: rx, h: yb - Y0 }, Math.abs(off) * 0.01 + flat);
        }
        for (const off of [-0.12, 0, 0.12]) {   // apex down: an open ellipse on top
          const ax = cx + off * W, yt = Y0 + ry, ess = [];
          arc(ess, cx, yt, rx, ry, 0, 2 * Math.PI, sp);
          line(ess, X0, yt, ax, Y1, sp); line(ess, X1, yt, ax, Y1, sp);
          evalT('vcone', ess, [], { r: rx, h: Y1 - yt }, Math.abs(off) * 0.01 + flat);
        }
        {   // rounded tops over a base ellipse: hemisphere (half an ellipse) and paraboloid opening down (∩)
          const yb = Y1 - ry, hg = yb - Y0, base = [], back = [];
          arc(base, cx, yb, rx, ry, 0, Math.PI, sp); arc(back, cx, yb, rx, ry, Math.PI, 2 * Math.PI, sp);
          const hs = base.slice(); arc(hs, cx, yb, rx, hg, Math.PI, 2 * Math.PI, sp);
          evalT('hemisphere', hs, back, { r: (rx + hg) / 2 }, Math.abs(Math.log(hg / rx)) * 0.012 + flat);
          const dm = base.slice(); curve(dm, t => cx + rx * t, t => yb - hg * (1 - t * t), sp);
          evalT('dome', dm, back, { r: rx, h: hg }, flat);
        }
        {   // paraboloid opening up: an open ellipse on top of a U
          const yt = Y0 + ry, hg = Y1 - yt, ess = [];
          arc(ess, cx, yt, rx, ry, 0, 2 * Math.PI, sp); curve(ess, t => cx + rx * t, t => yt + hg * (1 - t * t), sp);
          evalT('paraboloid', ess, [], { r: rx, h: hg }, flat);
        }
      }
      if (k >= 0.07 && H - 2 * ry > 0.45 * W) {   // two ellipses joined: double cone (X), hyperboloids
        const yt = Y0 + ry, yb = Y1 - ry, ym = (yt + yb) / 2, hh = (yb - yt) / 2, top = [], bot = [], back = [];
        arc(top, cx, yt, rx, ry, 0, 2 * Math.PI, sp); arc(bot, cx, yb, rx, ry, 0, Math.PI, sp); arc(back, cx, yb, rx, ry, Math.PI, 2 * Math.PI, sp);
        { const ess = top.concat(bot); line(ess, X0, yt, X1, yb, sp); line(ess, X1, yt, X0, yb, sp); evalT('dcone', ess, back, { r: rx, h: hh }); }
        for (const w of [0.3, 0.45, 0.6]) {   // one sheet: sides pinched to a waist )(
          const ess = top.concat(bot), opt = back.slice();
          for (const sg of [-1, 1]) curve(ess, t => cx + sg * rx * Math.sqrt(w * w + (1 - w * w) * t * t), t => ym + hh * t, sp);
          arc(opt, cx, ym, rx * w, ry * w, 0, Math.PI, sp);
          evalT('hyperboloid', ess, opt, { a: w * rx, R: rx, h: hh });
        }
        for (const gp of [0.12, 0.2, 0.3]) {   // two sheets: a bowl opening up on top, one opening down below
          const g = gp * (yb - yt), v1 = ym - g / 2, v2 = ym + g / 2, ess = top.concat(bot);
          curve(ess, t => cx + rx * t, t => yt + (v1 - yt) * (1 - t * t), sp); curve(ess, t => cx + rx * t, t => yb - (yb - v2) * (1 - t * t), sp);
          evalT('hyperboloidtwo', ess, back, { R: rx, h: hh, c: g / 2 });
        }
      }
    }
    // a rectangle: the front face only
    {
      const ess = [];
      line(ess, X0, Y0, X1, Y0, sp); line(ess, X1, Y0, X1, Y1, sp); line(ess, X1, Y1, X0, Y1, sp); line(ess, X0, Y1, X0, Y0, sp);
      evalT('rect', ess, [], { w: W, h: H, d: 0 });
    }
    // front face + back face (up and to one side), corners joined; hidden edges optional
    for (const fx of [0.14, 0.2, 0.26, 0.32, 0.4, 0.48]) for (const fy of [0.14, 0.2, 0.26, 0.32, 0.4, 0.48]) for (const sg of [1, -1]) {
      const dx = sg * fx * W, dy = -fy * H, wf = W - fx * W, hf = H - fy * H;
      if (wf < 0.2 * W || hf < 0.2 * H) continue;
      const fx0 = sg > 0 ? X0 : X0 + fx * W, fy0 = Y0 + fy * H;   // front face top-left
      const P = [[fx0, fy0], [fx0 + wf, fy0], [fx0 + wf, fy0 + hf], [fx0, fy0 + hf]];   // TL TR BR BL
      const Q = P.map(([x, y]) => [x + dx, y + dy]);
      const ess = [], opt = [];
      for (let i = 0; i < 4; i++) line(ess, P[i][0], P[i][1], P[(i + 1) % 4][0], P[(i + 1) % 4][1], sp);
      // back face: top edge and the outer side are visible, the other two hidden
      const outer = sg > 0 ? [1, 2] : [3, 0], inner = sg > 0 ? [3, 0] : [1, 2];
      line(ess, Q[0][0], Q[0][1], Q[1][0], Q[1][1], sp);
      line(ess, Q[outer[0]][0], Q[outer[0]][1], Q[outer[1]][0], Q[outer[1]][1], sp);
      line(opt, Q[2][0], Q[2][1], Q[3][0], Q[3][1], sp);
      line(opt, Q[inner[0]][0], Q[inner[0]][1], Q[inner[1]][0], Q[inner[1]][1], sp);
      // connectors: both top corners and the outer bottom corner are visible
      const hid = sg > 0 ? 3 : 2;
      for (let i = 0; i < 4; i++) line(i === hid ? opt : ess, P[i][0], P[i][1], Q[i][0], Q[i][1], sp);
      evalT('boxback', ess, opt, { w: wf, h: hf, d: HYPOT(dx, dy) });
    }
    // a triangle: the plane x/a + y/b + z/c = 1 cut off by the first octant; corners where the ink is highest, leftmost, rightmost
    {
      let iT = 0, iL = 0, iR = 0; const n = ink.length >> 1;
      for (let i = 1; i < n; i++) { if (ink[2 * i + 1] < ink[2 * iT + 1]) iT = i; if (ink[2 * i] < ink[2 * iL]) iL = i; if (ink[2 * i] > ink[2 * iR]) iR = i; }
      const tri = [[ink[2 * iT], Y0, ink[2 * iL + 1], ink[2 * iR + 1]]];
      for (const f of [0.3, 0.5, 0.7]) tri.push([X0 + f * W, Y0, Y1, Y1]);
      for (const [ax, ay, yl, yr] of tri) {
        if (ax - X0 < 0.12 * W || X1 - ax < 0.12 * W || Math.min(yl, yr) - ay < 0.35 * H) continue;
        const ess = []; line(ess, ax, ay, X0, yl, sp); line(ess, X0, yl, X1, yr, sp); line(ess, X1, yr, ax, ay, sp);
        evalT('tetra', ess, [], { a: ax - X0, b: X1 - ax, c: (yl + yr) / 2 - ay });
      }
    }
    // a saddle, as textbooks draw it: the edge of z = k(x² − y²) over a square, seen from the side and above
    for (const yaw of [-0.66, -0.52, 0.52, 0.66]) for (const kn of [0.4, 0.55, 0.7, 0.85, 1]) {
      const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw), cp0 = Math.cos(0.45), sp0 = Math.sin(0.45);
      const pr = (x, y) => { const z = kn * (x * x - y * y), xr = x * cy0 - y * sy0, yr = x * sy0 + y * cy0; return [xr, -(z * cp0 + yr * sp0)]; };
      const edge = [], mid = [];
      for (const [fx, fy] of [[t => t, () => -1], [() => 1, t => t], [t => -t, () => 1], [() => -1, t => -t]]) for (let i = 0; i <= 40; i++) { const t = -1 + i / 20; edge.push(pr(fx(t), fy(t))); }
      for (let i = 0; i <= 40; i++) { const t = -1 + i / 20; mid.push(pr(t, 0)); } for (let i = 0; i <= 40; i++) { const t = -1 + i / 20; mid.push(pr(0, t)); }
      let mx0 = Infinity, mx1 = -Infinity, my0 = Infinity, my1 = -Infinity; for (const [x, y] of edge) { mx0 = Math.min(mx0, x); mx1 = Math.max(mx1, x); my0 = Math.min(my0, y); my1 = Math.max(my1, y); }
      const k = W / (mx1 - mx0), ky = H / (my1 - my0), oy = cy - (my0 + my1) / 2 * ky, ox = cx - (mx0 + mx1) / 2 * k;   // stretched to the drawing
      const ess = [], opt = []; for (const [x, y] of edge) ess.push(ox + x * k, oy + y * ky); for (const [x, y] of mid) opt.push(ox + x * k, oy + y * ky);
      evalT('saddle', ess, opt, { s: W / (2 * (Math.abs(cy0) + Math.abs(sy0))), kn: kn * ky / k }, Math.abs(Math.log(ky / k)) * 0.02);
    }
    cands.sort((a, b) => a.score - b.score);
    const best = cands[0];
    if (!best || best.score > 0.053 || best.inkErr > 0.045) return { error: 'messy', score: best && best.score, type: best && best.type };
    const out = [];
    const push = c => {
      const s = toSolid(c); if (!s) return;
      for (const o of s) if (!out.some(q => q.type === o.type)) out.push({ ...o, score: c.score });
    };
    push(best);
    for (const c of cands.slice(1)) { if (out.length >= 4) break; if (c.score > best.score * 1.45 + 0.006) break; push(c); }
    return { best: out[0], alts: out.slice(1), cands: cands.slice(0, 6).map(c => ({ type: c.type, score: +c.score.toFixed(4) })) };
  }
  // template → solid (pixel sizes); boxes come with both readings (cube and box)
  function toSolid(c) {
    const d = c.dims;
    if (c.type === 'sphere') return [{ type: 'sphere', r: d.r }];
    if (c.type === 'ellipsoid') return [{ type: 'ellipsoid', a: d.a, c: d.c }];
    if (c.type === 'hemisphere') return [{ type: 'hemisphere', r: d.r }];
    if (c.type === 'dome' || c.type === 'paraboloid' || c.type === 'dcone') return [{ type: c.type, r: d.r, h: d.h }];
    if (c.type === 'hyperboloid') return [{ type: 'hyperboloid', a: d.a, R: d.R, h: d.h }];
    if (c.type === 'hyperboloidtwo') return [{ type: 'hyperboloidtwo', R: d.R, h: d.h, c: d.c }];
    if (c.type === 'tetra') return [{ type: 'tetra', a: d.a, b: d.b, c: d.c }];
    if (c.type === 'saddle') return [{ type: 'saddle', s: d.s, kn: d.kn }];
    if (c.type === 'cylinder') return [{ type: 'cylinder', r: d.r, h: d.h }];
    if (c.type === 'cone' || c.type === 'vcone') return [{ type: c.type, r: d.r, h: d.h }];
    if (c.type === 'rect') {
      const s = (d.w + d.h) / 2, sq = d.w / d.h > 0.8 && d.w / d.h < 1.25;
      const box = { type: 'box', a: d.w, b: Math.min(d.w, d.h), c: d.h, front: true };
      return sq ? [{ type: 'cube', s, front: true }, box] : [box, { type: 'cube', s, front: true }];
    }
    if (c.type === 'boxback') {
      const s = (d.w + d.h) / 2, depth = 2 * d.d, sq = d.w / d.h > 0.75 && d.w / d.h < 1.33 && depth / s > 0.45 && depth / s < 1.6;
      const box = { type: 'box', a: d.w, b: depth, c: d.h };
      return sq ? [{ type: 'cube', s }, box] : [box, { type: 'cube', s }];
    }
    return null;
  }
  return { recognize };
})();
if (typeof module !== 'undefined') module.exports = { SolidFit };
