/* ===== Live Math Notebook app ===== */
(() => {
'use strict';
const ME = MathEngine;
const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const S = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };
const clone = o => JSON.parse(JSON.stringify(o));
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const PAGE_W = 816, PAGE_H = 1056, PAGE_GAP = 40;
const INK = ['#1c2321', '#2f6fde', '#e0443a', '#1f9d55', '#7a52d1'];
const PENCIL = ['#3e4643', '#3a72cf', '#c54a3c', '#2c8a54', '#6d55bf'];
const HLC = ['#f3e24a', '#a6ea8e', '#6fdde6', '#ffaecb'];
const GCOL = ['#0b8aa4', '#e5484d', '#3f9b3a', '#7c5cff', '#e48a0c', '#2b6fe0'];
const ANSWER = '#f0581f';
const WIDTHS = { pen: [1.6, 2.6, 4.2], pencil: [1.3, 2.1, 3.2], hl: [12, 18, 28], eraser: [8, 16, 30] };
const STORE_KEY = 'live-math-notebook-v1';

/* ---------- state ---------- */
const newDoc = (t = 'grid') => ({ v: 2, pages: 2, template: t, pageList: [{ t }, { t }], imgs: [], strokes: {}, order: [], lines: [], graphs: [], params: {}, nextId: 1 });
let doc = newDoc();
const uid = () => doc.nextId++;
const ui = { tool: 'pen', color: { pen: INK[0], pencil: PENCIL[0], hl: HLC[0] }, width: { pen: 1, pencil: 1, hl: 1, eraser: 1 }, autoRead: true, autoGraph: false, sidebar: window.innerWidth > 900 };
const view = { tx: 0, ty: 0, s: 1 };
let scope = {};
const bbCache = new Map();
const inkDirty = new Set();
const anCache = new Map();

/* ---------- DOM ---------- */
const viewport = $('#viewport'), world = $('#world'), svg = $('#ink');
const gPages = $('#gPages'), gImg = $('#gImg'), gHL = $('#gHL'), gInk = $('#gInk'), gOver = $('#gOver'), gTemp = $('#gTemp'), gAnts = $('#gAnts'), svgTop = $('#inkTop');
const chipLayer = $('#chips'), graphLayer = $('#graphs');
const strokeEls = new Map();

/* ---------- history ---------- */
const undoStack = [], redoStack = [];
let tx = null;
function snapMeta() { return { lines: clone(doc.lines), graphs: clone(doc.graphs), params: clone(doc.params), pages: doc.pages, template: doc.template, order: doc.order.slice(), pageList: clone(doc.pageList || []), imgs: clone(doc.imgs || []) }; }
function beginTx() { if (tx) return false; tx = { before: snapMeta(), touched: new Map() }; return true; }
function touch(id) { if (tx && !tx.touched.has(id)) tx.touched.set(id, doc.strokes[id] ? clone(doc.strokes[id]) : null); bbCache.delete(id); inkDirty.add(id); }
function endTx() {
  if (!tx) return;
  const t = tx; tx = null;
  const after = snapMeta();
  const sa = new Map();
  for (const id of t.touched.keys()) sa.set(id, doc.strokes[id] ? clone(doc.strokes[id]) : null);
  const changed = t.touched.size || JSON.stringify(t.before) !== JSON.stringify(after);
  if (!changed) return;
  undoStack.push({ before: t.before, after, sb: t.touched, sa });
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  updateUndo(); scheduleSave();
}
function transact(fn) { const own = beginTx(); try { fn(); } finally { if (own) endTx(); } }
function applyState(meta, strokes) {
  for (const [id, s] of strokes) { if (s) doc.strokes[id] = clone(s); else delete doc.strokes[id]; bbCache.delete(id); }
  doc.lines = clone(meta.lines); doc.graphs = clone(meta.graphs); doc.params = clone(meta.params);
  doc.pages = meta.pages; doc.template = meta.template; doc.order = meta.order.slice();
  if (meta.pageList) doc.pageList = clone(meta.pageList); if (meta.imgs) doc.imgs = clone(meta.imgs); normalizeDoc(doc);
  for (const l of doc.lines) for (const id of l.strokeIds) if (doc.strokes[id]) doc.strokes[id].lineId = l.id;
  for (const l of doc.lines) if (l.status === 'reading' || l.status === 'pending') { l.status = 'stale'; l.dirty = true; }
  closePop(); clearSelection();
  bbCache.clear(); thumbCache.clear();
  renderAll();
}
function undo() { const e = undoStack.pop(); if (!e) return; applyState(e.before, e.sb); redoStack.push(e); updateUndo(); scheduleSave(); }
function redo() { const e = redoStack.pop(); if (!e) return; applyState(e.after, e.sa); undoStack.push(e); updateUndo(); scheduleSave(); }
function updateUndo() { $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length; }

/* ---------- strokes ---------- */
function bbox(s) {
  let b = bbCache.get(s.id);
  if (b) return b;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  b = { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  bbCache.set(s.id, b);
  return b;
}
function unionBB(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of list) { if (!b) continue; x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
function idsBB(ids) { return unionBB(ids.map(id => doc.strokes[id] && bbox(doc.strokes[id]))); }
function addStroke(s) { touch(s.id); doc.strokes[s.id] = s; doc.order.push(s.id); }
function removeStroke(id) {
  const s = doc.strokes[id]; if (!s) return;
  touch(id);
  if (s.lineId) { const l = lineById(s.lineId); if (l) { l.strokeIds = l.strokeIds.filter(x => x !== id); lineChanged(l); if (l.barId === id) { delete l.layout; l.barId = null; } } }
  delete doc.strokes[id];
  doc.order = doc.order.filter(x => x !== id);
}
function moveStroke(id, dx, dy) { const s = doc.strokes[id]; if (!s) return; touch(id); for (const p of s.pts) { p[0] = r1(p[0] + dx); p[1] = r1(p[1] + dy); } }

function outlinePath(pts, w) {
  const n = pts.length;
  if (!n) return '';
  const first = pts[0], last = pts[n - 1];
  if (n < 3 && Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.8) {
    const r = w * 0.6;
    return `M${first[0] - r} ${first[1]}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  }
  let ws = pts.map(p => w * (0.32 + 0.88 * (p[2] == null ? 0.55 : p[2])));
  for (let pass = 0; pass < 2; pass++) ws = ws.map((v, i) => (ws[Math.max(0, i - 1)] + 2 * v + ws[Math.min(n - 1, i + 1)]) / 4);
  const L = [], R = [];
  const span = Math.max(1.2, w * 0.5);
  for (let i = 0; i < n; i++) {
    let j = i, k = i;
    while (j > 0 && Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]) < span) j--;
    while (k < n - 1 && Math.hypot(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1]) < span) k++;
    const a = pts[j], b = pts[k];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
    const h = ws[i] / 2;
    L.push([pts[i][0] - ty * h, pts[i][1] + tx * h]);
    R.push([pts[i][0] + ty * h, pts[i][1] - tx * h]);
  }
  const f = v => v.toFixed(1);
  const curve = (P) => {
    let d = '';
    for (let i = 1; i < P.length - 1; i++) d += `Q${f(P[i][0])} ${f(P[i][1])} ${f((P[i][0] + P[i + 1][0]) / 2)} ${f((P[i][1] + P[i + 1][1]) / 2)}`;
    d += `L${f(P[P.length - 1][0])} ${f(P[P.length - 1][1])}`;
    return d;
  };
  const re = ws[n - 1] / 2, rs = ws[0] / 2;
  const Rr = R.slice().reverse();
  return `M${f(L[0][0])} ${f(L[0][1])}` + curve(L) + `A${f(re)} ${f(re)} 0 0 0 ${f(R[n - 1][0])} ${f(R[n - 1][1])}` + curve(Rr) + `A${f(rs)} ${f(rs)} 0 0 0 ${f(L[0][0])} ${f(L[0][1])}Z`;
}
function centerPath(pts) {
  const f = v => v.toFixed(1);
  if (pts.length === 1) return `M${f(pts[0][0])} ${f(pts[0][1])}l0.1 0.1`;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f((pts[i][0] + pts[i + 1][0]) / 2)} ${f((pts[i][1] + pts[i + 1][1]) / 2)}`;
  d += `L${f(pts[pts.length - 1][0])} ${f(pts[pts.length - 1][1])}`;
  return d;
}
const pencilPats = new Map();
const PENCIL_SPECKS = (() => { let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; let d = ''; for (let i = 0; i < 16; i++) { const x = rnd() * 9, y = rnd() * 9, w = 0.5 + rnd() * 0.7, h = 0.4 + rnd() * 0.5; d += `M${x.toFixed(2)} ${y.toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h${(-w).toFixed(2)}z`; } return d; })();
function pencilPaint(color) {
  let id = pencilPats.get(color);
  if (!id) {
    id = 'pp' + pencilPats.size;
    const pat = S('pattern', { id, width: 9, height: 9, patternUnits: 'userSpaceOnUse' });
    pat.appendChild(S('rect', { width: 9, height: 9, fill: color }));
    pat.appendChild(S('path', { d: PENCIL_SPECKS, fill: '#fff', opacity: 0.42 }));
    svg.querySelector('defs').appendChild(pat);
    pencilPats.set(color, id);
  }
  return `url(#${id})`;
}
function styleStrokeEl(el, s) {
  if (s.tool === 'pen') {
    el.setAttribute('d', outlinePath(s.pts, s.w)); el.setAttribute('fill', s.color);
    el.removeAttribute('stroke'); el.removeAttribute('filter'); el.removeAttribute('opacity');
  } else {
    el.setAttribute('d', centerPath(s.pts)); el.setAttribute('fill', 'none'); el.setAttribute('stroke', s.color);
    el.setAttribute('stroke-width', s.w); el.setAttribute('stroke-linejoin', 'round');
    if (s.tool === 'pencil') { el.setAttribute('stroke-linecap', 'round'); el.setAttribute('opacity', '0.9'); el.setAttribute('stroke', pencilPaint(s.color)); el.removeAttribute('filter'); }
    else { el.setAttribute('stroke-linecap', 'butt'); el.setAttribute('opacity', '0.42'); el.removeAttribute('filter'); }
  }
}
function renderStroke(s) {
  let el = strokeEls.get(s.id);
  if (!el) { el = S('path'); el.dataset.id = s.id; strokeEls.set(s.id, el); (s.tool === 'hl' ? gHL : gInk).appendChild(el); }
  styleStrokeEl(el, s);
}
function syncInk(full) {
  for (const [id, el] of strokeEls) if (!doc.strokes[id] || full) { el.remove(); strokeEls.delete(id); }
  if (full) { for (const id of doc.order) { const s = doc.strokes[id]; if (s) renderStroke(s); } }
  else { for (const id of inkDirty) { const s = doc.strokes[id]; if (s) renderStroke(s); } }
  inkDirty.clear();
}

/* ---------- pages ---------- */
function pageY(i) { return i * (PAGE_H + PAGE_GAP); }
function renderPages() {
  gPages.innerHTML = '';
  const H = pageY(doc.pages) - PAGE_GAP;
  for (const el of [svg, svgTop]) { el.setAttribute('width', PAGE_W); el.setAttribute('height', H); el.setAttribute('viewBox', `0 0 ${PAGE_W} ${H}`); }
  world.style.width = PAGE_W + 'px'; world.style.height = H + 'px';
  for (let i = 0; i < doc.pages; i++) {
    const p = doc.pageList[i] || { t: doc.template }, y = pageY(i);
    gPages.appendChild(S('rect', { x: 0, y, width: PAGE_W, height: PAGE_H, class: 'page', rx: 3 }));
    if (p.bg && imgData.get(p.bg.key)) gPages.appendChild(S('image', { href: imgData.get(p.bg.key), x: p.bg.x, y: y + p.bg.y, width: p.bg.w, height: p.bg.h, preserveAspectRatio: 'none', class: 'pbg' }));
    if (p.t && p.t !== 'blank') gPages.appendChild(S('rect', { x: 0, y, width: PAGE_W, height: PAGE_H, fill: `url(#pat-${p.t})`, rx: 3 }));
    if (p.t === 'lined') gPages.appendChild(S('line', { x1: 84, x2: 84, y1: y, y2: y + PAGE_H, stroke: '#f2b0a8', 'stroke-width': 1.2 }));
    if (p.bm) gPages.appendChild(S('path', { d: `M${PAGE_W - 64} ${y} h24 v36 l-12 -9 l-12 9 z`, class: 'ribbon' }));
    const t = S('text', { x: PAGE_W - 20, y: y + PAGE_H - 16, 'text-anchor': 'end', class: 'pageno' }); t.textContent = String(i + 1);
    gPages.appendChild(t);
  }
  renderImgs();
  $('#addPage').style.top = (H + 18) + 'px';
}
function setTemplate(t, all) {
  const i = currentPage();
  transact(() => { if (all) { doc.pageList.forEach(p => { p.t = t; }); doc.template = t; } else doc.pageList[i].t = t; });
  renderPages(); markPaperMenu(); sb.dirty.add(i); if (all) renderSidebar(true); else scheduleThumbs(100);
}

/* ---------- view ---------- */
function applyView() {
  world.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`;
  positionOverlays();
  updatePageUI();
  clearTimeout(applyView.t);
  applyView.t = setTimeout(() => { for (const g of doc.graphs) queueGraph(g.id); }, 160);
}
function toWorld(cx, cy) { const r = viewport.getBoundingClientRect(); return [(cx - r.left - view.tx) / view.s, (cy - r.top - view.ty) / view.s]; }
function toScreen(wx, wy) { const r = viewport.getBoundingClientRect(); return [wx * view.s + view.tx + r.left, wy * view.s + view.ty + r.top]; }
function zoomAt(cx, cy, factor) {
  const r = viewport.getBoundingClientRect();
  const ns = clamp(view.s * factor, 0.25, 5);
  const k = ns / view.s;
  const px = cx - r.left, py = cy - r.top;
  view.tx = px - (px - view.tx) * k; view.ty = py - (py - view.ty) * k; view.s = ns;
  applyView();
}
function fitWidth() {
  const r = viewport.getBoundingClientRect();
  view.s = clamp((r.width - 32) / PAGE_W, 0.3, 1.25);
  view.tx = (r.width - PAGE_W * view.s) / 2; view.ty = 16;
  applyView();
}

/* ---------- lines (recognized math) ---------- */
const lineById = id => doc.lines.find(l => l.id === id);
function lineStrokes(l) { return l.strokeIds.map(id => doc.strokes[id]).filter(Boolean); }
function lineBB(l) { return idsBB(l.strokeIds); }
function clusterBB(c) { return idsBB(c.ids); }
function lineCharH(l) {
  if (l.charH) return l.charH;
  const hs = (l.clusters || []).map(c => clusterBB(c)).filter(b => b.h > b.w * 0.35).map(b => b.h).sort((a, b) => a - b);
  return hs.length ? hs[Math.floor(hs.length / 2)] : Math.max(20, lineBB(l).h * 0.7);
}
function anOf(l) {
  const c = anCache.get(l.id);
  if (c && c.expr === l.expr) return c.an;
  const an = l.expr ? analyzeStatement(l.expr) : { kind: 'none' };
  try {
    const C = {};
    if (an.kind === 'function') { C.f = ME.compile(an.f); try { an.df = ME.derivative(an.f, 'x'); C.df = ME.compile(an.df); } catch (e) { an.df = null; } }
    else if (an.kind === 'polar') C.f = ME.compile(an.f);
    else if (an.kind === 'parametric') { C.fx = ME.compile(an.fx); C.fy = ME.compile(an.fy); }
    else if (an.kind === 'implicit' || an.kind === 'solve') C.g = ME.compile(an.g);
    else if (an.kind === 'surface') {
      C.f = ME.compile(an.f);
      try { an.fxN = ME.derivative(an.f, 'x'); an.fyN = ME.derivative(an.f, 'y'); C.fx = ME.compile(an.fxN); C.fy = ME.compile(an.fyN); } catch (e) { an.fxN = an.fyN = null; }
      try { an.fxxN = ME.derivative(an.fxN, 'x'); an.fyyN = ME.derivative(an.fyN, 'y'); an.fxyN = ME.derivative(an.fxN, 'y'); C.fxx = ME.compile(an.fxxN); C.fyy = ME.compile(an.fyyN); C.fxy = ME.compile(an.fxyN); } catch (e) { an.fxxN = null; }
    }
    else if (an.kind === 'curve3d') { C.fx = ME.compile(an.fx); C.fy = ME.compile(an.fy); C.fz = ME.compile(an.fz); }
    else if (an.kind === 'implicit3d') C.g = ME.compile(an.g);
    else if (an.kind === 'solid') C.vals = an.args.map(a => ME.compile(a));
    else if (an.kind === 'evaluate' || an.kind === 'value') C.lhs = ME.compile(an.lhs);
    else if (an.kind === 'check') { C.lhs = ME.compile(an.lhs); C.rhs = ME.compile(an.rhs); }
    else if (an.kind === 'assign') C.rhs = ME.compile(an.rhs);
    an.c = C;
  } catch (e) { an.kind = 'error'; an.error = e.message; }
  anCache.set(l.id, { expr: l.expr, an });
  return an;
}
const GRAPHABLE = new Set(['function', 'polar', 'parametric', 'implicit', 'surface', 'curve3d', 'implicit3d', 'solid']);
const GRAPH3D = new Set(['surface', 'curve3d', 'implicit3d', 'solid']);
/* ---------- solids: sphere, cube, box, cylinder, cone (point up) and vcone (point down) ----------
   Spheres sit at the origin; the others stand on the xy-plane, centred on the z-axis. */
const SOLID = {
  sphere: { name: 'Sphere', p: ['radius'] },
  ellipsoid: { name: 'Ellipsoid', p: ['radius a (x, y)', 'half-height c (z)'] },
  hemisphere: { name: 'Hemisphere', p: ['radius'] },
  cube: { name: 'Cube', p: ['side'] },
  box: { name: 'Box', p: ['width (x)', 'depth (y)', 'height (z)'] },
  cylinder: { name: 'Cylinder', p: ['radius', 'height'] },
  cone: { name: 'Cone', p: ['radius', 'height'] },
  vcone: { name: 'Cone', p: ['radius', 'height'] },
  dcone: { name: 'Double cone', p: ['radius', 'half-height'], surf: true },
  paraboloid: { name: 'Paraboloid', p: ['radius', 'height'] },
  dome: { name: 'Paraboloid, opening down', p: ['radius', 'height'] },
  hyperboloid: { name: 'Hyperboloid of one sheet', p: ['waist radius a', 'c', 'half-height'], surf: true },
  hyperboloidtwo: { name: 'Hyperboloid of two sheets', p: ['a', 'vertex height c', 'half-height'], surf: true },
  saddle: { name: 'Saddle (hyperbolic paraboloid)', p: ['steepness k', 'half-width'], surf: true },
  tetra: { name: 'Plane in the first octant', p: ['x-intercept a', 'y-intercept b', 'z-intercept c'] }
};
function solidVals(an) { return an.c.vals.map(f => { const v = Math.abs(f(scope)); return isFinite(v) && v > 1e-6 ? v : 1e-6; }); }
const hypR = (a, c, h) => a * Math.sqrt(1 + h * h / (c * c));                   // one sheet: radius at |z| = h
const hyp2R = (a, c, h) => a * Math.sqrt(Math.max(0, h * h / (c * c) - 1));       // two sheets: radius at |z| = h
function solidExt(type, v) {
  switch (type) {
    case 'sphere': return { ex: v[0], ey: v[0], z0: -v[0], z1: v[0] };
    case 'ellipsoid': return { ex: v[0], ey: v[0], z0: -v[1], z1: v[1] };
    case 'hemisphere': return { ex: v[0], ey: v[0], z0: 0, z1: v[0] };
    case 'cube': return { ex: v[0] / 2, ey: v[0] / 2, z0: 0, z1: v[0] };
    case 'box': return { ex: v[0] / 2, ey: v[1] / 2, z0: 0, z1: v[2] };
    case 'dcone': return { ex: v[0], ey: v[0], z0: -v[1], z1: v[1] };
    case 'hyperboloid': { const R = hypR(v[0], v[1], v[2]); return { ex: R, ey: R, z0: -v[2], z1: v[2] }; }
    case 'hyperboloidtwo': { const R = Math.max(hyp2R(v[0], v[1], v[2]), 0.3 * v[0]); return { ex: R, ey: R, z0: -v[2], z1: v[2] }; }
    case 'saddle': { const z = v[0] * v[1] * v[1]; return { ex: v[1], ey: v[1], z0: -z, z1: z }; }
    case 'tetra': return { ex: v[0], ey: v[1], x0: 0, x1: v[0], y0: 0, y1: v[1], z0: 0, z1: v[2] };
    default: return { ex: v[0], ey: v[0], z0: 0, z1: v[1] };   // cylinder, cones, paraboloids
  }
}
const fmtS = x => ME.fmt(+(+x).toFixed(2)).replace('-', '−');
function solidInfo(type, v) {   // volume and surface area (HTML formulas); surfaces have neither
  const it = t => `<i>${t}</i>`, sq = t => `${it(t)}<sup>2</sup>`, PI = Math.PI;
  let V = null, Vf = '', S = null, Sf = '';
  if (type === 'sphere') { const r = v[0]; Vf = `⁴⁄₃π${it('r')}<sup>3</sup>`; V = 4 / 3 * PI * r ** 3; Sf = `4π${sq('r')}`; S = 4 * PI * r * r; }
  else if (type === 'ellipsoid') { const [a, c] = v; Vf = `⁴⁄₃π${sq('a')}${it('c')}`; V = 4 / 3 * PI * a * a * c; }
  else if (type === 'hemisphere') { const r = v[0]; Vf = `⅔π${it('r')}<sup>3</sup>`; V = 2 / 3 * PI * r ** 3; Sf = `2π${sq('r')} + π${sq('r')}`; S = 3 * PI * r * r; }
  else if (type === 'cube') { const a = v[0]; Vf = `${it('s')}<sup>3</sup>`; V = a ** 3; Sf = `6${sq('s')}`; S = 6 * a * a; }
  else if (type === 'box') { const [a, b, c] = v; Vf = it('abc'); V = a * b * c; Sf = `2(${it('ab')} + ${it('bc')} + ${it('ca')})`; S = 2 * (a * b + b * c + c * a); }
  else if (type === 'cylinder') { const [r, h] = v; Vf = `π${sq('r')}${it('h')}`; V = PI * r * r * h; Sf = `2π${sq('r')} + 2π${it('rh')}`; S = 2 * PI * r * r + 2 * PI * r * h; }
  else if (type === 'cone' || type === 'vcone') { const [r, h] = v; Vf = `⅓π${sq('r')}${it('h')}`; V = PI * r * r * h / 3; Sf = `π${sq('r')} + π${it('r')}ℓ`; S = PI * r * r + PI * r * Math.hypot(r, h); }
  else if (type === 'paraboloid' || type === 'dome') { const [r, h] = v; Vf = `½π${sq('r')}${it('h')}`; V = PI * r * r * h / 2; }
  else if (type === 'tetra') { const [a, b, c] = v; Vf = `⅙${it('abc')}`; V = a * b * c / 6; }
  return { V, Vf, S, Sf, ell: type === 'cone' || type === 'vcone' ? Math.hypot(v[0], v[1]) : null };
}
// 7/3 for 2.333…: a fraction with a small denominator, when the number isn't already a short decimal
function smallFrac(k) {
  if (Math.abs(k * 100 - Math.round(k * 100)) < 1e-6) return null;
  for (let d = 3; d <= 9; d++) { const n = Math.round(k * d); if (Math.abs(k * d - n) < 1e-6) return [n, d]; }
  return null;
}
/* every drawn shape is made of graphs of functions of x and y over a region D of the xy-plane:
   a solid is the region between two of them, g(x, y) ≤ z ≤ f(x, y)  (a sphere: z = ±√(r² − x² − y²)),
   a surface is one graph (a saddle) or two halves (a hyperboloid: z = ±c√((x² + y²)/a² − 1)) */
function solidFuncs(type, v) {
  const E = x => String(+(+x).toFixed(4)), H = fmtS, it = t => `<i>${t}</i>`, sq = t => `${it(t)}<sup>2</sup>`, xy = `${sq('x')} + ${sq('y')}`, rho = `√(${xy})`;
  const one = k => Math.abs(k - 1) < 1e-9;
  const coefH = k => { if (one(k)) return ''; const fr = smallFrac(k); return fr ? `(<sup>${fr[0]}</sup>⁄<sub>${fr[1]}</sub>)` : H(k); };
  const coefE = k => { if (one(k)) return ''; const fr = smallFrac(k); return fr ? `${fr[0]}/${fr[1]}*` : E(k) + '*'; };
  const over = (t, d, te) => one(d) ? [t, te] : [`(${t})/${H(d)}`, `(${te})/${E(d)}`];   // "(x² + y²)/4"
  const disk = r => ({ kind: 'disk', r, html: `${xy} ≤ ${H(r * r)}`, txt: `x² + y² ≤ ${H(r * r)}` });
  const ring = (r0, r1) => ({ kind: 'annulus', r0, r1, html: `${H(r0 * r0)} ≤ ${xy} ≤ ${H(r1 * r1)}`, txt: `${H(r0 * r0)} ≤ x² + y² ≤ ${H(r1 * r1)}` });
  const rect = (a, b) => ({ kind: 'rect', a, b, html: `|${it('x')}| ≤ ${H(a / 2)},&nbsp; |${it('y')}| ≤ ${H(b / 2)}`, txt: `|x| ≤ ${H(a / 2)}, |y| ≤ ${H(b / 2)}` });
  const flat = h => ({ f: () => h, html: H(h), expr: E(h), flat: true });
  const neg = F => ({ f: (x, y) => -F.f(x, y), html: `−${F.html}`, expr: `-${F.expr}` });
  switch (type) {
    case 'sphere': {
      const r = v[0], R2 = r * r, top = { f: (x, y) => Math.sqrt(Math.max(0, R2 - x * x - y * y)), html: `√(${H(R2)} − ${sq('x')} − ${sq('y')})`, expr: `sqrt(${E(R2)} - x^2 - y^2)` };
      return { D: disk(r), top, bot: neg(top), key: 'top', pm: true, eq: `${xy} + ${sq('z')} = ${H(R2)}` };
    }
    case 'ellipsoid': {
      const [a, c] = v, a2 = a * a, [ih, ie] = over(xy, a2, 'x^2 + y^2');
      const top = { f: (x, y) => c * Math.sqrt(Math.max(0, 1 - (x * x + y * y) / a2)), html: `${coefH(c)}√(1 − ${ih})`, expr: `${coefE(c)}sqrt(1 - ${ie})` };
      return { D: disk(a), top, bot: neg(top), key: 'top', pm: true, eq: `${over(xy, a2, '')[0]} + ${one(c * c) ? sq('z') : `${sq('z')}/${H(c * c)}`} = 1` };
    }
    case 'hemisphere': {
      const r = v[0], R2 = r * r;
      return { D: disk(r), top: { f: (x, y) => Math.sqrt(Math.max(0, R2 - x * x - y * y)), html: `√(${H(R2)} − ${sq('x')} − ${sq('y')})`, expr: `sqrt(${E(R2)} - x^2 - y^2)` }, bot: flat(0), key: 'top' };
    }
    case 'cone': case 'vcone': case 'dcone': {
      const [r, h] = v, k = h / r, side = { f: (x, y) => k * Math.hypot(x, y), html: `${coefH(k)}${rho}`, expr: `${coefE(k)}sqrt(x^2 + y^2)` };
      if (type === 'dcone') return { D: disk(r), top: side, bot: neg(side), key: 'top', pm: true, eq: `${sq('z')} = ${one(k * k) ? '' : H(k * k)}(${xy})` };
      if (type === 'vcone') return { D: disk(r), top: flat(h), bot: side, key: 'bot' };
      return { D: disk(r), top: { f: (x, y) => h - k * Math.hypot(x, y), html: `${H(h)} − ${side.html}`, expr: `${E(h)} - ${side.expr}` }, bot: flat(0), key: 'top' };
    }
    case 'paraboloid': case 'dome': {
      const [r, h] = v, k = h / (r * r), bowl = { f: (x, y) => k * (x * x + y * y), html: one(k) ? xy : `${coefH(k)}(${xy})`, expr: one(k) ? 'x^2 + y^2' : `${coefE(k)}(x^2 + y^2)` };
      if (type === 'paraboloid') return { D: disk(r), top: flat(h), bot: bowl, key: 'bot' };
      return { D: disk(r), top: { f: (x, y) => h - bowl.f(x, y), html: `${H(h)} − ${one(k) ? `(${xy})` : bowl.html}`, expr: `${E(h)} - ${one(k) ? '(x^2 + y^2)' : bowl.expr}` }, bot: flat(0), key: 'top' };
    }
    case 'hyperboloid': {
      const [a, c, h] = v, a2 = a * a, [ih, ie] = over(xy, a2, 'x^2 + y^2');
      const top = { f: (x, y) => c * Math.sqrt(Math.max(0, (x * x + y * y) / a2 - 1)), html: `${coefH(c)}√(${ih} − 1)`, expr: `${coefE(c)}sqrt(${ie} - 1)` };
      return { D: ring(a, hypR(a, c, h)), top, bot: neg(top), key: 'top', pm: true, eq: `${ih} − ${one(c * c) ? sq('z') : `${sq('z')}/${H(c * c)}`} = 1` };
    }
    case 'hyperboloidtwo': {
      const [a, c, h] = v, a2 = a * a, [ih, ie] = over(xy, a2, 'x^2 + y^2');
      const top = { f: (x, y) => c * Math.sqrt(1 + (x * x + y * y) / a2), html: `${coefH(c)}√(1 + ${ih})`, expr: `${coefE(c)}sqrt(1 + ${ie})` };
      return { D: disk(Math.max(hyp2R(a, c, h), 0.3 * a)), top, bot: neg(top), key: 'top', pm: true, eq: `${one(c * c) ? sq('z') : `${sq('z')}/${H(c * c)}`} − ${ih} = 1` };
    }
    case 'saddle': {
      const [k, s] = v, top = { f: (x, y) => k * (x * x - y * y), html: `${one(k) ? '' : coefH(k)}${one(k) ? '' : '('}${sq('x')} − ${sq('y')}${one(k) ? '' : ')'}`, expr: one(k) ? 'x^2 - y^2' : `${coefE(k)}(x^2 - y^2)` };
      return { D: rect(2 * s, 2 * s), top, bot: null, key: 'top' };
    }
    case 'tetra': {
      const [a, b, c] = v, ka = c / a, kb = c / b;
      const top = { f: (x, y) => Math.max(0, c - ka * x - kb * y), html: `${H(c)} − ${coefH(ka)}${it('x')} − ${coefH(kb)}${it('y')}`, expr: `${E(c)} - ${coefE(ka)}x - ${coefE(kb)}y` };
      const fr = (t, d) => one(d) ? it(t) : `${it(t)}/${H(d)}`;
      return { D: { kind: 'tri', a, b, html: `${it('x')} ≥ 0,&nbsp; ${it('y')} ≥ 0,&nbsp; ${fr('x', a)} + ${fr('y', b)} ≤ 1`, txt: `x, y ≥ 0, ${one(a) ? 'x' : 'x/' + H(a)} + ${one(b) ? 'y' : 'y/' + H(b)} ≤ 1` },
        top, bot: flat(0), key: 'top', walls: true, eq: `${fr('x', a)} + ${fr('y', b)} + ${fr('z', c)} = 1` };
    }
    case 'cylinder': return { D: disk(v[0]), top: flat(v[1]), bot: flat(0), walls: true };
    case 'cube': return { D: rect(v[0], v[0]), top: flat(v[0]), bot: flat(0), walls: true };
    case 'box': return { D: rect(v[0], v[1]), top: flat(v[2]), bot: flat(0), walls: true };
  }
  return null;
}
const plainHTML = h => h.replace(/<sup>(\d+)<\/sup>⁄<sub>(\d+)<\/sub>/g, '$1/$2').replace(/<sup>2<\/sup>/g, '²').replace(/<sup>3<\/sup>/g, '³').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
// as functions of x and y: "z = ±√(4 − x² − y²)", "0 ≤ z ≤ 3 − 2√(x² + y²)", "z = x² − y²"
function solidRegionHTML(an) {
  const S = solidFuncs(an.solid, solidVals(an));
  if (!S.bot) return `<i>z</i> = ${S.top.html}`;
  if (S.pm) return `<i>z</i> = ±${S.top.html}`;
  return `${S.bot.html} ≤ <i>z</i> ≤ ${S.top.html}${S.walls ? `,&nbsp; ${S.D.html}` : ''}`;
}
function solidVolumeNum(S) {   // ∬_D (f − g) dA, worked out numerically
  const d = (x, y) => S.top.f(x, y) - S.bot.f(x, y), D = S.D;
  if (D.kind === 'disk' || D.kind === 'annulus') return 2 * Math.PI * ME.simpson(p => d(p, 0) * p, D.kind === 'disk' ? 0 : D.r0, D.kind === 'disk' ? D.r : D.r1, 400);
  if (D.kind === 'tri') return dbl((x, y) => (x / D.a + y / D.b <= 1 ? d(x, y) : 0), 0, D.a, 0, D.b, 160);
  return dbl(d, -D.a / 2, D.a / 2, -D.b / 2, D.b / 2, 20);
}
const SOLID_BOTTOM = c => c.map(x => x + (255 - x) * 0.5);
function solidInfoHTML(l, an) {
  const v = solidVals(an), inf = solidInfo(an.solid, v), S = solidFuncs(an.solid, v), surf = !!SOLID[an.solid].surf;
  const col = hexRGB(GCOL[(l.colorIdx || 0) % GCOL.length]), sw = c => `<span class="sw" style="background:${rgb(c)}"></span>`, fxy = n => `<i>${n}</i>(<i>x</i>, <i>y</i>)`;
  let h = '';
  if (S.eq) h += `<span class="lm-fx">${S.eq}</span>`;
  if (!S.bot) h += `<span class="lm-fx">${sw(col)}<i>z</i> = ${fxy('f')} = ${S.top.html}</span>`;
  else {
    h += `<span class="lm-fx">${sw(col)}${surf ? 'upper half' : 'top'}&nbsp; <i>z</i> = ${fxy('f')} = ${S.top.html}</span>`;
    h += `<span class="lm-fx">${sw(SOLID_BOTTOM(col))}${surf ? 'lower half' : 'bottom'}&nbsp; <i>z</i> = ${fxy('g')} = ${S.bot.html}</span>`;
  }
  h += `<span class="lm-fx">over <i>D</i>:&nbsp; ${S.D.html}</span>`;
  if (inf.V != null) h += `<span class="lm-fx"><i>V</i> = ∬<sub><i>D</i></sub> (<i>f</i> − <i>g</i>) <i>dA</i> = <b>${fmtS(solidVolumeNum(S))}</b> <span class="muted">(${inf.Vf})</span>${inf.S != null ? ` &nbsp;·&nbsp; <i>S</i> = ${inf.Sf} = <b>${fmtS(inf.S)}</b>` : ''}</span>`;
  if (surf) h += `<span class="muted lm-fxn">A surface, not a solid${S.bot ? ': the two graphs together make it' : ''}.</span>`;
  if (S.walls) h += `<span class="muted lm-fxn">The side${an.solid === 'tetra' ? 's on the planes x = 0 and y = 0 aren’t graphs' : ' isn’t the graph'} of a function of <i>x</i> and <i>y</i>: the solid is everything between the two graphs, above <i>D</i>.</span>`;
  if (inf.ell != null) h += `<span class="muted lm-fxn">slant height ℓ = √(<i>r</i><sup>2</sup> + <i>h</i><sup>2</sup>) = ${fmtS(inf.ell)}</span>`;
  return h;
}
function solidShort(an) { return `${SOLID[an.solid].name}&nbsp; ${solidRegionHTML(an)}`; }
function computeScope() {
  const S0 = {};
  const lines = doc.lines.filter(liveLine).slice().sort((a, b) => lineBB(a).cy - lineBB(b).cy || lineBB(a).x0 - lineBB(b).x0);
  const names = new Set();
  for (const l of lines) { const an = anOf(l); (an.params || []).forEach(p => names.add(p)); }
  for (const n of names) S0[n] = doc.params[n] != null ? doc.params[n] : 1;
  const assigned = new Set();
  for (const l of lines) {
    const an = anOf(l);
    if (an.kind === 'assign') { const v = an.c.rhs(S0); if (isFinite(v)) { S0[an.name] = v; assigned.add(an.name); } }
  }
  S0.__assigned = assigned;
  scope = S0;
}

/* --- stroke clustering & "=" detection --- */
function isDash(s) {
  if (s.tool === 'hl') return false;
  const b = bbox(s);
  if (b.w < 7) return false;
  if (b.h > b.w * 0.38) return false;
  let len = 0; for (let i = 1; i < s.pts.length; i++) len += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]);
  return len < b.w * 1.7;
}
function findEquals(ids) {
  const dashes = ids.map(id => doc.strokes[id]).filter(s => s && isDash(s));
  const used = new Set(), pairs = [];
  for (let i = 0; i < dashes.length; i++) for (let j = i + 1; j < dashes.length; j++) {
    const a = dashes[i], b = dashes[j];
    if (used.has(a.id) || used.has(b.id)) continue;
    const A = bbox(a), B = bbox(b);
    const ratio = A.w / B.w; if (ratio < 0.45 || ratio > 2.2) continue;
    const ov = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0); if (ov < 0.5 * Math.min(A.w, B.w)) continue;
    const dy = Math.abs(A.cy - B.cy), mw = Math.max(A.w, B.w); if (dy < 0.1 * mw || dy > 0.95 * mw) continue;
    used.add(a.id); used.add(b.id); pairs.push([a.id, b.id]);
  }
  return pairs;
}
function clusterize(ids) {
  const items = ids.map(id => doc.strokes[id]).filter(Boolean).map(s => ({ id: s.id, b: bbox(s) })).sort((p, q) => p.b.x0 - q.b.x0);
  const clusters = [];
  for (const it of items) {
    const c = clusters[clusters.length - 1];
    if (c) {
      const ov = Math.min(c.x1, it.b.x1) - Math.max(c.x0, it.b.x0);
      const minW = Math.max(1, Math.min(c.x1 - c.x0, it.b.w));
      if (ov > 0.3 * minW || (it.b.x0 >= c.x0 && it.b.x1 <= c.x1)) { c.ids.push(it.id); c.x1 = Math.max(c.x1, it.b.x1); continue; }
    }
    clusters.push({ ids: [it.id], x0: it.b.x0, x1: it.b.x1 });
  }
  return clusters.map(c => ({ ids: c.ids, text: null }));
}
function buildLineFromEquals(pair, pool) {
  const eqBB = idsBB(pair);
  const s = Math.max(eqBB.w * 1.05, 14);
  const band0 = eqBB.cy - 1.3 * s, band1 = eqBB.cy + 1.3 * s;
  const inLine = new Set(pair);
  let gb = eqBB, grew = true;
  while (grew) {
    grew = false;
    for (const id of pool) {
      if (inLine.has(id)) continue;
      const b = bbox(doc.strokes[id]);
      const inBand = b.cy >= band0 && b.cy <= band1;
      const near = b.x0 <= gb.x1 + 2.1 * s && b.x1 >= gb.x0 - 2.1 * s;
      if (inBand && near && b.h < 4 * s) { inLine.add(id); gb = unionBB([gb, b]); grew = true; }
    }
  }
  // stacked pieces (fractions, dots) that overlap horizontally with members
  for (const id of pool) {
    if (inLine.has(id)) continue;
    const b = bbox(doc.strokes[id]);
    const vgap = b.cy < gb.y0 ? gb.y0 - b.y1 : b.y0 - gb.y1;
    if (vgap > 0.7 * s) continue;
    const overlaps = [...inLine].some(m => { const mb = bbox(doc.strokes[m]); const ov = Math.min(mb.x1, b.x1) - Math.max(mb.x0, b.x0); return ov > 0.5 * Math.min(mb.w || 1, b.w || 1); });
    if (overlaps) inLine.add(id);
  }
  return [...inLine];
}
function rowsOf(ids) {
  const items = ids.map(id => ({ id, b: bbox(doc.strokes[id]) })).sort((p, q) => p.b.cy - q.b.cy);
  const rows = [];
  for (const it of items) {
    const r = rows.find(r => { const ov = Math.min(r.y1, it.b.y1) - Math.max(r.y0, it.b.y0); return ov > 0.35 * Math.max(0.5, Math.min(r.y1 - r.y0, it.b.h)) || (it.b.cy >= r.y0 && it.b.cy <= r.y1); });
    if (r) { r.ids.push(it.id); r.y0 = Math.min(r.y0, it.b.y0); r.y1 = Math.max(r.y1, it.b.y1); r.x0 = Math.min(r.x0, it.b.x0); r.x1 = Math.max(r.x1, it.b.x1); }
    else rows.push({ ids: [it.id], y0: it.b.y0, y1: it.b.y1, x0: it.b.x0, x1: it.b.x1 });
  }
  return rows.sort((a, b) => a.y0 - b.y0);
}
// Column arithmetic: rows of numbers stacked above a horizontal answer line
function findColumns(pool) {
  const out = [], used = new Set();
  const bars = pool.map(id => doc.strokes[id]).filter(s => s && isDash(s) && bbox(s).w >= 22).sort((a, b) => bbox(b).w - bbox(a).w);
  for (const bar of bars) {
    if (used.has(bar.id)) continue;
    const B = bbox(bar);
    const cand = pool.filter(id => id !== bar.id && !used.has(id)).filter(id => { const b = bbox(doc.strokes[id]); return b.cx >= B.x0 - 0.45 * B.w && b.cx <= B.x1 + 0.2 * B.w && b.y1 <= B.cy + 4 && b.cy >= B.cy - 4 * B.w; });
    const rows = rowsOf(cand);
    const picked = [];
    let floor = B.y0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i], h = r.y1 - r.y0;
      if (h < 6 || h > 1.4 * B.w) break;
      if (floor - r.y1 > 1.3 * Math.max(h, 12)) break;
      picked.unshift(r); floor = r.y0;
      if (picked.length >= 6) break;
    }
    if (picked.length < 2) continue;
    const right = Math.max(...picked.map(r => r.x1));
    const hMed = picked.map(r => r.y1 - r.y0).sort((a, b) => a - b)[Math.floor(picked.length / 2)];
    if (picked.some(r => right - r.x1 > 1.1 * hMed)) continue;
    const rowIds = picked.flatMap(r => r.ids);
    const below = pool.filter(id => id !== bar.id && !used.has(id) && !rowIds.includes(id)).filter(id => { const b = bbox(doc.strokes[id]); return b.cy > B.cy && b.y0 < B.y1 + 1.8 * hMed && b.cx >= B.x0 - 0.5 * hMed && b.cx <= B.x1 + 0.8 * hMed; });
    [bar.id, ...rowIds, ...below].forEach(id => used.add(id));
    out.push({ barId: bar.id, rows: picked.map(r => r.ids), below });
  }
  return out;
}
function columnParts(l) {
  const bar = doc.strokes[l.barId]; if (!bar) return null;
  const B = bbox(bar);
  const ids = l.strokeIds.filter(id => id !== l.barId && doc.strokes[id]);
  const above = ids.filter(id => bbox(doc.strokes[id]).cy < B.cy);
  const below = ids.filter(id => bbox(doc.strokes[id]).cy >= B.cy);
  const rows = rowsOf(above);
  const hs = rows.map(r => r.y1 - r.y0).sort((a, b) => a - b);
  return { B, rows: rows.map(r => r.ids), below, rowH: hs.length ? hs[Math.floor(hs.length / 2)] : 30 };
}
function newColumnLine(c) {
  const ids = [...c.rows.flat(), c.barId, ...c.below];
  const l = { id: uid(), layout: 'column', barId: c.barId, strokeIds: ids, clusters: [], expr: '', status: 'new', dirty: true, ver: 1, colorIdx: null, anchors: [] };
  ids.forEach(id => { doc.strokes[id].lineId = l.id; });
  doc.lines.push(l);
  return l;
}
function strokeNearLine(s, l) {
  if (l.layout === 'column') {
    const bar = doc.strokes[l.barId]; if (!bar) return false;
    const b = bbox(s), B = bbox(bar), h = lineCharH(l), lb = lineBB(l);
    const inX = b.cx >= Math.min(lb.x0, B.x0) - 0.8 * h && b.cx <= Math.max(lb.x1, B.x1) + 0.8 * h;
    const below = b.cy > B.cy && b.y0 < B.y1 + 1.8 * h;
    const above = b.cy < B.cy && b.cy > lb.y0 - 0.4 * h;
    return inX && (below || above);
  }
  const b = bbox(s), lb = lineBB(l), h = lineCharH(l);
  return b.cy >= lb.y0 - 0.45 * h && b.cy <= lb.y1 + 0.45 * h && b.x0 <= lb.x1 + 2.2 * h && b.x1 >= lb.x0 - 1.2 * h;
}
function attachToLine(s) {
  if (s.tool === 'hl') return;
  for (const l of doc.lines) {
    if (l.ignored) continue;
    if (strokeNearLine(s, l)) { s.lineId = l.id; l.strokeIds.push(s.id); lineChanged(l); return; }
  }
}
function detectNewLines() {
  const pool = doc.order.filter(id => { const s = doc.strokes[id]; return s && s.tool !== 'hl' && !s.lineId && !s.synthetic; });
  if (!pool.length) return [];
  const created = [];
  for (const pair of findEquals(pool)) {
    if (pair.some(id => doc.strokes[id].lineId)) continue;
    const ids = buildLineFromEquals(pair, pool.filter(id => !doc.strokes[id].lineId));
    const l = { id: uid(), strokeIds: ids, clusters: [], expr: '', status: 'new', dirty: true, ver: 1, colorIdx: null, anchors: [] };
    ids.forEach(id => { doc.strokes[id].lineId = l.id; });
    doc.lines.push(l);
    created.push(l);
  }
  const rest = doc.order.filter(id => { const s = doc.strokes[id]; return s && s.tool !== 'hl' && !s.lineId && !s.synthetic; });
  for (const c of findColumns(rest)) created.push(newColumnLine(c));
  return created;
}
function cleanupLines() {
  const removed = doc.lines.filter(l => l.fitted ? !doc.graphs.some(g => g.id === l.gid) : l.virtual ? !doc.lines.some(s => s.id === l.src && (s.fitted || s.strokeIds.some(id => doc.strokes[id]))) : !l.strokeIds.some(id => doc.strokes[id]));
  if (!removed.length) return;
  const ids = new Set(removed.map(l => l.id));
  doc.lines = doc.lines.filter(l => !ids.has(l.id));
  for (const g of doc.graphs) g.lineIds = g.lineIds.filter(id => !ids.has(id));
}

/* --- recognition through Claude --- */
let samplerP = null, readState = { ok: null, msg: 'Checking…' };
/* Outside Claude (the iPad app, the web app) handwriting is read with the person's own Anthropic API key,
   typed into ⋯ → Handwriting reading. It's kept on this device only and sent only to api.anthropic.com. */
const STANDALONE = !!window.LMN_STANDALONE;
const NATIVE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lmnSave);
const KEY_STORE = 'lmn.anthropicKey', READ_MODEL = 'claude-haiku-5-5';
function apiKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
const blobB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
function directSampler(key) {
  const fail = code => Object.assign(new Error(code), { code });
  return {
    limits: async () => ({ images: true }),
    async json(prompt, o = {}) {
      const content = [];
      for (const im of o.images || []) content.push({ type: 'image', source: { type: 'base64', media_type: im.type || 'image/png', data: await blobB64(im) } });
      content.push({ type: 'text', text: prompt });
      let r;
      try {
        r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: o.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: READ_MODEL, max_tokens: 700, messages: [{ role: 'user', content }] }) });
      } catch (e) { throw fail(e && e.name === 'AbortError' ? 'cancelled' : 'offline'); }
      if (r.status === 401 || r.status === 403) throw fail('bad_key');
      if (r.status === 429 || r.status === 529) throw fail('rate_limited');
      if (!r.ok) throw fail('error');
      const j = await r.json(), t = (j.content || []).map(c => c.text || '').join(''), a = t.indexOf('{'), b = t.lastIndexOf('}');
      if (a < 0 || b < a) throw fail('error');
      return JSON.parse(t.slice(a, b + 1));
    }
  };
}
function getSampler() {
  if (!samplerP) {
    samplerP = (async () => {
      if ((!window.claude || typeof window.claude.use !== 'function') && STANDALONE) {
        const k = apiKey();
        if (!k) { setRead(false, 'To read handwriting here, add your API key in ⋯ → Handwriting reading'); return null; }
        setRead(true, 'Reads lines with “=” automatically'); return directSampler(k);
      }
      if (!window.claude || typeof window.claude.use !== 'function') { setRead(false, 'Open this page in Claude to read handwriting'); return null; }
      let s = null;
      try { s = await window.claude.use('sample'); } catch (e) { s = null; }
      if (!s) { setRead(false, 'Handwriting reading isn’t available in this view'); return null; }
      try { const lim = await s.limits(); if (!lim || !lim.images) { setRead(false, 'This view can’t send images to Claude'); return null; } } catch (e) { setRead(false, 'Handwriting reading isn’t available in this view'); return null; }
      setRead(true, 'Reads lines with “=” automatically');
      return s;
    })();
  }
  return samplerP;
}
function setRead(ok, msg) { readState = { ok, msg }; renderReadPill(); }
function renderReadPill() {
  const b = $('#autoread');
  b.classList.toggle('on', ui.autoRead && readState.ok !== false);
  b.classList.toggle('unavail', readState.ok === false);
  b.setAttribute('aria-pressed', String(ui.autoRead));
  b.title = readState.ok === false ? readState.msg : (ui.autoRead ? 'Auto-read is on: lines with “=” are read as you write' : 'Auto-read is off: tap “Read” on a line');
  $('#autoreadLabel').textContent = readState.ok === false ? 'Reading off' : (ui.autoRead ? 'Auto-read' : 'Auto-read off');
  const hs = $('#hintStatus'); if (hs) hs.textContent = readState.ok === false ? readState.msg + '. You can still type a line with ✎.' : '';
}
const recQ = [], inflight = new Map(); let recActive = 0, lastInkAt = 0;
function lineChanged(l) {
  l.dirty = true; l.ver = (l.ver || 0) + 1;
  const f = inflight.get(l.id); if (f) f.ctl.abort();
  if (l.status === 'reading' || l.status === 'ok') l.status = 'pending';
}
function queueRead(l) {
  const f = inflight.get(l.id); if (f) f.ctl.abort();
  if (!recQ.includes(l.id)) recQ.push(l.id);
  l.status = 'reading';
  refresh(); pumpRead();
}
function pumpRead() {
  while (recActive < 2 && recQ.length) {
    const id = recQ.shift();
    recActive++;
    readLine(id).catch(() => { }).finally(() => { recActive--; pumpRead(); });
  }
}
function liveLine(l) { return !!(l && l.expr && !l.ignored); }
function maybeAutoGraph(l) {
  if (!ui.autoGraph || l.noAutoGraph || l.layout === 'column') return;
  if (!GRAPHABLE.has(anOf(l).kind) || doc.graphs.some(g => g.lineIds.includes(l.id))) return;
  transact(() => createGraphFor(l));
}
function lineImage(l, clusters, hOverride) {
  const h = hOverride || lineCharH(l);
  const k = clamp(44 / h, 0.3, 4);
  const gapW = 0.5 * h;
  const lb = lineBB(l);
  let total = lb.w + gapW * (clusters.length - 1);
  const kk = Math.min(k, 1800 / Math.max(1, total * 1));
  const pad = 24;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(total * kk + pad * 2); cv.height = Math.ceil(lb.h * kk + pad * 2);
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
  c.strokeStyle = '#000'; c.lineCap = 'round'; c.lineJoin = 'round';
  clusters.forEach((cl, i) => {
    for (const id of cl.ids) {
      const s = doc.strokes[id]; if (!s) continue;
      c.lineWidth = Math.max(2.4, s.w * kk * 0.9);
      c.beginPath();
      s.pts.forEach((p, j) => { const X = (p[0] - lb.x0 + i * gapW) * kk + pad, Y = (p[1] - lb.y0) * kk + pad; j ? c.lineTo(X, Y) : c.moveTo(X, Y); });
      if (s.pts.length === 1) c.lineTo((s.pts[0][0] - lb.x0 + i * gapW) * kk + pad + 0.5, (s.pts[0][1] - lb.y0) * kk + pad + 0.5);
      c.stroke();
    }
  });
  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}
function readPrompt(n) {
  return `You are reading ONE line of handwritten math from a student's digital notebook (black ink on white).
The ink is split into exactly ${n} separate clusters, spaced apart, left to right.
Reply with only a JSON object: {"expr": string, "clusters": string[], "ok": boolean}
- "clusters": exactly ${n} strings, one per ink cluster in left-to-right order: what is written in that cluster. Usually one symbol ("2", "x", "=", "+", "(", "θ"). A cluster may hold several symbols if they touch (e.g. "sin", "12") or are stacked (a fraction like "(x+1)/2").
- "expr": the whole line as plain-text math: + - * / ^ ( ) with explicit * for multiplication; functions sin cos tan sec csc cot asin acos atan sinh cosh tanh ln log sqrt abs exp; constants pi and e; write θ as theta. Small raised symbols are exponents (x^2). Keep every number exactly as written. Keep a trailing "=" if nothing follows it. Two equations on one line separated by a comma stay comma-separated.
- "ok": false if the line is not math.
Example, a line "y = 3x² − 1" in 7 clusters: {"expr":"y = 3*x^2 - 1","clusters":["y","=","3","x","2","-","1"],"ok":true}`;
}
function columnPrompt(rows, hasBelow) {
  return `This image shows handwritten COLUMN (vertical) arithmetic from a student's notebook: numbers written in exactly ${rows} rows stacked above a horizontal line, with an operator (+, −, ×, ÷) at the left of the lower row(s).${hasBelow ? ' Something is also written below the line (the student\'s answer).' : ''}
Reply with only a JSON object: {"rows": string[], "answer": string|null, "expr": string, "ok": boolean}
- "rows": exactly ${rows} strings, top to bottom, each row as written with its operator first if it has one, e.g. ["12", "×12"].
- "answer": the number written below the line, or null if nothing is written there.
- "expr": the calculation as plain text using + - * / (× becomes *, ÷ becomes /), e.g. "12*12". Keep every number exactly as written.
- "ok": false if this is not arithmetic.
Example: {"rows":["345","+78"],"answer":null,"expr":"345+78","ok":true}`;
}
function applyColumnReading(l, res, parts) {
  const R = parts.rows.length;
  const rowsTxt = Array.isArray(res.rows) && res.rows.length === R ? res.rows.map(x => String(x).replace(/\s+/g, '')) : null;
  const clusters = [];
  parts.rows.forEach((ids, i) => {
    const t = rowsTxt ? rowsTxt[i] : null;
    const m = t ? t.match(/^([+\-−×xX*÷\/·])?(.*)$/) : null;
    const cl = clusterize(ids);
    if (m && m[1] && cl.length > 1) { clusters.push({ ids: cl[0].ids, text: m[1], role: 'op' }); clusters.push({ ids: cl.slice(1).flatMap(c => c.ids), text: m[2], role: 'num' }); }
    else clusters.push({ ids: cl.flatMap(c => c.ids), text: m ? m[2] : null, role: 'num' });
  });
  clusters.push({ ids: [l.barId], text: '_', role: 'bar' });
  if (parts.below.length) clusters.push({ ids: parts.below, text: res.answer == null ? null : String(res.answer), role: 'ans' });
  l.userAnswer = parts.below.length && res.answer != null && String(res.answer).trim() !== '' ? String(res.answer).trim() : null;
  let expr = String(res.expr || '').replace(/=\s*$/, '');
  if (!expr && rowsTxt) expr = rowsTxt.join('');
  applyReading(l, expr, clusters);
}
async function readLine(id) {
  const l = lineById(id); if (!l) return;
  const sampler = await getSampler();
  if (!sampler) { l.status = 'unavailable'; l.dirty = false; refresh(); return; }
  const ver = l.ver;
  const ctl = new AbortController();
  inflight.set(id, { ctl });
  try { await readLineInner(id, l, ver, sampler, ctl); }
  finally { if (inflight.get(id) && inflight.get(id).ctl === ctl) inflight.delete(id); }
}
async function readLineInner(id, l, ver, sampler, ctl) {
  let parts = l.layout === 'column' ? columnParts(l) : null;
  if (l.layout === 'column' && (!parts || !parts.rows.length)) { delete l.layout; parts = null; }
  const clusters = parts ? [{ ids: l.strokeIds.slice() }] : clusterize(l.strokeIds);
  const blob = await lineImage(l, clusters, parts ? parts.rowH : 0);
  let res;
  try {
    res = await sampler.json(parts ? columnPrompt(parts.rows.length, parts.below.length > 0) : readPrompt(clusters.length), { images: [blob], modelTier: 'quick', signal: ctl.signal });
  } catch (e) {
    const L = lineById(id); if (!L) return;
    const code = e && e.code;
    if (code === 'cancelled') { if (L.status === 'reading' && !recQ.includes(id)) { L.status = 'pending'; scheduleIdle(200); } return; }
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'images_unavailable', 'bad_key'].includes(code)) {
      setRead(false, code === 'bad_key' ? 'Your API key wasn’t accepted: check it in ⋯ → Handwriting reading' : code === 'not_granted' ? 'Claude access was declined for this page' : 'Handwriting reading isn’t available here');
      L.status = 'unavailable';
    } else if (code === 'offline') { L.status = 'error'; L.err = 'No internet connection. Tap the line and choose Read now when you’re back online.'; } else if (code === 'rate_limited') { L.status = 'error'; L.err = 'Busy right now. Tap the line and choose Read now to try again.'; }
    else { L.status = 'error'; L.err = 'Couldn’t read this line. Tap it and choose Read now to try again.'; }
    L.dirty = false; noteReadDone(false); refresh(); return;
  }
  const L = lineById(id); if (!L) return;
  if (L.ver !== ver) { if (!recQ.includes(id)) { L.status = 'pending'; scheduleIdle(150); } return; }
  if (parts && res && res.ok !== false && (typeof res.expr === 'string' || Array.isArray(res.rows))) { applyColumnReading(L, res, parts); markFresh(L); noteReadDone(true); refresh(); scheduleSave(); return; }
  if (!res || typeof res.expr !== 'string' || res.ok === false || !res.expr.trim()) {
    L.clusters = parts ? [] : clusters; L.status = 'notmath'; L.dirty = false; L.expr = ''; noteReadDone(false); refresh(); scheduleSave(); return;
  }
  const texts = Array.isArray(res.clusters) && res.clusters.length === clusters.length ? res.clusters.map(String) : null;
  clusters.forEach((c, i) => { c.text = texts ? texts[i] : null; });
  applyReading(L, res.expr, clusters);
  markFresh(L); noteReadDone(true);
  maybeAutoGraph(L);
  refresh(); scheduleSave();
}
function applyReading(l, expr, clusters) {
  l.clusters = clusters;
  l.expr = ME.normalize(expr).replace(/\btheta\b/g, 'θ').replace(/\bpi\b/g, 'π');
  l.status = 'ok'; l.dirty = false; l.err = '';
  l.charH = null; l.charH = lineCharH(l);
  computeAnchors(l);
}
function computeAnchors(l) {
  l.anchors = [];
  let toks;
  try { toks = ME.tokenize(l.expr); } catch (e) { return; }
  const lits = toks.filter(t => t.type === 'num');
  const cl = l.clusters || [];
  const isNumTxt = t => t != null && /^[0-9]*\.?[0-9]+$|^[0-9]+\.?$/.test(t.trim());
  const runs = [];
  for (let i = 0; i < cl.length; i++) {
    if (!isNumTxt(cl[i].text) || cl[i].role === 'ans' || cl[i].role === 'bar' || cl[i].role === 'op') continue;
    const bi = clusterBB(cl[i]);
    const prev = runs[runs.length - 1];
    if (prev && prev.end === i - 1) {
      const bp = clusterBB(cl[i - 1]);
      const sameLevel = Math.abs(bp.cy - bi.cy) < 0.3 * Math.max(bp.h, bi.h, 6) && bi.h / Math.max(1, bp.h) > 0.6 && bi.h / Math.max(1, bp.h) < 1.6;
      if (sameLevel && bi.x0 - bp.x1 < 0.8 * Math.max(bp.h, bi.h)) { prev.end = i; prev.text += cl[i].text.trim(); continue; }
    }
    runs.push({ start: i, end: i, text: cl[i].text.trim() });
  }
  let j = 0;
  for (const r of runs) {
    const v = parseFloat(r.text);
    for (let k = j; k < Math.min(lits.length, j + 4); k++) {
      if (Math.abs(lits[k].value - v) < 1e-9) { l.anchors.push({ type: 'lit', lit: lits[k].lit, ci: range(r.start, r.end) }); j = k + 1; break; }
    }
  }
  const an = anOf(l);
  for (const p of an.params || []) {
    const i = cl.findIndex(c => c.text && c.text.trim() === p);
    if (i >= 0) l.anchors.push({ type: 'param', name: p, ci: [i] });
  }
}
const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };

/* idle → detect + read */
let idleT = null;
function scheduleIdle(ms = 550) { clearTimeout(idleT); idleT = setTimeout(onIdle, ms); }
function readDelay(l) {
  if (l.layout === 'column') return 650;
  const pair = findEquals(l.strokeIds)[0];
  if (!pair) return 550;
  const eq = idsBB(pair);
  const others = l.strokeIds.filter(id => !pair.includes(id) && doc.strokes[id]);
  if (others.some(id => bbox(doc.strokes[id]).x0 > eq.x1 - eq.w * 0.1)) return 550;
  const left = clusterize(others.filter(id => bbox(doc.strokes[id]).cx < eq.cx));
  return left.length <= 2 ? 2300 : 1000;
}
function onIdle() {
  if (gesture && (gesture.type === 'draw')) { scheduleIdle(); return; }
  cleanupLines();
  const fresh = detectNewLines();
  const now = performance.now();
  let soonest = Infinity;
  for (const l of doc.lines) {
    if (l.ignored || !l.dirty || inflight.has(l.id) || recQ.includes(l.id)) continue;
    if (!(ui.autoRead && readState.ok !== false)) { l.status = l.expr ? 'stale' : (readState.ok === false ? 'unavailable' : 'idle'); continue; }
    const wait = readDelay(l) - (now - lastInkAt);
    if (wait > 30) { soonest = Math.min(soonest, wait); l.status = 'pending'; continue; }
    queueRead(l);
  }
  if (isFinite(soonest)) { clearTimeout(idleT); idleT = setTimeout(onIdle, soonest + 20); }
  if (fresh.length || doc.lines.some(l => l.dirty)) refresh();
  scheduleSave();
}

/* ---------- number & variable sliders ---------- */
function anchorBB(l, a) { return unionBB(a.ci.map(i => l.clusters[i] && clusterBB(l.clusters[i]))); }
// a minus written right in front of a number (start, after "=", "(", "^", "×"…) belongs to that number
function unaryMinusAt(toks, i) { const p = toks[i - 1]; if (!p || p.type !== 'op' || p.v !== '-') return false; const pp = toks[i - 2]; return !pp || (pp.type === 'op' && pp.v !== ')' && pp.v !== '!'); }
function litValue(l, litIdx) { try { const toks = ME.tokenize(l.expr), i = toks.findIndex(t => t.type === 'num' && t.lit === litIdx); return i < 0 ? null : (unaryMinusAt(toks, i) ? -toks[i].value : toks[i].value); } catch (e) { return null; } }
function hitAnchor(wx, wy) {
  const pad = 7 / view.s;
  for (const l of doc.lines) {
    if (l.status !== 'ok' || l.dirty) continue;
    for (const a of l.anchors || []) {
      if (a.type === 'param' && scope.__assigned && scope.__assigned.has(a.name)) continue;
      const b = anchorBB(l, a);
      if (wx >= b.x0 - pad && wx <= b.x1 + pad && wy >= b.y0 - pad && wy <= b.y1 + pad) return { l, a };
    }
  }
  return null;
}
function fmtNum(v, step) {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  let s = v.toFixed(dec);
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s;
}
function setLitValue(l, a, v, step) {
  const text = fmtNum(v, step);
  let toks;
  try { toks = ME.tokenize(l.expr); } catch (e) { return; }
  const ti = toks.findIndex(t => t.type === 'num' && t.lit === a.lit); if (ti < 0) return;
  const t = toks[ti], neg = unaryMinusAt(toks, ti), s0 = neg ? toks[ti - 1].start : t.start;
  if ((neg ? '-' : '') + t.text === text) return;
  // expression: the sign is part of the number, so sliding through zero never stacks minus signs
  l.expr = l.expr.slice(0, s0) + text + l.expr.slice(t.end);
  if (!a.ci || !a.ci.length) return;
  // ink: replace cluster run with handwritten glyphs (including a separately written minus in front)
  const cl = l.clusters;
  let runIdx = a.ci;
  if (neg) { const k = runIdx[0] - 1, c = cl[k]; if (c && c.text && /^[-−–]$/.test(c.text.trim()) && !/[-−–]/.test(cl[runIdx[0]].text || '')) runIdx = [k, ...runIdx]; }
  const oldBB = unionBB(runIdx.map(i => clusterBB(cl[i])));
  const first = doc.strokes[cl[runIdx[0]].ids[0]];
  const color = first ? first.color : INK[0], tool = first && first.tool === 'pencil' ? 'pencil' : 'pen', w = first ? first.w : 2.6;
  const digitH = Math.max(8, oldBB.h);
  const lay = HandFont.layout(text, 0, 0, digitH, l.id * 31 + a.lit * 7 + text.length);
  // fit the new digits' ink exactly where the old digits' ink was (same left edge — right edge for columns —
  // same top and height), so sliding back and forth never makes the writing creep or shrink
  let ix0 = Infinity, ix1 = -Infinity, iy0 = Infinity, iy1 = -Infinity;
  for (const g of lay.glyphs) for (const st of g.strokes) for (const p of st) { ix0 = Math.min(ix0, p[0]); ix1 = Math.max(ix1, p[0]); iy0 = Math.min(iy0, p[1]); iy1 = Math.max(iy1, p[1]); }
  const kfit = iy1 - iy0 > 1 ? clamp(oldBB.h / (iy1 - iy0), 0.4, 2.5) : 1;
  const ax = l.layout === 'column' ? oldBB.x1 - (ix1 - ix0) * kfit : oldBB.x0;
  for (const g of lay.glyphs) for (const st of g.strokes) for (const p of st) { p[0] = ax + (p[0] - ix0) * kfit; p[1] = oldBB.y0 + (p[1] - iy0) * kfit; }
  const newIds = [];
  for (const i of runIdx) for (const id of cl[i].ids) removeStrokeRaw(id);
  for (const g of lay.glyphs) for (const st of g.strokes) {
    const s = { id: uid(), tool, color, w, pts: st.map(p => [r1(p[0]), r1(p[1]), r2(p[2])]), lineId: l.id, synthetic: true };
    addStroke(s); newIds.push(s.id);
  }
  const newBB = idsBB(newIds);
  const dx = (newBB.x1 - oldBB.x1);
  if (l.layout !== 'column') for (let i = runIdx[runIdx.length - 1] + 1; i < cl.length; i++) for (const id of cl[i].ids) moveStroke(id, dx, 0);
  // rebuild clusters + anchors indices
  const start = runIdx[0], removedCount = runIdx.length - 1;
  cl.splice(start, runIdx.length, { ids: newIds, text, role: cl[start].role });
  l.strokeIds = cl.flatMap(c => c.ids);
  for (const other of l.anchors) {
    if (other === a) { other.ci = [start]; continue; }
    if (other.ci[0] > start) other.ci = other.ci.map(i => i - removedCount);
  }
}
function signCtx(l, a) {
  if (a.type !== 'lit' || ((!a.ci || !a.ci.length) && !l.fitted)) return null;
  let toks; try { toks = ME.tokenize(l.expr); } catch (e) { return null; }
  const i = toks.findIndex(t => t.type === 'num' && t.lit === a.lit); if (i < 2) return null;
  const p = toks[i - 1], pp = toks[i - 2];
  if (p.type !== 'op' || (p.v !== '+' && p.v !== '-') || (pp.type === 'op' && pp.v !== ')' && pp.v !== '!')) return null;
  if (a.ci && a.ci.length) { const c = l.clusters && l.clusters[a.ci[0] - 1]; if (!c || !c.text || !/^[+\-−–]$/.test(c.text.trim())) return null; }
  return { sign: p.v === '-' ? -1 : 1 };
}
function signedTerm(l, a) { const c = signCtx(l, a), v = litValue(l, a.lit); return c && v != null ? c.sign * v : null; }
// which numbers slide as signed terms: a lone constant (+ 3 / − 3) or the multiplier leading a term (− 3x)
const signedRole = r => r === 'added value' || r === 'subtracted value' || /^multiplier of /.test(r || '');
function signedFor(l, a) { if (a.type !== 'lit') return null; const r = litRoles(l.expr).get(a.lit); return signedRole(r) ? signedTerm(l, a) : null; }
function setSignedTerm(l, a, term, step) {
  const toks = ME.tokenize(l.expr), i = toks.findIndex(t => t.type === 'num' && t.lit === a.lit), p = toks[i - 1];
  const want = term < 0 ? '-' : '+';
  if (p && p.type === 'op' && p.v !== want) { l.expr = l.expr.slice(0, p.start) + want + l.expr.slice(p.end); if (a.ci && a.ci.length) redrawOp(l, a.ci[0] - 1, want); }
  setLitValue(l, a, Math.abs(term), step);
}
function redrawOp(l, ci, sym) {
  const cl = l.clusters, c = cl[ci]; if (!c) return;
  const ob = clusterBB(c), H = lineCharH(l), first = doc.strokes[c.ids[0]] || doc.strokes[l.strokeIds[0]];
  const color = first ? first.color : INK[0], tool = first && first.tool === 'pencil' ? 'pencil' : 'pen', w = first ? first.w : 2.6;
  const lay = HandFont.layout(sym, 0, 0, H, l.id * 13 + ci);
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const g of lay.glyphs) for (const st of g.strokes) for (const q of st) { bx0 = Math.min(bx0, q[0]); bx1 = Math.max(bx1, q[0]); by0 = Math.min(by0, q[1]); by1 = Math.max(by1, q[1]); }
  const dx = (ob.x0 + ob.x1) / 2 - (bx0 + bx1) / 2, dy = (ob.y0 + ob.y1) / 2 - (by0 + by1) / 2;
  for (const id of c.ids) removeStrokeRaw(id);
  const ids = [];
  for (const g of lay.glyphs) for (const st of g.strokes) { const s = { id: uid(), tool, color, w, pts: st.map(q => [r1(q[0] + dx), r1(q[1] + dy), r2(q[2])]), lineId: l.id, synthetic: true }; addStroke(s); ids.push(s.id); }
  cl[ci] = { ids, text: sym === '-' ? '−' : '+', role: c.role };
  l.strokeIds = cl.flatMap(x => x.ids);
}
function layoutRight(text, right, top, h, seed) {
  const lay = HandFont.layout(text, 0, top, h, seed);
  let mx = -Infinity;
  for (const g of lay.glyphs) for (const st of g.strokes) for (const p of st) mx = Math.max(mx, p[0]);
  const dx = right - mx;
  for (const g of lay.glyphs) { for (const st of g.strokes) for (const p of st) p[0] += dx; g.box.x += dx; }
  return lay;
}
function columnAnswerSpot(l) {
  const nums = (l.clusters || []).filter(c => c.role === 'num').map(clusterBB).filter(b => isFinite(b.x0));
  const bar = doc.strokes[l.barId]; if (!nums.length || !bar) return null;
  const B = bbox(bar);
  const hs = nums.map(b => b.h).sort((a, b) => a - b);
  const h = hs[Math.floor(hs.length / 2)];
  return { right: Math.max(...nums.map(b => b.x1)), top: B.y1 + 0.38 * h, h, B };
}
function removeStrokeRaw(id) { const s = doc.strokes[id]; if (!s) return; touch(id); delete doc.strokes[id]; doc.order = doc.order.filter(x => x !== id); }

/* ---------- Apple-style slider with no limits ----------
   The track shows a window around the value. Drag the knob into either end and hold:
   the value keeps going, faster the longer you hold. Let go and the knob glides back
   to the middle, so there's always room both ways. − / + at the ends step (hold to repeat). */
function makeInfSlider(host, o) {
  host.classList.add('isl');
  host.innerHTML = `<button class="isl-end" data-d="-1" aria-label="Decrease" tabindex="-1">−</button><div class="isl-track" role="slider" tabindex="0" aria-label="${o.label || 'Value'}"><div class="isl-rail"></div><div class="isl-fill"></div><div class="isl-knob"></div></div><button class="isl-end" data-d="1" aria-label="Increase" tabindex="-1">+</button>`;
  const track = host.querySelector('.isl-track'), knob = host.querySelector('.isl-knob'), fill = host.querySelector('.isl-fill');
  const S = { v: o.value, step: o.step, c: o.value, half: 1, edge: 0, raf: 0, drag: false, hold: 0 };
  const dec = () => S.step >= 1 ? 0 : S.step >= 0.1 ? 1 : 2;
  const span = () => Math.max(S.step * 10, Math.abs(S.v) * 1.2, S.step >= 1 ? 10 : S.step >= 0.1 ? 1 : 0.2);
  const snap = v => +((Math.round(v / S.step) * S.step).toFixed(dec()));
  S.half = span(); if (o.min != null && S.c - S.half < o.min) S.c = o.min + S.half;
  function draw() {
    const w = track.clientWidth; if (!w) return;
    const f = clamp((S.v - (S.c - S.half)) / (2 * S.half), 0, 1), x = 13 + f * Math.max(0, w - 26);
    knob.style.left = x + 'px'; fill.style.width = x + 'px';
    track.setAttribute('aria-valuetext', fmtNum(S.v, S.step));
  }
  const floor = () => { if (o.min != null && S.c - S.half < o.min) S.c = o.min + S.half; };
  function emit(v) { v = snap(v); if (o.min != null) v = Math.max(o.min, v); if (v === S.v) { draw(); return; } S.v = v; draw(); o.onInput(v); }
  function recenter() { host.classList.add('settle'); S.c = S.v; S.half = span(); floor(); draw(); clearTimeout(S.st); S.st = setTimeout(() => host.classList.remove('settle'), 320); }
  function run(ts) {   // held at an end, or holding − / +: keep going, accelerating
    if (!S.edge) { S.raf = 0; return; }
    const dt = S.last ? Math.min(0.05, (ts - S.last) / 1000) : 0; S.last = ts;
    const t = (ts - S.t0) / 1000;
    if (S.mode === 'btn' && t < 0.38) { S.raf = requestAnimationFrame(run); return; }
    const base = S.mode === 'btn' ? S.step * 6 : Math.max(S.step * 8, S.half * 0.5);
    S.acc += S.edge * base * Math.pow(1 + t, 3) * dt;
    if (Math.abs(S.acc) >= S.step) {
      const d = Math.trunc(S.acc / S.step) * S.step; S.acc -= d;
      if (S.mode === 'btn') { emit(S.v + d); if (S.v > S.c + S.half || S.v < S.c - S.half) { S.c = S.v; S.half = span(); draw(); } }
      else { S.c += d; floor(); emit(S.c + S.edge * S.half); }
    }
    S.raf = requestAnimationFrame(run);
  }
  function go(e, mode) { if (e === S.edge && mode === S.mode) return; S.edge = e; S.mode = mode; host.classList.toggle('edge', !!e && mode === 'edge'); if (e) { S.t0 = performance.now(); S.last = 0; S.acc = 0; if (!S.raf) S.raf = requestAnimationFrame(run); } }
  function fracAt(cx) { const r = track.getBoundingClientRect(); return (cx - r.left - 13) / Math.max(1, r.width - 26); }
  function move(e) {
    const f = fracAt(e.clientX);
    if (f >= 0.98) { if (S.edge !== 1) emit(S.c + S.half); go(1, 'edge'); }
    else if (f <= 0.02) { if (S.edge !== -1) emit(S.c - S.half); go(-1, 'edge'); }
    else { go(0); emit(S.c - S.half + f * 2 * S.half); }
  }
  track.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); try { track.setPointerCapture(e.pointerId); } catch (err) { } S.drag = true; host.classList.remove('settle'); track.focus({ preventScroll: true }); o.onStart && o.onStart(); move(e); });
  track.addEventListener('pointermove', e => { if (S.drag) move(e); });
  const up = () => { if (!S.drag) return; S.drag = false; go(0); recenter(); o.onEnd && o.onEnd(); };
  track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up); track.addEventListener('lostpointercapture', up);
  host.querySelectorAll('.isl-end').forEach(b => {
    const d = Number(b.dataset.d);
    b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); try { b.setPointerCapture(e.pointerId); } catch (err) { } S.hold = 1; o.onStart && o.onStart(); emit(S.v + d * S.step); if (S.v > S.c + S.half || S.v < S.c - S.half) recenter(); go(d, 'btn'); });
    const stop = () => { if (!S.hold) return; S.hold = 0; go(0); recenter(); o.onEnd && o.onEnd(); };
    b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('lostpointercapture', stop);
    b.addEventListener('click', e => { if (e.detail === 0) { o.onStart && o.onStart(); emit(S.v + d * S.step); recenter(); o.onEnd && o.onEnd(); } });
  });
  track.addEventListener('keydown', e => {
    const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!k) return;
    e.preventDefault(); e.stopPropagation();
    o.onStart && o.onStart(); emit(S.v + k * S.step * (e.shiftKey ? 10 : 1)); if (S.v > S.c + S.half || S.v < S.c - S.half) recenter(); o.onEnd && o.onEnd();
  });
  const api = {
    set(v) { S.v = v; if (v < S.c - S.half || v > S.c + S.half) { S.c = v; S.half = span(); } draw(); },
    reset(v, st) { if (st != null) S.step = st; S.v = S.c = v; S.half = span(); draw(); requestAnimationFrame(draw); },
    setStep(st) { S.step = st; S.half = span(); draw(); },
    input(v) { o.onStart && o.onStart(); emit(v); recenter(); o.onEnd && o.onEnd(); },
    win: () => [S.c - S.half, S.c + S.half], value: () => S.v, draw,
  };
  host.isl = api;
  requestAnimationFrame(draw);
  return api;
}

let pop = null;
function openPop(l, a) {
  closePop();
  beginTx();
  const isLit = a.type === 'lit';
  const st = isLit ? signedFor(l, a) : null;
  const v0 = st != null ? st : isLit ? litValue(l, a.lit) : (scope[a.name] != null ? scope[a.name] : 1);
  if (v0 == null) { endTx(); return; }
  const t0 = isLit ? (ME.tokenize(l.expr).find(t => t.type === 'num' && t.lit === a.lit) || {}).text || '' : '';
  let step = isLit ? (t0.includes('.') ? (t0.split('.')[1].length > 1 ? 0.01 : 0.1) : 1) : 0.1;
  const R = Math.max(10, Math.ceil(Math.abs(v0) * 2));
  pop = { l, a, step, min: -R, max: R, v: v0, playing: false, signed: st != null };
  const el = $('#pop');
  el.hidden = false;
  $('#popName').innerHTML = isLit ? 'Number in your writing' : `Variable <i>${a.name}</i>`;
  popSlider().reset(v0, step);
  syncPop();
  positionOverlays();
}
function syncPop() {
  if (!pop) return;
  $('#popVal').textContent = fmtNum(pop.v, pop.step).replace('-', '−');
  popSlider().setStep(pop.step); popSlider().set(pop.v);
  document.querySelectorAll('#popSteps button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.step) === pop.step)));
  $('#popPlay').textContent = pop.playing ? 'Pause' : 'Play';
  $('#popPlay').setAttribute('aria-pressed', String(pop.playing));
}
function setPopValue(v) {
  if (!pop) return;
  v = Math.round(v / pop.step) * pop.step;
  if (pop.playing) v = clamp(v, pop.min, pop.max);
  pop.v = v;
  if (pop.a.type === 'lit') { if (pop.signed) setSignedTerm(pop.l, pop.a, v, pop.step); else setLitValue(pop.l, pop.a, v, pop.step); }
  else doc.params[pop.a.name] = r2(v);
  syncPop(); refresh();
}
function closePop() {
  if (!pop) return;
  pop.playing = false;
  pop = null;
  $('#pop').hidden = true;
  endTx();
}
function playLoop(ts) {
  if (!pop || !pop.playing) return;
  const p = pop;
  if (!p.last) p.last = ts;
  const dt = Math.min(64, ts - p.last); p.last = ts;
  p.dir = p.dir || 1;
  const span = Math.min(p.max - p.min, 10);
  let v = p.raw != null ? p.raw : p.v;
  v += p.dir * dt / 1000 * span / 3;
  if (v > p.max) { v = p.max; p.dir = -1; } if (v < p.min) { v = p.min; p.dir = 1; }
  p.raw = v;
  setPopValue(v);
  requestAnimationFrame(playLoop);
}

/* ---------- overlays: answers, anchor underlines, chips ---------- */
function renderOverlays() {
  gOver.innerHTML = '';
  renderAnts();
  for (const l of doc.lines) {
    if (l.ignored || l.status !== 'ok' || l.dirty) continue;
    const an = anOf(l), h = lineCharH(l);
    if (l.layout === 'column' && an.kind === 'value' && !l.userAnswer) {
      const v = an.c.lhs(scope), spot = columnAnswerSpot(l);
      if (spot) {
        const lay = layoutRight(isFinite(v) ? ME.fmt(v).replace(/−/g, '-') : '?', spot.right, spot.top, spot.h, 77 + l.id);
        for (const g of lay.glyphs) for (const st of g.strokes) gOver.appendChild(S('path', { d: outlinePath(st, 2.6), fill: ANSWER, class: 'answer' }));
      }
    }
    if (an.kind === 'evaluate') {
      const v = an.c.lhs(scope);
      const eq = l.clusters.length ? clusterBB(l.clusters[l.clusters.length - 1]) : lineBB(l);
      const txt = ME.fmt(v).replace(/−/g, '-');
      const lay = HandFont.layout(isFinite(v) ? txt : '?', eq.x1 + 0.35 * h, eq.cy - 0.52 * h, h, 99 + l.id);
      for (const g of lay.glyphs) for (const st of g.strokes) gOver.appendChild(S('path', { d: outlinePath(st, 2.6), fill: ANSWER, class: 'answer' }));
    }
    for (const a of l.anchors || []) {
      if (a.type === 'param' && scope.__assigned && scope.__assigned.has(a.name)) continue;
      const b = anchorBB(l, a);
      if (!isFinite(b.x0)) continue;
      if (lmenu && lmenu.l === l) gOver.appendChild(S('line', { x1: b.x0 - 1, x2: b.x1 + 1, y1: b.y1 + 4, y2: b.y1 + 4, class: 'anchor-ul' }));
      if (a.type === 'param') {
        const t = S('text', { x: b.x1 + 3, y: b.y0 + 2, class: 'param-val' }); t.textContent = '=' + ME.fmt(scope[a.name]); gOver.appendChild(t);
      }
    }
  }
}
const chipEls = new Map();
function renderChips() { for (const [, el] of chipEls) el.remove(); chipEls.clear(); }
chipLayer.addEventListener('pointerdown', e => { if (e.target.closest('.chip')) e.stopPropagation(); });
chipLayer.addEventListener('click', e => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const l = lineById(Number(chip.dataset.line)); if (!l) return;
  const litBtn = e.target.closest('.lit');
  if (litBtn) { openPop(l, { type: 'lit', lit: Number(litBtn.dataset.lit), ci: [] }); return; }
  const act = e.target.closest('[data-act]'); if (!act) return;
  const a = act.dataset.act;
  if (a === 'read') { lineChanged(l); queueRead(l); }
  else if (a === 'edit') openEdit(l, chip);
  else if (a === 'ignore') transact(() => { l.ignored = true; doc.graphs.forEach(g => { g.lineIds = g.lineIds.filter(id => id !== l.id); }); });
  else if (a === 'graph') transact(() => createGraphFor(l));
  else if (a === 'add') transact(() => addToNearestGraph(l));
  refresh();
});
function openEdit(l, chip) {
  const lb = lineBB(l);
  const box = document.createElement('form');
  box.className = 'chip edit-box';
  box.style.left = (lb.x0) + 'px'; box.style.top = (lb.y1 + 10) + 'px';
  box.innerHTML = `<label for="editIn">What did you write?</label><input id="editIn" autocomplete="off" spellcheck="false"><button class="c-act" type="submit">Use this</button><button class="c-btn" type="button" data-cancel>Cancel</button><div class="edit-help">Example: y = 2x^2 - 3, r = 1 + cos(theta), x^2 + y^2 = 9</div>`;
  chipLayer.appendChild(box);
  const inp = box.querySelector('input');
  inp.value = l.expr || '';
  inp.focus(); inp.select();
  box.addEventListener('pointerdown', e => e.stopPropagation());
  box.querySelector('[data-cancel]').onclick = () => box.remove();
  box.addEventListener('submit', ev => {
    ev.preventDefault();
    const v = inp.value.trim(); if (!v) return;
    transact(() => {
      const keep = l.clusters && l.clusters.length && l.clusters.some(c => c.text) ? l.clusters : clusterize(l.strokeIds);
      applyReading(l, v, keep);
    });
    markFresh(l); box.remove(); refresh();
  });
}

/* ---------- read lines: marching-ants loop, tap for options ----------
   Nothing is graphed on its own. A line that has been read gets a dashed loop
   (it marches for a few seconds after reading, and while its menu is open).
   Tap the math → sliders for every number (labelled: multiplier, exponent,
   added value…), New 2D / 3D graph, or add it to a graph already on the page. */
const antsFresh = new Map();
function markFresh(l) { antsFresh.set(l.id, performance.now() + 4000); clearTimeout(markFresh.t); markFresh.t = setTimeout(refresh, 4100); }
function virtualFor(l) { return doc.lines.find(v => v.virtual && v.src === l.id) || null; }
function ensureVirtual(l) {
  let v = virtualFor(l);
  if (!v) { v = { id: uid(), virtual: true, src: l.id, strokeIds: [], clusters: [], expr: '', status: 'ok', dirty: false, ver: 1, colorIdx: l.colorIdx, anchors: [] }; doc.lines.push(v); syncVirtual(v); }
  return v;
}
// a y = f(x) line shown in a 3D graph is drawn as the surface z = f(x)
function syncVirtual(v) {
  const src = lineById(v.src); if (!src) return;
  v.colorIdx = src.colorIdx;
  if (!liveLine(src) || src.status !== 'ok') return;
  const an = anOf(src); if (an.kind !== 'function') return;
  const e = 'z = ' + ME.toText(an.f);
  if (v.expr !== e) { v.expr = e; v.ver = (v.ver || 0) + 1; }
}
function syncVirtuals() { for (const v of doc.lines) if (v.virtual) syncVirtual(v); }
function lineGraphs(l) { const v = virtualFor(l); return doc.graphs.filter(g => g.lineIds.includes(l.id) || (v && g.lineIds.includes(v.id))); }
function loopState(l) {
  if (l && l.fitted) return l.expr && !l.ignored ? 'ok' : null;
  if (!l || l.virtual || l.ignored || !l.strokeIds.length) return null;
  if (l.status === 'ok' && !l.dirty) {
    const k = anOf(l).kind;
    if (k === 'incomplete') return null;
    return k === 'error' || k === 'unknown' ? 'warn' : 'ok';
  }
  return ['error', 'notmath', 'new', 'idle', 'stale', 'unavailable'].includes(l.status) ? 'warn' : null;
}
function loopBox(l) {
  const b = lineBB(l), h = lineCharH(l);
  let { x0, y0, x1, y1 } = b;
  if (l.status === 'ok' && !l.dirty) {
    const an = anOf(l);
    if (an.kind === 'evaluate' && l.layout !== 'column') { const v = an.c.lhs(scope); x1 += 0.35 * h + HandFont.advance(isFinite(v) ? ME.fmt(v).replace(/−/g, '-') : '?', h); }
    if (l.layout === 'column') { const sp = columnAnswerSpot(l); if (sp) { y1 = Math.max(y1, sp.top + sp.h); x1 = Math.max(x1, sp.right); x0 = Math.min(x0, sp.B.x0); } }
  }
  const pad = clamp(0.3 * h, 6, 14);
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad, r: Math.min(6, (y1 - y0) / 2 + pad) };
}
function verdict(l) {
  const an = anOf(l);
  if (l.layout === 'column' && (an.kind === 'value' || an.kind === 'evaluate') && l.userAnswer) {
    const v = an.c.lhs(scope), ua = parseFloat(String(l.userAnswer).replace(/[,\s]/g, '').replace('−', '-'));
    const ok = isFinite(ua) && Math.abs(ua - v) <= 1e-9 * Math.max(1, Math.abs(v));
    return { ok, text: ok ? '✓' : '✗ ' + ME.fmt(v), full: ok ? 'Correct' : 'Not quite: it’s ' + ME.fmt(v) };
  }
  if (an.kind === 'check') {
    const a = an.c.lhs(scope), b = an.c.rhs(scope), ok = Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    return { ok, text: ok ? '✓' : '✗ ' + ME.fmt(a), full: ok ? 'Correct' : 'Left side is ' + ME.fmt(a) };
  }
  return null;
}
function solveText(l, an) {
  const S0 = scope, rs = ME.roots(x => { const t = an.v; return an.c.g(S0, t === 'x' ? x : 0, t === 'y' ? x : 0, t === 't' ? x : 0, t === 'θ' ? x : 0); });
  return rs.length ? `${an.v} = ${rs.slice(0, 4).map(r => ME.fmt(r)).join(', ')}` : 'no solution in −50…50';
}
function renderAnts() {
  gAnts.innerHTML = '';
  const now = performance.now();
  for (const l of doc.lines) {
    const st = loopState(l); if (!st) continue;
    const b = loopBox(l); if (!isFinite(b.x0)) continue;
    let col = st === 'warn' ? '#8a9692' : '#0a7c88', mark = null, note = null;
    if (st === 'ok') {
      if (l.colorIdx != null && lineGraphs(l).length) col = GCOL[l.colorIdx % GCOL.length];
      mark = verdict(l); if (mark) col = mark.ok ? '#1d9a68' : '#d64545';
      const an = anOf(l);
      if (an.kind === 'solve') note = solveText(l, an);
      else if (an.kind === 'value' && l.layout !== 'column') note = '= ' + ME.fmt(an.c.lhs(scope));
    }
    const march = (antsFresh.get(l.id) || 0) > now || (lmenu && lmenu.l === l);
    const r = S('rect', { x: r1(b.x0), y: r1(b.y0), width: r1(b.x1 - b.x0), height: r1(b.y1 - b.y0), rx: r1(b.r), class: 'ants ' + st + (march ? ' march' : '') + (lmenu && lmenu.l === l ? ' sel' : '') });
    r.style.stroke = col; gAnts.appendChild(r);
    const fs = clamp(0.42 * lineCharH(l), 11, 20);
    const label = mark ? mark.text : note;
    if (label) { const t = S('text', { x: r1(b.x1 + 6), y: r1((b.y0 + b.y1) / 2 + fs * 0.35), class: 'ants-note' + (mark ? (mark.ok ? ' ok' : ' bad') : ''), 'font-size': r1(fs) }); t.textContent = label.replace(/-/g, '−'); gAnts.appendChild(t); }
  }
}
// pencil / mouse: on the ink or the loop; finger: anywhere inside the loop
function lineAt(wx, wy, finger) {
  const k = 1 / view.s;
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    const l = doc.lines[i]; if (!loopState(l)) continue;
    const b = loopBox(l), pad = (finger ? 12 : 5) * k;
    if (wx < b.x0 - pad || wx > b.x1 + pad || wy < b.y0 - pad || wy > b.y1 + pad) continue;
    if (finger) return l;
    if (!(wx > b.x0 + 8 * k && wx < b.x1 - 8 * k && wy > b.y0 + 8 * k && wy < b.y1 - 8 * k)) return l;
    for (const id of l.strokeIds) {
      const s = doc.strokes[id]; if (!s) continue;
      const tol = Math.max(3, 6 * k) + s.w / 2, bb = bbox(s);
      if (wx < bb.x0 - tol || wx > bb.x1 + tol || wy < bb.y0 - tol || wy > bb.y1 + tol) continue;
      for (let j = 0; j < s.pts.length; j++) { const p = s.pts[j], q = s.pts[Math.min(s.pts.length - 1, j + 1)]; if (segDist(p[0], p[1], q[0], q[1], wx, wy, wx, wy) < tol) return l; }
    }
  }
  return null;
}

/* what each number does in the formula, for slider labels */
function litRoles(expr) {
  const out = new Map();
  let toks; try { toks = ME.tokenize(expr); } catch (e) { return out; }
  const cuts = []; let depth = 0;
  for (const t of toks) if (t.type === 'op') { if (t.v === '(') depth++; else if (t.v === ')') depth--; else if (t.v === '=' && !depth) cuts.push(t); }
  const segs = []; let st = 0;
  for (const c of cuts) { segs.push([st, c.start]); st = c.end; }
  segs.push([st, expr.length]);
  const hasVar = n => !!n && (n.t === 'var' || (n.a && (Array.isArray(n.a) ? n.a.some(hasVar) : hasVar(n.a))) || hasVar(n.b) || (n.items && n.items.some(hasVar)));
  const short = n => { const t = ME.pp(n); return t.replace(/<[^>]+>/g, '').length > 16 ? 'the term' : t; };
  const role = chain => {
    let i = chain.length - 1, neg = false;
    while (i >= 0 && (chain[i][0].t === 'neg' || chain[i][0].t === 'group')) { if (chain[i][0].t === 'neg') neg = true; i--; }
    if (i < 0) return 'constant';
    const [P, side] = chain[i];
    if (P.t === 'op') {
      const other = side === 'a' ? P.b : P.a;
      if (P.o === '^') return side === 'b' ? `exponent of ${short(P.a)}` : 'base';
      if (P.o === '*') return hasVar(other) ? `multiplier of ${short(other)}` : 'factor';
      if (P.o === '/') return side === 'a' ? (hasVar(other) ? `top of ÷ ${short(other)}` : 'numerator') : 'divisor';
      if (P.o === '+') return neg ? 'subtracted value' : 'added value';
      if (P.o === '-') return side === 'b' ? (neg ? 'added value' : 'subtracted value') : 'starting value';
    }
    if (P.t === 'fn') return `inside ${P.n}( )`;
    if (P.t === 'tuple') return 'coordinate';
    return 'number';
  };
  const walk = (n, chain, off) => {
    if (!n) return;
    if (n.t === 'num') { out.set(n.lit + off, role(chain)); return; }
    if (n.t === 'op') { walk(n.a, [...chain, [n, 'a']], off); walk(n.b, [...chain, [n, 'b']], off); }
    else if (n.t === 'neg' || n.t === 'group') walk(n.a, [...chain, [n, 'a']], off);
    else if (n.t === 'fn') n.a.forEach(x => walk(x, [...chain, [n, 'arg']], off));
    else if (n.t === 'tuple') n.items.forEach(x => walk(x, [...chain, [n, 'item']], off));
  };
  for (const [a, b] of segs) {
    const text = expr.slice(a, b); if (!text.trim()) continue;
    const off = toks.filter(t => t.type === 'num' && t.start < a).length;
    try { walk(ME.parse(text), [], off); } catch (e) { }
  }
  return out;
}

let lmenu = null;
const KIND_LABEL = { solid: 'Solid', function: 'Function', polar: 'Polar curve', parametric: 'Parametric curve', implicit: 'Curve', surface: 'Surface', curve3d: '3D curve', implicit3d: '3D surface', evaluate: 'Calculation', value: 'Calculation', check: 'Check', solve: 'Equation', assign: 'Variable' };
function lineMathHTML(l, an) {
  const show = n => ME.pp(n);
  switch (an.kind) {
    case 'function': return `${an.name === 'y' ? '<i>y</i>' : an.name.replace('(x)', '(<i>x</i>)')} = ${show(an.f)}`;
    case 'polar': return `<i>r</i> = ${show(an.f)}`;
    case 'parametric': return `(${show(an.fx)}, ${show(an.fy)})`;
    case 'implicit': case 'implicit3d': return `${show(an.g.a)} = ${show(an.g.b)}`;
    case 'surface': return `${an.name ? esc(an.name).replace(/\b([xy])\b/g, '<i>$1</i>') : '<i>z</i>'} = ${show(an.f)}`;
    case 'curve3d': return `(${show(an.fx)}, ${show(an.fy)}, ${show(an.fz)})`;
    case 'solid': return solidShort(an);
    case 'evaluate': case 'value': return `${show(an.lhs)} = <b>${ME.fmt(an.c.lhs(scope))}</b>`;
    case 'assign': return `<i>${an.name}</i> = ${ME.fmt(an.c.rhs(scope))}`;
    case 'solve': return `${esc(l.expr)} &nbsp;→&nbsp; <b>${esc(solveText(l, an))}</b>`;
    default: return esc(l.expr || '');
  }
}
function openLineMenu(l) { closePop(); if (lmenu) closeLineMenu(); lmenu = { l, tx: false, rows: [] }; renderLineMenu(); refresh(); }
function closeLineMenu() { if (!lmenu) return; if (lmenu.tx) endTx(); lmenu = null; $('#lineMenu').hidden = true; refresh(); }
function graphThumb(g) {
  const ge = graphEls.get(g.id); if (!ge || !ge.canvas.width) return '';
  const c = document.createElement('canvas'); c.width = 120; c.height = 80;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 120, 80);
  const k = Math.max(120 / ge.canvas.width, 80 / ge.canvas.height), w = ge.canvas.width * k, h = ge.canvas.height * k;
  try { x.drawImage(ge.canvas, (120 - w) / 2, (80 - h) / 2, w, h); return c.toDataURL('image/png'); } catch (e) { return ''; }
}
function renderLineMenu() {
  const el = $('#lineMenu');
  if (!lmenu) { el.hidden = true; return; }
  const l = lmenu.l;
  if (!lineById(l.id) || !loopState(l)) { closeLineMenu(); return; }
  const ok = loopState(l) === 'ok', an = ok ? anOf(l) : null;
  let h = `<div class="lm-head"><span class="lm-kind">${l.fitted ? 'From your sketch' : an ? (KIND_LABEL[an.kind] || 'Math') : 'Not read'}</span><span class="lm-math">${an ? lineMathHTML(l, an) : (l.expr ? esc(l.expr) : '')}</span><button class="lm-x" data-a="close" aria-label="Close">×</button></div>`;
  lmenu.rows = [];
  if (!an) {
    const why = l.status === 'unavailable' ? 'Handwriting can only be read when this page is open in Claude.' : l.status === 'notmath' ? 'This doesn’t look like math.' : l.status === 'error' ? (l.err || 'Couldn’t read this line.') : 'This line hasn’t been read yet.';
    h += `<p class="lm-note">${esc(why)}</p><div class="lm-foot">${readState.ok !== false ? '<button data-a="read">Read now</button>' : ''}<button data-a="edit">Type it</button><button data-a="ignore">Not math</button></div>`;
  } else {
    const v = verdict(l); if (v) h += `<p class="lm-note ${v.ok ? 'ok' : 'bad'}">${v.ok ? '✓ ' : ''}${esc(v.full)}</p>`;
    const solid = an.kind === 'solid';
    if (solid) h += `<p class="lm-note lm-solid">${solidInfoHTML(l, an)}</p>`;
    if (l.traces && !(l.traces.x && l.traces.y)) h += `<p class="lm-note">Now draw how <i>z</i> changes along <i>${l.traces.x ? 'y' : 'x'}</i> to finish the surface.</p>`;
    // sliders: every number written in the line, plus free variables
    const roles = solid ? new Map(SOLID[an.solid].p.map((p, i) => [i, p])) : litRoles(l.expr);
    for (const a of l.anchors || []) {
      if (a.type === 'param' && scope.__assigned && scope.__assigned.has(a.name)) continue;
      const isLit = a.type === 'lit';
      const role = isLit ? (roles.get(a.lit) || 'number') : null;
      const signed = isLit && signedRole(role) ? signedTerm(l, a) : null;
      const v0 = signed != null ? signed : isLit ? litValue(l, a.lit) : (scope[a.name] != null ? scope[a.name] : 1);
      if (v0 == null) continue;
      const t0 = isLit ? ((ME.tokenize(l.expr).find(t => t.type === 'num' && t.lit === a.lit) || {}).text || '') : '';
      const step = solid ? 0.1 : isLit ? (t0.includes('.') ? (t0.split('.')[1].length > 1 ? 0.01 : 0.1) : 1) : 0.1;
      const R = Math.max(10, Math.ceil(Math.abs(v0) * 2));
      const constTerm = signed != null && !/^multiplier/.test(role);
      lmenu.rows.push({ a, step, signed: signed != null, constTerm, min: solid ? 0.1 : null });
      const lab = constTerm ? (v0 < 0 ? 'subtracted value' : 'added value') : isLit ? role : `variable <i>${esc(a.name)}</i>`;
      const i = lmenu.rows.length - 1;
      lmenu.rows[i].v0 = v0; lmenu.rows[i].label = lab.replace(/<[^>]+>/g, '');
      h += `<div class="lm-row"><span class="lm-lab" data-l="${i}">${lab}</span><div class="isl" data-i="${i}"></div><output data-o="${i}">${fmtNum(v0, step).replace('-', '−')}</output></div>`;
    }
    if (l.fitted && (l.alts || []).some(a => a.expr !== l.expr)) {
      h += `<div class="lm-sec">Other matches</div><div class="lm-alts">${l.alts.map((a, i) => a.expr === l.expr ? '' : `<button data-a="alt" data-x="${i}"><small>${esc(a.name)}</small><span>${exprHTML(a.expr)}</span></button>`).join('')}</div>`;
    }
    if (GRAPHABLE.has(an.kind)) {
      const k = an.kind, btns = [];
      if (['function', 'polar', 'parametric', 'implicit'].includes(k)) btns.push(['new2d', 'New 2D graph']);
      if (k === 'function' || GRAPH3D.has(k)) btns.push(['new3d', 'New 3D graph']);
      if (k === 'surface') btns.push(['contour', 'New contour map']);
      h += `<div class="lm-sec">Graph</div><div class="lm-btns">${btns.map(([a, t]) => `<button data-a="${a}">${t}</button>`).join('')}</div>`;
      const lb = lineAnchorBox(l), mine = lineGraphs(l);
      const targets = doc.graphs.filter(g => k === 'function' ? true : GRAPH3D.has(k) ? graphIs3D(g) : !graphIs3D(g))
        .sort((p, q) => Math.hypot(p.x + p.w / 2 - lb.cx, p.y - lb.cy) - Math.hypot(q.x + q.w / 2 - lb.cx, q.y - lb.cy)).slice(0, 6);
      if (targets.length) {
        h += `<div class="lm-sub">Add to a graph on this notebook</div><div class="lm-graphs">`;
        for (const g of targets) {
          const inG = mine.includes(g), d3 = graphIs3D(g), first = g.lineIds.map(lineById).find(x => x && x.expr);
          const desc = first ? esc((first.virtual ? first.expr : first.expr).slice(0, 30)) : '';
          h += `<button class="lm-g${inG ? ' in' : ''}" data-a="${inG ? 'remove' : 'add'}" data-g="${g.id}"><img alt="" src="${graphThumb(g)}"><span class="lm-gt"><b>Graph ${doc.graphs.indexOf(g) + 1}</b> · ${d3 ? '3D' : '2D'} · page ${Math.floor(g.y / (PAGE_H + PAGE_GAP)) + 1}<small>${desc}</small></span><em>${inG ? 'Added · remove' : (d3 && k === 'function' ? 'Add as z = f(x)' : 'Add')}</em></button>`;
        }
        h += `</div>`;
      }
    }
    h += solid && l.fitted ? `<div class="lm-foot">${solidFuncs(an.solid, solidVals(an)).key ? '<button data-a="fxalone" title="Open the curved function in a new 3D graph, with the partial derivatives, level curves and the other multivariable tools">Graph <i>z</i> = <i>f</i>(<i>x</i>, <i>y</i>) by itself</button>' : ''}<button data-a="removefit">Remove</button></div>`
      : l.traces ? `<div class="lm-foot"><button data-a="swapxy" title="Read the x trace as the y trace and the other way round">Swap <i>x</i> ↔ <i>y</i></button><button data-a="write">✎ Write on page</button><button data-a="removefit">Remove</button></div>`
      : l.fitted ? `<div class="lm-foot"><button data-a="write">✎ Write on page</button>${l.sketch ? `<button data-a="sketch">${l.showSketch === true ? 'Hide sketch' : 'Show sketch'}</button>` : ''}<button data-a="removefit">Remove</button></div>`
      : `<div class="lm-foot"><button data-a="edit">✎ Fix reading</button><button data-a="ignore">Not math</button></div>`;
  }
  el.innerHTML = h; el.hidden = false;
  lmenu.rows.forEach((row, i) => makeInfSlider(el.querySelector(`.isl[data-i="${i}"]`), {
    value: row.v0, step: row.step, label: row.label, min: row.min,
    onStart: () => { if (lmenu && !lmenu.tx) lmenu.tx = beginTx(); },
    onInput: v => applyRow(i, v),
    onEnd: () => { if (lmenu && lmenu.tx) { endTx(); lmenu.tx = false; scheduleSave(); } },
  }));
  positionLineMenu();
}
function positionLineMenu() {
  if (!lmenu) return;
  const el = $('#lineMenu'), w = el.offsetWidth || 340, h = el.offsetHeight || 200;
  let sx0, sy0, sy1;
  if (lmenu.l.fitted) {
    const chip = document.querySelector(`.gfit[data-l="${lmenu.l.id}"]`), ge = graphEls.get(lmenu.l.gid);
    const rr = chip ? chip.getBoundingClientRect() : ge ? ge.el.getBoundingClientRect() : null; if (!rr) return;
    sx0 = rr.left; sy0 = rr.top; sy1 = rr.bottom;
  } else { const b = loopBox(lmenu.l); [sx0, sy0] = toScreen(b.x0, b.y0); sy1 = toScreen(b.x1, b.y1)[1]; }
  const r = viewport.getBoundingClientRect();
  const below = sy1 + 10 + h < r.bottom - 8 || sy0 - h - 10 < r.top + 8;
  el.style.left = clamp(sx0, r.left + 8, r.right - w - 8) + 'px';
  el.style.top = clamp(below ? sy1 + 10 : sy0 - h - 10, r.top + 8, Math.max(r.top + 8, r.bottom - h - 8)) + 'px';
}
$('#lineMenu').addEventListener('pointerdown', e => e.stopPropagation());
function applyRow(i, v) {
  if (!lmenu) return;
  const row = lmenu.rows[i]; if (!row) return;
  if (row.min != null) v = Math.max(row.min, v);
  if (row.a.type === 'lit') { if (row.signed) setSignedTerm(lmenu.l, row.a, v, row.step); else setLitValue(lmenu.l, row.a, v, row.step); } else doc.params[row.a.name] = r2(v);
  const o = $('#lineMenu').querySelector(`[data-o="${i}"]`); if (o) o.textContent = fmtNum(v, row.step).replace('-', '−');
  if (row.constTerm) { const lb = $('#lineMenu').querySelector(`[data-l="${i}"]`); if (lb) lb.textContent = v < 0 ? 'subtracted value' : 'added value'; }
  const m = $('#lineMenu .lm-math'); if (m && loopState(lmenu.l) === 'ok') m.innerHTML = lineMathHTML(lmenu.l, anOf(lmenu.l));
  const ib = $('#lineMenu .lm-solid'); if (ib && anOf(lmenu.l).kind === 'solid') ib.innerHTML = solidInfoHTML(lmenu.l, anOf(lmenu.l));
  refresh();
}
$('#lineMenu').addEventListener('click', e => {
  const b = e.target.closest('button[data-a]'); if (!b || !lmenu) return;
  const a = b.dataset.a, l = lmenu.l;
  if (a === 'close') { closeLineMenu(); return; }
  if (a === 'alt') { const alt = l.alts[Number(b.dataset.x)]; if (alt) { transact(() => { l.expr = alt.expr; l.fam = alt.fam; l.name = alt.name; fittedAnchors(l); }); refresh(); queueGraph(l.gid); setTimeout(renderLineMenu, 30); } return; }
  if (a === 'write') { closeLineMenu(); writeFitOnPage(l); return; }
  if (a === 'sketch') { const on = l.showSketch !== true; sketchUntil.delete(l.id); transact(() => { l.showSketch = on; }); queueGraph(l.gid); refresh(); setTimeout(renderLineMenu, 30); return; }
  if (a === 'removefit') { closeLineMenu(); removeFit(l); return; }
  if (a === 'fxalone') {   // the solid's curved function as a surface of its own, where every multivariable tool works
    const an = anOf(l), S = solidFuncs(an.solid, solidVals(an)), fn = S.key === 'bot' ? S.bot : S.top;
    closeLineMenu();
    let g = null;
    transact(() => {
      const nl = { id: uid(), fitted: true, gid: l.gid, expr: `z = ${fn.expr}`, name: 'Surface', alts: [], strokeIds: [], clusters: [], status: 'ok', dirty: false, ver: 1, colorIdx: l.colorIdx, anchors: [] };
      fittedAnchors(nl); doc.lines.push(nl);
      g = createGraphFor(nl); nl.gid = g.id;
    });
    refresh(); if (g) setTimeout(() => revealGraph(g), 60);
    return;
  }
  if (a === 'swapxy' && l.traces) {
    transact(() => { const t = l.traces; l.traces = {}; if (t.y) l.traces.x = t.y; if (t.x) l.traces.y = t.x; const alts = composeTraces(l.traces); l.expr = alts[0].expr; l.name = alts[0].name; l.alts = alts; fittedAnchors(l); });
    refresh(); queueGraph(l.gid); setTimeout(renderLineMenu, 30); return;
  }
  if (a === 'edit') { closeLineMenu(); openEdit(l); return; }
  if (a === 'read') { closeLineMenu(); lineChanged(l); queueRead(l); return; }
  if (a === 'ignore') { closeLineMenu(); transact(() => { l.ignored = true; const v = virtualFor(l); doc.graphs.forEach(g => { g.lineIds = g.lineIds.filter(id => id !== l.id && (!v || id !== v.id)); }); }); refresh(); return; }
  if (lmenu.tx) { endTx(); lmenu.tx = false; }
  let g = null;
  if (a === 'new2d') transact(() => { g = createGraphFor(l); });
  else if (a === 'new3d') transact(() => { g = createGraphFor(l, { as3d: anOf(l).kind === 'function' }); });
  else if (a === 'contour') transact(() => { g = createGraphFor(l); g.mode = 'level'; });
  else if (a === 'add') transact(() => { g = graphById(Number(b.dataset.g)); if (g) addLineToGraph(l, g); });
  else if (a === 'remove') { transact(() => { const gg = graphById(Number(b.dataset.g)); const v = virtualFor(l); if (gg) gg.lineIds = gg.lineIds.filter(id => id !== l.id && (!v || id !== v.id)); }); refresh(); setTimeout(renderLineMenu, 30); return; }
  closeLineMenu(); refresh();
  if (g) { const gg = g; setTimeout(() => revealGraph(gg), 60); }
});
function addLineToGraph(l, g) {
  if (l.colorIdx == null) l.colorIdx = nextColor();
  if (graphIs3D(g) && anOf(l).kind === 'function') { const v = ensureVirtual(l); if (!g.lineIds.includes(v.id)) g.lineIds.push(v.id); }
  else if (!g.lineIds.includes(l.id)) g.lineIds.push(l.id);
}
function revealGraph(g) {
  const ge = graphEls.get(g.id); if (!ge) return;
  ge.el.classList.remove('pulse'); void ge.el.offsetWidth; ge.el.classList.add('pulse');
  const r = viewport.getBoundingClientRect(), [, sy] = toScreen(g.x, g.y), [, ey] = toScreen(g.x, g.y + g.h);
  if (sy < r.top + 10 || ey > r.bottom - 10) { view.ty += (r.top + Math.max(60, (r.height - (ey - sy)) / 2)) - sy; applyView(); }
}

/* reading progress lives quietly in the top-right corner of the page area */
let readOkUntil = 0, readErrUntil = 0, readErrN = 0;
function noteReadDone(ok) {
  const now = performance.now();
  if (ok) readOkUntil = now + 1400; else { readErrN = now < readErrUntil ? readErrN + 1 : 1; readErrUntil = now + 3200; }
  clearTimeout(noteReadDone.t); noteReadDone.t = setTimeout(updateReadStatus, ok ? 1450 : 3250);
}
function updateReadStatus() {
  const el = $('#readStatus'); if (!el || currentNb == null) return;
  const reading = doc.lines.filter(l => l.status === 'reading').length, now = performance.now();
  let cls = 'rstat', html = '';
  if (reading) { cls += ' on'; html = `<span class="spin" aria-hidden="true"></span>Reading${reading > 1 ? ` ${reading} lines` : ''}…`; }
  else if (now < readErrUntil) { cls += ' on err'; html = readErrN > 1 ? `Couldn’t read ${readErrN} lines` : 'Couldn’t read a line · tap it'; }
  else if (now < readOkUntil) { cls += ' on ok'; html = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Read`; }
  if (el.className !== cls) el.className = cls;
  if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
}

/* ---------- graphs ---------- */
const graphEls = new Map();
const graphQueue = new Set();
function queueGraph(id) { graphQueue.add(id); if (!queueGraph.raf) queueGraph.raf = requestAnimationFrame(() => { queueGraph.raf = 0; const ids = [...graphQueue]; graphQueue.clear(); ids.forEach(drawGraph); }); }
function graphById(id) { return doc.graphs.find(g => g.id === id); }
function nextColor() { const used = doc.lines.map(l => l.colorIdx).filter(v => v != null); for (let i = 0; i < GCOL.length; i++) if (!used.includes(i)) return i; return used.length % GCOL.length; }
function defaultView(g, w, h) {
  const lines = g.lineIds.map(lineById).filter(Boolean);
  const kinds = lines.map(l => anOf(l).kind);
  let xr = 5;
  const aspect = h / w;
  if (g.is3d || kinds.some(k => GRAPH3D.has(k))) { const r = kinds.includes('implicit3d') ? 4 : 3; return { x0: -r, x1: r, y0: -r, y1: r }; }
  if (kinds.length && kinds.every(k => k === 'polar' || k === 'parametric')) {
    let m = 0.5;
    for (const l of lines) for (const [x, y] of sampleCurve(l, 240)) if (isFinite(x) && isFinite(y)) m = Math.max(m, Math.abs(x), Math.abs(y) / aspect);
    xr = Math.min(50, m * 1.2);
  }
  return { x0: -xr, x1: xr, y0: -xr * aspect, y1: xr * aspect };
}
function createGraphFor(l, opt = {}) {
  const lb = lineAnchorBox(l);
  if (l.colorIdx == null) l.colorIdx = nextColor();
  const target = opt.as3d ? ensureVirtual(l) : l;
  const d3 = opt.as3d || GRAPH3D.has(anOf(l).kind);
  const x = Math.round(clamp(lb.x0, 24, PAGE_W - 304));
  const w = Math.max(280, Math.min(d3 ? 500 : 470, PAGE_W - x - 24)), h = d3 ? 430 : 320;
  const y = freeSpot(x, Math.round(lb.y1 + 22), w, h);
  const g = { id: uid(), x, y, w, h, lineIds: [target.id], view: null, mode: 'surface', show: { d: false, tan: false, area: false, riem: false, anti: false, floor: false, tp: false }, px: 1, py: 0.5, cam: null, x0: 1, a: -1, b: 1, n: 8, method: 'mid', C: 0 };
  g.view = defaultView(g, g.w, g.h - 40);
  doc.graphs.push(g);
  return g;
}
function addToNearestGraph(l) {
  const lb = lineBB(l);
  let best = null, bd = Infinity;
  const want3 = GRAPH3D.has(anOf(l).kind);
  for (const g of doc.graphs) { if (graphIs3D(g) !== want3) continue; const d = Math.hypot(g.x + g.w / 2 - lb.cx, g.y + g.h / 2 - lb.cy); if (d < bd) { bd = d; best = g; } }
  if (!best) return createGraphFor(l);
  if (l.colorIdx == null) l.colorIdx = nextColor();
  best.lineIds.push(l.id);
}
function sampleCurve(l, n) {
  const an = anOf(l), out = [];
  if (an.kind === 'polar') {
    const T = an.nonTrigTheta ? 6 * Math.PI : 2 * Math.PI;
    for (let i = 0; i <= n; i++) { const th = T * i / n; const r = an.c.f(scope, 0, 0, th, th); out.push([r * Math.cos(th), r * Math.sin(th)]); }
  } else if (an.kind === 'parametric') {
    const trig = !usesOutsideTrig(an.fx, 't') && !usesOutsideTrig(an.fy, 't');
    const t0 = trig ? 0 : -10, t1 = trig ? 2 * Math.PI : 10;
    for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * i / n; out.push([an.c.fx(scope, 0, 0, t, t), an.c.fy(scope, 0, 0, t, t)]); }
  }
  return out;
}
function graphIs3D(g) { return !!g.is3d || g.lineIds.some(id => { const l = lineById(id); return l && l.expr && GRAPH3D.has(anOf(l).kind); }); }
function primarySurface(g) { for (const id of g.lineIds) { const l = lineById(id); if (liveLine(l) && anOf(l).kind === 'surface') return l; } return null; }
const MODES3 = [['surface', '3D', 'Shaded 3D surface'], ['wire', 'Wire', '3D wireframe'], ['level', 'Level', 'Level curves (contour map)'], ['heat', 'Heat', 'Heat map with level curves'], ['grad', '∇f', 'Gradient vector field'], ['slice', 'Slices', 'Cross-sections through point P']];
const MODES2D = new Set(['level', 'heat', 'grad', 'slice']);
function is3DView(g) { return graphIs3D(g) && !(primarySurface(g) && MODES2D.has(g.mode)); }
function camOf(g) { if (!g.cam) g.cam = { yaw: -0.62, pitch: 0.5, zoom: 1 }; return g.cam; }
function primaryFn(g) { for (const id of g.lineIds) { const l = lineById(id); if (liveLine(l) && anOf(l).kind === 'function') return l; } return null; }

const TOOLS = [
  ['d', 'f′', 'Show the derivative f′(x)'],
  ['tan', 'Tangent', 'Show a tangent line you can drag'],
  ['area', 'Area', 'Shade the area under the curve between two bounds'],
  ['riem', 'Riemann', 'Show a Riemann sum'],
  ['anti', 'F(x)+C', 'Show an antiderivative F(x) + C']
];
function ensureGraphEl(g) {
  const g0id = g.id;
  let ge = graphEls.get(g.id);
  if (ge) return ge;
  const el = document.createElement('div');
  el.className = 'graph'; el.dataset.id = g.id;
  el.innerHTML = `<div class="gbar"><span class="grip" title="Drag to move" aria-hidden="true">⠿</span><span class="gtype"></span>
    <span class="gtools">${TOOLS.map(([k, label, tip]) => `<button class="gt" data-k="${k}" title="${tip}" aria-pressed="false">${label}</button>`).join('')}</span>
    <span class="gmodes" hidden role="group" aria-label="Graph view">${MODES3.map(([k, label, tip]) => `<button class="gt" data-mode="${k}" title="${tip}" aria-pressed="false">${label}</button>`).join('')}</span>
    <span class="gcalc" hidden role="group" aria-label="Multivariable calculus"><button class="gt" data-k="dx" title="Show the partial derivative ∂f/∂x as a surface" aria-pressed="false">∂f/∂x</button><button class="gt" data-k="dy" title="Show the partial derivative ∂f/∂y as a surface" aria-pressed="false">∂f/∂y</button><button class="gt" data-k="dir" title="Directional derivative at P: drag the arrow in the Level, Heat or ∇f view" aria-pressed="false">Dᵤf</button><button class="gt" data-k="vol" title="Double integral: volume under the surface over a region R" aria-pressed="false">∬ Volume</button><button class="gt" data-k="box" title="3D Riemann sum with n×n boxes" aria-pressed="false">Riemann</button><span class="gnb" hidden><button class="gt sm" data-nb="-1" aria-label="Fewer boxes">−</button><span class="gn gnbv"></span><button class="gt sm" data-nb="1" aria-label="More boxes">+</button></span></span>
    <span class="g3t" hidden><button class="gt" data-k="floor" title="Draw level curves on the floor" aria-pressed="false">Floor contours</button><button class="gt" data-k="tp" title="Show point P with its partial derivatives, gradient and tangent plane" aria-pressed="false">Point P</button></span>
    <span class="griem" hidden><button class="gt sm" data-n="-1" aria-label="Fewer rectangles">−</button><span class="gn"></span><button class="gt sm" data-n="1" aria-label="More rectangles">+</button><span class="gm">${['left', 'mid', 'right'].map(m => `<button class="gt sm" data-m="${m}" aria-pressed="false">${m[0].toUpperCase()}</button>`).join('')}</span></span>
    <span class="gend"><span class="gd3" hidden role="group" aria-label="Draw in 3D"><button class="gt" data-d3="solid" title="Draw a solid: a circle becomes a sphere, a square or a box becomes a cube, an oval with sides becomes a cylinder or a cone" aria-pressed="false">◯ Shape</button><button class="gt" data-d3="trace" title="Draw traces: how z changes along x and along y, to build a surface z = f(x, y)" aria-pressed="false">∿ Traces</button></span><button class="gt gdraw" data-draw title="Draw a curve with the pencil and it becomes a function" aria-pressed="false">✎ Draw</button><button class="gt gclear" data-clear title="Remove the drawing: clears every sketched curve from this graph (undo brings it back)" hidden>Clear</button><button class="gt sm" data-reset title="Reset view" aria-label="Reset view">⟲</button><button class="gt sm gx" data-del title="Remove graph" aria-label="Remove graph">×</button></span></div>
    <div class="gplot"><canvas></canvas><svg class="gsk" aria-hidden="true"><path/><path class="ghost"/></svg><div class="glegend"></div><div class="gfits"></div></div><div class="gresize" title="Drag to resize" aria-hidden="true"></div>
    <button class="glock" title="Locked: write on it. Double-tap or tap here to unlock" aria-label="Unlock graph"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg></button>`;
  graphLayer.appendChild(el);
  ge = { el, canvas: el.querySelector('canvas'), legend: el.querySelector('.glegend'), hover: null };
  ge.legend.title = 'Tap to shrink or expand';
  ge.legend.addEventListener('pointerdown', e => e.stopPropagation());
  ge.legend.addEventListener('click', () => { const g = graphById(g0id); if (!g) return; g.legendMin = !g.legendMin; ge.legend.classList.toggle('min', g.legendMin); scheduleSave(); });
  ge.fits = el.querySelector('.gfits'); ge.skPath = el.querySelector('.gsk path'); ge.ghostPath = el.querySelector('.gsk path.ghost'); ge.pending = [];
  ge.fits.addEventListener('pointerdown', e => e.stopPropagation());
  ge.fits.addEventListener('click', e => { const b = e.target.closest('.gfit'); if (!b) return; const l = lineById(Number(b.dataset.l)); if (l) { if (lmenu && lmenu.l === l) closeLineMenu(); else openLineMenu(l); } });
  graphEls.set(g.id, ge);
  wireGraph(g.id, ge);
  return ge;
}
function wireGraph(id, ge) {
  const el = ge.el;
  el.addEventListener('pointerdown', e => e.stopPropagation());
  // double-tap (finger, pencil or mouse) anywhere but a button: lock the graph so you can write on it
  let tapA = null;
  el.addEventListener('pointerdown', e => { tapA = e.target.closest('button, .gresize, .glegend') ? null : { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; }, true);
  el.addEventListener('pointerup', e => {
    const a = tapA; tapA = null;
    if (!a || a.id !== e.pointerId) return;
    if (performance.now() - a.t > 320 || Math.hypot(e.clientX - a.x, e.clientY - a.y) > 10) { ge.lastTap = null; return; }
    const now = performance.now(), lt = ge.lastTap;
    if (lt && now - lt.t < 380 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 40) { ge.lastTap = null; const g = graphById(id); if (g) toggleLock(g); }
    else ge.lastTap = { t: now, x: e.clientX, y: e.clientY };
  }, true);
  el.querySelector('.glock').addEventListener('click', e => { e.stopPropagation(); const g = graphById(id); if (g && g.locked) toggleLock(g); });
  el.addEventListener('wheel', e => {
    const g = graphById(id); if (!g) return;
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    if (is3DView(g)) { const cam = camOf(g); cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.01), 0.35, 4); queueGraph(id); scheduleSave(); return; }
    const r = ge.canvas.getBoundingClientRect();
    zoomGraph(g, Math.exp(e.deltaY * 0.01), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  el.querySelector('.gbar').addEventListener('click', e => {
    const g = graphById(id); if (!g) return;
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.mode) { transact(() => { g.mode = b.dataset.mode; }); }
    else if (b.dataset.nb) { transact(() => { calcDefaults(g); g.nb = clamp(g.nb + Number(b.dataset.nb) * (g.nb >= 10 ? 2 : 1), 1, 30); }); }
    else if (b.dataset.k) { transact(() => { g.show[b.dataset.k] = !g.show[b.dataset.k]; calcDefaults(g); if (b.dataset.k === 'dir' && g.show.dir) g.show.tp = true; if (b.dataset.k === 'tan' || b.dataset.k === 'area' || b.dataset.k === 'riem') seedBounds(g); if (b.dataset.k === 'tp' && (g.px == null || g.py == null)) { g.px = 1; g.py = 0.5; } }); }
    else if (b.dataset.n) transact(() => { g.n = clamp(g.n + Number(b.dataset.n) * (g.n >= 20 ? 4 : 1), 1, 200); });
    else if (b.dataset.m) transact(() => { g.method = b.dataset.m; });
    else if (b.dataset.z) zoomGraph(g, Number(b.dataset.z), 0.5, 0.5);
    else if (b.hasAttribute('data-clear')) { clearDrawing(g); return; }
    else if (b.hasAttribute('data-draw')) { transact(() => { g.drawOn = !g.drawOn; }); flash(g.drawOn ? 'Draw on: sketch a curve with the pencil' : 'Draw off: the pencil moves the graph'); }
    else if (b.dataset.d3) {
      const k = b.dataset.d3, off = g.drawOn && (g.draw3 || 'solid') === k;
      transact(() => { if (off) g.drawOn = false; else { g.drawOn = true; g.draw3 = k; if (MODES2D.has(g.mode)) g.mode = 'surface'; } });
      const ge2 = graphEls.get(g.id); if (ge2) { ge2.pending = []; clearTimeout(ge2.skTimer); drawSketchOverlay(ge2); hideGhost(ge2); }
      flash(off ? 'Drawing off: drag to rotate' : k === 'trace' ? 'Traces: draw how z changes along x, then along y' : 'Shape: draw a solid or surface the way a textbook does');
    }
    else if (b.hasAttribute('data-reset')) transact(() => { const ge2 = graphEls.get(g.id); g.view = defaultView(g, g.w, ge2.canvas.clientHeight || g.h - 40); g.cam = null; });
    else if (b.hasAttribute('data-del')) { transact(() => { g.lineIds.forEach(lid => { const l = lineById(lid); if (l) l.noAutoGraph = true; }); doc.graphs = doc.graphs.filter(x => x.id !== g.id); doc.lines = doc.lines.filter(l => !(l.fitted && l.gid === g.id)); }); closeLineMenu(); refresh(); return; }
    refresh();
  });
  // move by bar
  el.querySelector('.gbar').addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const g = graphById(id); if (!g) return;
    e.preventDefault();
    beginTx();
    const sx = e.clientX, sy = e.clientY, gx = g.x, gy = g.y;
    el.setPointerCapture(e.pointerId);
    const mv = ev => { g.x = Math.round(gx + (ev.clientX - sx) / view.s); g.y = Math.round(gy + (ev.clientY - sy) / view.s); placeGraph(g); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); endTx(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  // resize
  el.querySelector('.gresize').addEventListener('pointerdown', e => {
    const g = graphById(id); if (!g) return;
    e.preventDefault(); e.stopPropagation();
    beginTx();
    const sx = e.clientX, sy = e.clientY, w0 = g.w, h0 = g.h;
    const v0 = clone(g.view);
    const tgt = e.target; tgt.setPointerCapture(e.pointerId);
    const mv = ev => {
      g.w = Math.round(clamp(w0 + (ev.clientX - sx) / view.s, 240, 900)); g.h = Math.round(clamp(h0 + (ev.clientY - sy) / view.s, 200, 900));
      const kx = g.w / w0, ky = g.h / h0;
      const cx = (v0.x0 + v0.x1) / 2, cy = (v0.y0 + v0.y1) / 2;
      g.view = { x0: cx - (cx - v0.x0) * kx, x1: cx + (v0.x1 - cx) * kx, y0: cy - (cy - v0.y0) * ky, y1: cy + (v0.y1 - cy) * ky };
      placeGraph(g); queueGraph(g.id);
    };
    const up = () => { tgt.removeEventListener('pointermove', mv); tgt.removeEventListener('pointerup', up); endTx(); };
    tgt.addEventListener('pointermove', mv); tgt.addEventListener('pointerup', up);
  });
  // plot interaction
  const cv = ge.canvas;
  const pts = new Map();
  let drag = null;
  const loc = e => { const r = cv.getBoundingClientRect(); const k = cv.clientWidth / (r.width || 1); return [(e.clientX - r.left) * k, (e.clientY - r.top) * k, k, r]; };
  cv.addEventListener('pointerdown', e => {
    const g = graphById(id); if (!g) return;
    e.preventDefault();
    if (e.pointerType === 'pen') notePen();
    if (!pts.size && !drag && (graphEraseStart(g, ge, e, loc(e)) || sketchStart(g, ge, e, loc(e)))) return;
    cv.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 2) {
      if (drag && drag.type === 'handle') endTx();
      const [a, b] = [...pts.values()];
      drag = { type: 'pinch', is3: is3DView(g), z0: camOf(g).zoom, d0: Math.hypot(a[0] - b[0], a[1] - b[1]), v0: clone(g.view), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
      return;
    }
    if (is3DView(g)) { const cam = camOf(g); hideGhost(ge); drag = { type: 'rot', sx: e.clientX, sy: e.clientY, yaw0: cam.yaw, pitch0: cam.pitch }; return; }
    const [px, py] = loc(e);
    const hnd = hitHandle(g, ge, px, py);
    if (hnd) { beginTx(); drag = { type: 'handle', k: hnd }; }
    else drag = { type: 'pan', sx: e.clientX, sy: e.clientY, v0: clone(g.view) };
  });
  cv.addEventListener('pointermove', e => {
    const g = graphById(id); if (!g) return;
    if (ge.sk && ge.sk.id === e.pointerId) { sketchMove(g, ge, e); return; }
    if (ge.er && ge.er.id === e.pointerId) { graphEraseMove(g, ge, e); return; }
    const [px, py, kk, r] = loc(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (!drag) { if (e.pointerType === 'mouse' && !is3DView(g)) { ge.hover = [px, py]; queueGraph(id); cv.style.cursor = hitHandle(g, ge, px, py) ? 'grab' : 'crosshair'; } else cv.style.cursor = g.drawOn && is3DView(g) ? 'crosshair' : 'grab'; return; }
    const W = cv.clientWidth, H = cv.clientHeight, v = g.view;
    const X = px / W * (v.x1 - v.x0) + v.x0, Y = v.y1 - py / H * (v.y1 - v.y0);
    if (drag.type === 'rot') {
      const cam = camOf(g);
      cam.yaw = drag.yaw0 + (e.clientX - drag.sx) * kk * 0.0105;
      cam.pitch = clamp(drag.pitch0 + (e.clientY - drag.sy) * kk * 0.0085, -0.2, 1.52);
    } else if (drag.type === 'pinch' && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const dist = Math.max(10, Math.hypot(a[0] - b[0], a[1] - b[1]));
      if (drag.is3) { camOf(g).zoom = clamp(drag.z0 * dist / drag.d0, 0.35, 4); }
      else {
        const k = drag.d0 / dist;
        const fx = (drag.cx - r.left) / r.width, fy = (drag.cy - r.top) / r.height, v0 = drag.v0;
        const cxw = v0.x0 + fx * (v0.x1 - v0.x0), cyw = v0.y1 - fy * (v0.y1 - v0.y0);
        g.view = { x0: cxw - (cxw - v0.x0) * k, x1: cxw + (v0.x1 - cxw) * k, y0: cyw - (cyw - v0.y0) * k, y1: cyw + (v0.y1 - cyw) * k };
      }
    } else if (drag.type === 'pan') {
      const dx = (e.clientX - drag.sx) * kk / W * (drag.v0.x1 - drag.v0.x0), dy = (e.clientY - drag.sy) * kk / H * (drag.v0.y1 - drag.v0.y0);
      g.view = { x0: drag.v0.x0 - dx, x1: drag.v0.x1 - dx, y0: drag.v0.y0 + dy, y1: drag.v0.y1 + dy };
    } else if (drag.type === 'handle') {
      const snap = v => Math.abs(v - Math.round(v)) < (g.view.x1 - g.view.x0) / 150 ? Math.round(v) : v;
      if (drag.k === 'x0') g.x0 = r2(snap(X)); else if (drag.k === 'a') g.a = r2(snap(X)); else if (drag.k === 'b') g.b = r2(snap(X)); else if (drag.k === 'C') g.C = r2(Y);
      else if (drag.k === 'P') { g.px = r2(snap(X)); g.py = r2(snap(Y)); }
      else if (drag.k === 'RA') { g.R.a = r2(snap(X)); g.R.c = r2(snap(Y)); }
      else if (drag.k === 'RB') { g.R.b = r2(snap(X)); g.R.d = r2(snap(Y)); }
      else if (drag.k === 'U') { g.dirA = Math.atan2(Y - g.py, X - g.px); }
    }
    ge.hover = null;
    queueGraph(id);
  });
  const end = e => {
    if (ge.sk && ge.sk.id === e.pointerId) { sketchEnd(g0(), ge, e.type === 'pointercancel'); return; }
    if (ge.er && ge.er.id === e.pointerId) { graphEraseEnd(ge); return; }
    pts.delete(e.pointerId);
    if (!drag) return;
    if (pts.size === 0) { if (drag.type === 'handle') endTx(); drag = null; refresh(); scheduleSave(); }
    else if (drag.type === 'pinch') { drag = null; scheduleSave(); }
  };
  const g0 = () => graphById(id);
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { ge.hover = null; queueGraph(id); });

}
/* ---------- sketch a curve on a 2D graph → elementary function ----------
   With "Draw" on, the pencil (or mouse; a finger when fingers draw) sketches on the graph.
   Strokes that follow each other quickly count as one sketch (both branches of 1/x).
   ~0.6 s after the last stroke the sketch is matched to the simplest elementary function. */
function canSketch(g, e) {
  if (!g.drawOn || g.locked || (graphIs3D(g) && !is3DView(g))) return false;
  if (!DRAW_TOOLS.has(ui.tool)) return false;
  if (e.pointerType === 'mouse' && e.button !== 0) return false;
  return e.pointerType !== 'touch' || fingersDraw();
}
function sketchStart(g, ge, e, [px, py]) {
  if (!canSketch(g, e) || hitHandle(g, ge, px, py)) return false;
  try { ge.canvas.setPointerCapture(e.pointerId); } catch (err) { }
  clearTimeout(ge.skTimer);
  ge.sk = { id: e.pointerId, pts: [] };
  closeLineMenu(); closePop();
  sketchMove(g, ge, e);
  return true;
}
function sketchMove(g, ge, e) {
  const cv = ge.canvas, r = cv.getBoundingClientRect(), W = cv.clientWidth, H = cv.clientHeight, k = W / (r.width || 1), v = g.view;
  for (const ce of coalesced(e)) {
    const px = (ce.clientX - r.left) * k, py = (ce.clientY - r.top) * k;
    const last = ge.sk.pts[ge.sk.pts.length - 1];
    if (last && Math.hypot(px - last[2], py - last[3]) < 0.8) continue;
    ge.sk.pts.push([v.x0 + px / W * (v.x1 - v.x0), v.y1 - py / H * (v.y1 - v.y0), px, py]);
  }
  if (!ge.skRaf) ge.skRaf = requestAnimationFrame(() => { ge.skRaf = 0; drawSketchOverlay(ge); });
}
function drawSketchOverlay(ge) {
  const svgEl = ge.skPath.ownerSVGElement, W = ge.canvas.clientWidth, H = ge.canvas.clientHeight;
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const all = ge.pending.concat(ge.sk ? [ge.sk.pts] : []);
  ge.skPath.setAttribute('d', all.map(st => st.length ? 'M' + st.map(p => p[2].toFixed(1) + ' ' + p[3].toFixed(1)).join('L') : '').join(''));
}
function sketchEnd(g, ge, cancelled) {
  const sk = ge.sk; ge.sk = null;
  if (!g || !sk) return;
  if (!cancelled && sk.pts.length) ge.pending.push(sk.pts);
  drawSketchOverlay(ge);
  clearTimeout(ge.skTimer);
  // a solid takes several strokes (a box can take nine), so 3D waits a little longer for the next one
  ge.skTimer = setTimeout(() => recognizeSketch(g.id), graphIs3D(g) ? (g.draw3 === 'trace' ? 650 : 1250) : 600);
}
const SKETCH_MSG = { 'too-short': 'Draw a longer curve on the graph', vertical: 'That’s a vertical line (x = constant), not a function of x', messy: 'Couldn’t match that to a function. Try one smooth stroke', 'no-fit': 'Couldn’t match that to a function. Try one smooth stroke' };
function recognizeSketch(gid) {
  const g = graphById(gid), ge = graphEls.get(gid); if (!g || !ge || ge.sk) return;
  let inkLen = 0; for (const st of ge.pending) for (let i = 1; i < st.length; i++) inkLen += Math.hypot(st[i][2] - st[i - 1][2], st[i][3] - st[i - 1][3]);
  if (graphIs3D(g)) {
    const px = ge.pending.map(st => st.map(p => [p[2], p[3]])); ge.pending = []; drawSketchOverlay(ge);
    if (px.length && inkLen >= 14) recognize3D(g, ge, px);
    return;
  }
  const strokes = ge.pending.map(st => st.map(p => [p[0], p[1]])); ge.pending = [];
  if (!strokes.length || inkLen < 14) { drawSketchOverlay(ge); return; }   // a tap, not a sketch
  const cv = ge.canvas;
  let res;
  try { res = SketchFit.recognize(strokes, g.view, cv.clientWidth, cv.clientHeight); } catch (err) { res = { error: 'no-fit' }; }
  if (!res || !res.best) {
    flash(SKETCH_MSG[res && res.error] || SKETCH_MSG['no-fit']);
    ge.skPath.parentNode.classList.add('fade'); setTimeout(() => { ge.skPath.parentNode.classList.remove('fade'); drawSketchOverlay(ge); }, 700);
    return;
  }
  const best = res.best;
  const keep = st => { const step = Math.max(1, Math.floor(st.length / 140)); return st.filter((p, i) => i % step === 0 || i === st.length - 1).map(p => [r3(p[0]), r3(p[1])]); };
  let l;
  transact(() => {
    l = { id: uid(), fitted: true, gid: g.id, fam: best.fam, name: best.name, expr: best.expr, alts: [best, ...res.alts].map(o => ({ expr: o.expr, fam: o.fam, name: o.name })),
      sketch: strokes.map(keep), strokeIds: [], clusters: [], status: 'ok', dirty: false, ver: 1, colorIdx: nextColor(), anchors: [] };
    fittedAnchors(l);
    doc.lines.push(l); g.lineIds.push(l.id);
  });
  sketchUntil.set(l.id, performance.now() + SKETCH_SHOW + SKETCH_FADE);
  setTimeout(() => fadeSketch(g.id), SKETCH_SHOW);
  drawSketchOverlay(ge); refresh(); queueGraph(g.id);
  flash(`${best.name}: ${exprPlain(best.expr)}`);
}
const r3 = v => Math.round(v * 1000) / 1000;
const sketchUntil = new Map();   // lineId → when its freshly drawn sketch finishes fading
const SKETCH_SHOW = 3000, SKETCH_FADE = 600;
function sketchAlpha(l) {
  if (!l.sketch) return 0;
  if (l.showSketch === true) return 1;
  const left = (sketchUntil.get(l.id) || 0) - performance.now();
  return left <= 0 ? 0 : Math.min(1, left / SKETCH_FADE);
}
// take one function off a graph (a function that only came from a sketch is deleted with it)
function dropFromGraph(g, l) {
  const v = virtualFor(l);
  g.lineIds = g.lineIds.filter(id => id !== l.id && (!v || id !== v.id));
  const used = new Set(doc.graphs.flatMap(x => x.lineIds));
  if (l.fitted && !used.has(l.id) && !(v && used.has(v.id))) doc.lines = doc.lines.filter(x => x !== l && x !== v);
  else if (l.sketch) { delete l.sketch; delete l.showSketch; }
}
// "Clear": back to a blank graph you can draw on (handwritten lines stay on the page)
function clearDrawing(g) {
  const ge = graphEls.get(g.id);
  if (ge) { ge.pending = []; ge.sk = null; clearTimeout(ge.skTimer); drawSketchOverlay(ge); hideGhost(ge); }
  closeLineMenu();
  transact(() => {
    for (const l of g.lineIds.map(lineById).filter(Boolean)) dropFromGraph(g, l);
    g.lineIds = []; g.drawOn = true;
    for (const k in g.show) g.show[k] = false;
    if (g.is3d) g.mode = 'surface';
    g.view = defaultView(g, g.w, ge ? ge.canvas.clientHeight || g.h - 40 : g.h - 40);
  });
  refresh(); queueGraph(g.id);
  flash('Drawing cleared · undo brings it back');
}
function canGraphErase(g, e) {
  if (g.locked || ui.tool !== 'eraser' || (graphIs3D(g) && !is3DView(g))) return false;
  if (e.pointerType === 'mouse' && e.button !== 0) return false;
  return e.pointerType !== 'touch' || fingersDraw();
}
function graphEraseStart(g, ge, e, [px, py]) {
  if (!canGraphErase(g, e)) return false;
  try { ge.canvas.setPointerCapture(e.pointerId); } catch (err) { }
  closeLineMenu();
  ge.er = { id: e.pointerId, own: beginTx(), hits: 0 };
  graphEraseAt(g, ge, px, py);
  return true;
}
function graphEraseMove(g, ge, e) {
  const cv = ge.canvas, r = cv.getBoundingClientRect(), k = cv.clientWidth / (r.width || 1);
  for (const ce of coalesced(e)) graphEraseAt(g, ge, (ce.clientX - r.left) * k, (ce.clientY - r.top) * k);
}
function graphEraseEnd(ge) {
  const er = ge.er; ge.er = null; if (!er) return;
  if (er.own) endTx();
  if (er.hits) { refresh(); flash(er.hits > 1 ? `${er.hits} drawings erased` : 'Erased · undo brings it back'); }
}
function graphEraseAt(g, ge, px, py) {
  const W = ge.canvas.clientWidth, H = ge.canvas.clientHeight, v = g.view;
  const X = x => (x - v.x0) / (v.x1 - v.x0) * W, Y = y => (v.y1 - y) / (v.y1 - v.y0) * H;
  const rad = Math.max(10, WIDTHS.eraser[ui.width.eraser] * view.s * 0.75);
  if (graphIs3D(g)) {   // rub over a drawn solid or surface: the smallest one under the eraser goes first
    const er = ge.er, pad = rad * 0.5, inside = (h, x, y) => x > h.x0 - pad && x < h.x1 + pad && y > h.y0 - pad && y < h.y1 + pad;
    if ((er.gone || []).some(h => inside(h, px, py))) return;   // still over something just erased: don't take what was behind it too
    let best = null;
    for (const h of (ge.geo && ge.geo.hits) || []) {
      const l = lineById(h.lid); if (!l || !l.fitted || !g.lineIds.includes(l.id) || !inside(h, px, py)) continue;
      if (!best || (h.x1 - h.x0) * (h.y1 - h.y0) < (best.x1 - best.x0) * (best.y1 - best.y0)) best = h;
    }
    if (best) { dropFromGraph(g, lineById(best.lid)); (er.gone = er.gone || []).push(best); er.hits++; queueGraph(g.id); }
    return;
  }
  for (const l of g.lineIds.map(lineById).filter(l => l && (l.fitted || l.sketch))) {
    let hit = false;
    if (sketchAlpha(l) > 0.2) for (const st of l.sketch || []) { for (const [x, y] of st) if (Math.hypot(X(x) - px, Y(y) - py) < rad) { hit = true; break; } if (hit) break; }
    if (!hit && liveLine(l)) {   // or rub over the curve itself
      const an = anOf(l);
      if (an.kind === 'function') for (let dx = -rad; dx <= rad && !hit; dx += 2) { const x = v.x0 + (px + dx) / W * (v.x1 - v.x0), y = an.c.f(scope, x); if (isFinite(y) && Math.hypot(dx, Y(y) - py) < rad) hit = true; }
    }
    if (hit) { dropFromGraph(g, l); ge.er.hits++; queueGraph(g.id); }
  }
}
function fadeSketch(gid) {   // redraw every frame while a sketch fades out
  const g = graphById(gid); if (!g) return;
  queueGraph(gid);
  const now = performance.now();
  if (g.lineIds.some(id => (sketchUntil.get(id) || 0) > now)) requestAnimationFrame(() => fadeSketch(gid));
}
function fittedAnchors(l) { l.anchors = []; try { for (const t of ME.tokenize(l.expr)) if (t.type === 'num') l.anchors.push({ type: 'lit', lit: t.lit, ci: [] }); } catch (e) { } }
function exprPlain(expr) { return expr.replace(/\*/g, '').replace(/sqrt/g, '√').replace(/abs\(([^()]*)\)/g, '|$1|').replace(/pi/g, 'π').replace(/-/g, '−'); }
function exprHTML(expr) { try { const an = analyzeStatement(expr); return lineMathHTML({ expr }, an); } catch (e) { return esc(expr); } }
// the recognized functions sit as small chips at the bottom-left of their graph
function renderFits(g, ge) {
  const fl = g.lineIds.map(lineById).filter(l => l && l.fitted && liveLine(l));
  const html = fl.map(l => `<button class="gfit${lmenu && lmenu.l === l ? ' on' : ''}" data-l="${l.id}" title="Options: sliders, other matches, write it on the page"><i style="background:${GCOL[(l.colorIdx || 0) % GCOL.length]}"></i><span class="gfit-m">${(() => { try { return lineMathHTML(l, anOf(l)); } catch (e) { return esc(l.expr); } })()}</span><span class="gfit-more">⌄</span></button>`).join('');
  if (ge.fits.dataset.h !== html) { ge.fits.innerHTML = html; ge.fits.dataset.h = html; }
  ge.fits.hidden = !fl.length;
}
// where a line "is" on the page (fitted functions live on their graph)
function lineAnchorBox(l) {
  if (l.fitted) { const g = graphById(l.gid); if (g) return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h, cx: g.x + g.w / 2, cy: g.y + g.h / 2, w: g.w, h: g.h }; }
  return lineBB(l);
}
// expression → handwriting text for the page ("2*sqrt(x - 1)" → "2√(x - 1)")
function exprToHand(expr) {
  let t = expr.replace(/sqrt\(/g, '√(').replace(/\bpi\b/g, 'π');
  for (let guard = 0; guard < 6 && /abs\(/.test(t); guard++) {
    const i = t.indexOf('abs('); let d = 0, j = i + 3;
    for (; j < t.length; j++) { if (t[j] === '(') d++; else if (t[j] === ')' && --d === 0) break; }
    t = t.slice(0, i) + '|' + t.slice(i + 4, j) + '|' + t.slice(j + 1);
  }
  t = t.replace(/(π\/\d+)\*x/g, '($1)x');
  t = t.replace(/([0-9π)])\*(?=[a-zπ(√|])/g, '$1').replace(/\*/g, '×');
  return t;
}
function writeFitOnPage(l) {
  const g = graphById(l.gid); if (!g) return;
  const h = 30, text = exprToHand(l.expr), STEPY = PAGE_H + PAGE_GAP, top = Math.floor(g.y / STEPY) * STEPY;
  const x = g.x + 4, y = g.y - 58 >= top + 16 ? g.y - 52 : g.y + g.h + 16;
  let nl = null;
  transact(() => {
    nl = writeLine(text, x, y, h, 31 + l.id, INK[0]);
    applyReading(nl, l.expr, nl.clusters);
    nl.colorIdx = l.colorIdx; nl.sketch = l.sketch; nl.showSketch = l.showSketch;
    for (const gg of doc.graphs) gg.lineIds = gg.lineIds.map(id => id === l.id ? nl.id : id);
    for (const v of doc.lines) if (v.virtual && v.src === l.id) v.src = nl.id;
    doc.lines = doc.lines.filter(x => x !== l);
  });
  syncInk(); markFresh(nl); refresh();
  flash('Written on the page: tap it for sliders');
}
function removeFit(l) {
  transact(() => {
    const v = virtualFor(l);
    for (const gg of doc.graphs) gg.lineIds = gg.lineIds.filter(id => id !== l.id && (!v || id !== v.id));
    doc.lines = doc.lines.filter(x => x !== l && x !== v);
  });
  refresh();
}
function insertBlankGraph(opt = {}) {
  const d3 = !!opt.d3;
  const r = viewport.getBoundingClientRect();
  const [cx, cy] = toWorld(r.left + r.width / 2, r.top + r.height * 0.42);
  const w = d3 ? 500 : 480, h = d3 ? 450 : 380, STEPY = PAGE_H + PAGE_GAP;
  const x = Math.round(clamp(cx - w / 2, 24, PAGE_W - w - 24));
  const p = clamp(Math.floor(cy / STEPY), 0, doc.pages - 1);
  let y0 = Math.round(clamp(cy - h / 2, p * STEPY + 24, p * STEPY + PAGE_H - h - 24));
  let g = null;
  transact(() => {
    const y = freeSpot(x, y0, w, h);
    g = { id: uid(), x, y, w, h, lineIds: [], view: null, mode: 'surface', drawOn: true, show: { d: false, tan: false, area: false, riem: false, anti: false, floor: false, tp: false }, px: 1, py: 0.5, cam: null, x0: 1, a: -1, b: 1, n: 8, method: 'mid', C: 0 };
    if (d3) { g.is3d = true; g.draw3 = opt.mode || 'solid'; }
    g.view = defaultView(g, w, h - 40);
    doc.graphs.push(g);
  });
  refresh();
  setTimeout(() => { revealGraph(g); flash(d3 ? 'Draw a solid or surface (sphere, cone, paraboloid, hyperboloid, saddle…) · or tap Traces for z = f(x, y)' : 'Draw a curve on the graph with the pencil'); }, 60);
  return g;
}
// a spot under (x, y) that doesn't overlap another graph or cross a page break (adds a page if needed)
function freeSpot(x, y, w, h) {
  const STEPY = PAGE_H + PAGE_GAP;
  for (let guard = 0; guard < 30; guard++) {
    const p = Math.floor(y / STEPY);
    if (y + h > p * STEPY + PAGE_H - 20) {
      if (p + 1 >= doc.pages) insertPages(doc.pages, [{ t: (doc.pageList[p] || {}).t || doc.template }]);
      y = (p + 1) * STEPY + 40; continue;
    }
    const hit = doc.graphs.find(o => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y);
    if (!hit) break;
    y = hit.y + hit.h + 16;
  }
  return y;
}

/* ---------- drawing on a 3D graph ----------
   Shape: a circle → sphere, a square (or a box drawn with its back face) → cube or box,
          an oval with straight sides → cylinder, a point with two sides down to an oval → cone.
   Traces: a curve drawn along the x axis is z = f(x, 0), one along the y axis is z = f(0, y);
          together they make the surface z = f(x, y). */
const SOLID_MSG = { 'too-short': 'Draw the shape a little bigger', flat: 'Draw the whole shape, the way a textbook draws it', messy: 'Couldn’t match that to a 3D graph. Try drawing it the way a textbook does: ovals for circles, with the sides joining them' };
function proj3(geo, cam, W, H) {   // the same camera as render3D, plus its inverse onto the planes y = 0 / x = 0
  const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const Sc = Math.min(W, H) * 0.44 / Math.hypot(geo.bx, geo.by, geo.bz) * cam.zoom, D = 5.5, oy = H * 0.02;
  const T = p => { const xr = p[0] * cyw - p[1] * syw, yr = p[0] * syw + p[1] * cyw; const up = p[2] * cp + yr * sp, depth = yr * cp - p[2] * sp; const f = D / (D + depth); return [W / 2 + xr * Sc * f, H / 2 + oy - up * Sc * f, depth]; };
  const unproj = (sx, sy, ax) => {
    const q = ax === 'x' ? -geo.yc / geo.hy * geo.by : -geo.xc / geo.hx * geo.bx;
    if ((ax === 'x' ? Math.abs(cyw) : Math.abs(syw)) < 0.2 || Math.abs(cp) < 0.15) return null;
    let f = 1, a = 0, w = 0;
    for (let it = 0; it < 6; it++) {
      const X = (sx - W / 2) / (Sc * f), Y = (H / 2 + oy - sy) / (Sc * f);
      let yr;
      if (ax === 'x') { a = (X + q * syw) / cyw; yr = a * syw + q * cyw; } else { a = (q * cyw - X) / syw; yr = q * syw + a * cyw; }
      w = (Y - yr * sp) / cp;
      f = D / (D + yr * cp - w * sp);
    }
    return [ax === 'x' ? geo.xc + a / geo.bx * geo.hx : geo.yc + a / geo.by * geo.hy, geo.zc + w / geo.bz * geo.hz];
  };
  return { T, unproj, Sc };
}
function unitsPerPx(g, ge) {
  const geo = ge.geo, W = ge.canvas.clientWidth, H = ge.canvas.clientHeight;
  if (!geo) return 6 / Math.max(100, Math.min(W, H));
  return geo.hx / geo.bx / proj3(geo, camOf(g), W, H).Sc;
}
const niceLen = v => v < 1 ? Math.max(0.25, Math.round(v * 4) / 4) : Math.round(v * 2) / 2;
// a height within 15% (in halves) that makes h / den a multiple of `step`: a cone's slope h/r, a paraboloid's h/r²
function niceRatio(den, h, step = 0.5) {
  let best = h, bd = Infinity;
  for (let c = Math.ceil(h * 0.85 * 2) / 2; c <= h * 1.15 + 1e-9; c += 0.5) {
    const q = c / den / step; if (c <= 0 || Math.abs(q - Math.round(q)) > 1e-9) continue;
    if (Math.abs(c - h) < bd) { bd = Math.abs(c - h); best = c; }
  }
  return best;
}
const niceCone = (r, h) => niceRatio(r, h, 0.5);
const nicePos = v => Math.max(0.5, Math.round(v * 2) / 2);
const niceK = k => { const L = [0.1, 0.2, 0.25, 0.5, 1, 2, 3, 4]; return L.reduce((b, x) => Math.abs(Math.log(x / k)) < Math.abs(Math.log(b / k)) ? x : b, 1); };
function solidReading(o, k) {
  const n = x => String(+niceLen(x * k).toFixed(2));
  if (o.type === 'cone' || o.type === 'vcone' || o.type === 'dcone') { const r = niceLen(o.r * k), h = niceCone(r, niceLen(o.h * k)); o = { ...o, r: r / k, h: h / k }; }
  if (o.type === 'paraboloid' || o.type === 'dome') { const r = niceLen(o.r * k), h = niceRatio(r * r, niceLen(o.h * k), 0.25); o = { ...o, r: r / k, h: h / k }; }
  const S = x => String(+(+x).toFixed(2));
  switch (o.type) {
    case 'ellipsoid': { const a = n(o.a), c = n(o.c); return a === c ? { type: 'sphere', name: 'Sphere', expr: `sphere(${a})` } : { type: 'ellipsoid', name: 'Ellipsoid', expr: `ellipsoid(${a}, ${c})` }; }
    case 'hemisphere': return { type: 'hemisphere', name: 'Hemisphere', expr: `hemisphere(${n(o.r)})` };
    case 'paraboloid': return { type: 'paraboloid', name: 'Paraboloid', expr: `paraboloid(${n(o.r)}, ${n(o.h)})` };
    case 'dome': return { type: 'dome', name: 'Paraboloid, opening down', expr: `dome(${n(o.r)}, ${n(o.h)})` };
    case 'dcone': return { type: 'dcone', name: 'Double cone', expr: `dcone(${n(o.r)}, ${n(o.h)})` };
    case 'hyperboloid': {   // waist a, half-height h; c so the top rim has the drawn radius: R² / a² − h² / c² = 1
      const a = +n(o.a), h = +n(o.h), R = Math.max(o.R * k, a * 1.15), c = nicePos(h / Math.sqrt(R * R / (a * a) - 1));
      return { type: 'hyperboloid', name: 'Hyperboloid of one sheet', expr: `hyperboloid(${S(a)}, ${S(c)}, ${S(h)})` };
    }
    case 'hyperboloidtwo': {   // vertices at ±c, half-height h; a so the rim has the drawn radius: h² / c² − R² / a² = 1
      const c = +n(o.c), h = Math.max(+n(o.h), c + 0.5), R = o.R * k, a = nicePos(R / Math.sqrt(h * h / (c * c) - 1));
      return { type: 'hyperboloidtwo', name: 'Hyperboloid of two sheets', expr: `hyperboloidtwo(${S(a)}, ${S(c)}, ${S(h)})` };
    }
    case 'saddle': { const sw = +n(o.s); return { type: 'saddle', name: 'Saddle (hyperbolic paraboloid)', expr: `saddle(${S(niceK(o.kn / sw))}, ${S(sw)})` }; }
    case 'tetra': return { type: 'tetra', name: 'Plane in the first octant', expr: `tetra(${n(o.a)}, ${n(o.b)}, ${n(o.c)})` };
    case 'sphere': return { type: 'sphere', name: 'Sphere', expr: `sphere(${n(o.r)})` };
    case 'cube': return { type: 'cube', name: 'Cube', expr: `cube(${n(o.s)})` };
    case 'box': return { type: 'box', name: 'Box', expr: `box(${n(o.a)}, ${n(o.b)}, ${n(o.c)})` };
    case 'cylinder': return { type: 'cylinder', name: 'Cylinder', expr: `cylinder(${n(o.r)}, ${n(o.h)})` };
    case 'cone': return { type: 'cone', name: 'Cone', expr: `cone(${n(o.r)}, ${n(o.h)})` };
    case 'vcone': return { type: 'vcone', name: 'Cone, point down', expr: `vcone(${n(o.r)}, ${n(o.h)})` };
  }
  return null;
}
// what was drawn stays on screen for a moment, then fades (screen space: it doesn't turn with the graph)
function showGhost(ge, strokes, ms) {
  const gp = ge.ghostPath; if (!gp) return;
  drawSketchOverlay(ge);
  clearTimeout(ge.ghostT1); clearTimeout(ge.ghostT2);
  gp.setAttribute('d', strokes.map(st => 'M' + st.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L')).join(''));
  gp.classList.remove('gone'); ge.ghostOn = true;
  ge.ghostT1 = setTimeout(() => gp.classList.add('gone'), ms);
  ge.ghostT2 = setTimeout(() => hideGhost(ge), ms + 650);
}
function hideGhost(ge) { if (!ge.ghostPath) return; clearTimeout(ge.ghostT1); clearTimeout(ge.ghostT2); ge.ghostPath.setAttribute('d', ''); ge.ghostPath.classList.remove('gone'); if (ge.ghostOn) { ge.ghostOn = false; const id = Number(ge.el.dataset.id); if (graphById(id)) queueGraph(id); } }
function recognize3D(g, ge, strokes) {
  if (g.draw3 === 'trace') return recognizeTraces(g, ge, strokes);
  let res; try { res = SolidFit.recognize(strokes); } catch (err) { res = { error: 'messy' }; }
  if (!res || !res.best) { flash(SOLID_MSG[res && res.error] || SOLID_MSG.messy); showGhost(ge, strokes, 500); return; }
  const k = unitsPerPx(g, ge);
  const opts = [res.best, ...res.alts].map(o => solidReading(o, k)).filter((o, i, a) => o && a.findIndex(q => q && q.expr === o.expr) === i);
  let l;
  transact(() => {
    l = { id: uid(), fitted: true, gid: g.id, fam: opts[0].type, name: opts[0].name, expr: opts[0].expr, alts: opts.map(o => ({ expr: o.expr, fam: o.type, name: o.name })),
      strokeIds: [], clusters: [], status: 'ok', dirty: false, ver: 1, colorIdx: nextColor(), anchors: [] };
    fittedAnchors(l);
    doc.lines.push(l); g.lineIds.push(l.id);
    if (MODES2D.has(g.mode)) g.mode = 'surface';
  });
  showGhost(ge, strokes, SKETCH_SHOW);
  refresh(); queueGraph(g.id);
  const an = anOf(l), inf = solidInfo(an.solid, solidVals(an));
  flash(`${opts[0].name}: ${plainHTML(solidRegionHTML(an))}${inf.V != null ? ` · volume ${fmtS(inf.V)}` : ''}`);
}
function traceLine(g) { return g.lineIds.map(lineById).find(l => l && l.fitted && l.traces); }
function fitTrace(geo, pr, strokes, ax) {
  const pts = strokes.map(st => st.map(p => pr.unproj(p[0], p[1], ax)).filter(Boolean)).filter(st => st.length > 1);
  if (!pts.length) return { error: 'axis' };
  const view = ax === 'x' ? { x0: geo.x0, x1: geo.x1, y0: geo.lo, y1: geo.hi } : { x0: geo.y0, x1: geo.y1, y0: geo.lo, y1: geo.hi };
  const A = pr.T(geo.N3(ax === 'x' ? geo.x0 : 0, ax === 'y' ? geo.y0 : 0, geo.zc)), B = pr.T(geo.N3(ax === 'x' ? geo.x1 : 0, ax === 'y' ? geo.y1 : 0, geo.zc));
  const Z0 = pr.T(geo.N3(0, 0, geo.lo)), Z1 = pr.T(geo.N3(0, 0, geo.hi));
  const Wp = Math.max(80, Math.hypot(B[0] - A[0], B[1] - A[1])), Hp = Math.max(60, Math.hypot(Z1[0] - Z0[0], Z1[1] - Z0[1]));
  let res; try { res = SketchFit.recognize(pts, view, Wp, Hp); } catch (err) { res = { error: 'no-fit' }; }
  if (!res || !res.best || res.best.fam === 'circle' || res.best.fam === 'ellipse') return { error: res && res.error === 'vertical' ? 'vertical' : 'messy' };
  const fam = res.best.fam; let P = res.best.P;
  // a trace is drawn through the axis: if centring it (h = 0) fits about as well, keep it centred
  if (['quad', 'cubic', 'abs'].includes(fam) && P.h) {
    const F = SketchFit.FAM[fam], data = pts.flat(), rms = Q => { const f = F.f(Q); let e = 0; for (const [u, z] of data) e += (f(u) - z) ** 2; return Math.sqrt(e / data.length); };
    const Q = { ...P, h: 0 }, f0 = F.f({ ...Q, k: 0 }); let m = 0; for (const [u, z] of data) m += z - f0(u); Q.k = Math.round(m / data.length * 2) / 2;
    if (rms(Q) <= rms(P) + 0.012 * (geo.hi - geo.lo)) P = Q;
  }
  return { fam, P };
}
// one trace without its constant: "x^2" and k = 1 for z = x² + 1; the y trace is written in y
function tracePart(tr, v) {
  const P = { ...tr.P }; let k;
  if (tr.fam === 'const') return { body: '', k: P.k, at0: 0 };
  if (tr.fam === 'line') { k = P.b; P.b = 0; } else { k = P.k || 0; P.k = 0; }
  let body = SketchFit.formula(tr.fam, P, false).replace(/^y\s*=\s*/, '');
  if (body === '0') body = '';
  if (v === 'y') body = body.replace(/\bx\b/g, 'y');
  let at0 = 0; try { at0 = body ? ME.compile(ME.parse(body))(scope, 0, 0) : 0; } catch (err) { at0 = 0; }
  return { body, k: k || 0, at0: isFinite(at0) ? at0 : 0 };
}
// z = f(x) + g(y) + c, with c chosen so both traces pass through what was drawn
function composeTraces(tr) {
  const X = tr.x ? tracePart(tr.x, 'x') : null, Y = tr.y ? tracePart(tr.y, 'y') : null;
  let c0 = X && Y ? (X.k - Y.at0 + Y.k - X.at0) / 2 : X ? X.k : Y.k;
  c0 = Math.round(c0 * 2) / 2;
  const cs = c0 ? String(c0) : '';
  const join = parts => parts.filter(Boolean).join(' + ').replace(/\+ -/g, '- ') || '0';
  const alts = [{ expr: 'z = ' + join([X && X.body, Y && Y.body, cs]), name: X && Y ? 'Sum of the traces' : 'Surface' }];
  // the same V along x and along y: the round version is the cone z = a√(x² + y²)
  if (X && Y && tr.x.fam === 'abs' && tr.y.fam === 'abs' && !tr.x.P.h && !tr.y.P.h) {
    const a = tr.x.P.a, b = tr.y.P.a;
    if (Math.sign(a) === Math.sign(b) && Math.abs(a - b) <= 0.3 * Math.max(Math.abs(a), Math.abs(b))) {
      const m = Math.abs(a - b) < 1e-9 ? a : (Math.round((a + b) * 2) / 4 || a);
      alts.unshift({ expr: 'z = ' + join([`${m === 1 ? '' : m === -1 ? '-' : m + '*'}sqrt(x^2 + y^2)`, cs]), name: 'Cone' });
      alts[1].name = 'Pyramid (sum of the traces)';
    }
  }
  return alts;
}
function recognizeTraces(g, ge, strokes) {
  const geo = ge.geo; if (!geo) return;
  const W = ge.canvas.clientWidth, H = ge.canvas.clientHeight, pr = proj3(geo, camOf(g), W, H);
  const O = pr.T(geo.N3(0, 0, geo.zc)), EX = pr.T(geo.N3(geo.x1, 0, geo.zc)), EY = pr.T(geo.N3(0, geo.y1, geo.zc));
  const dX = [EX[0] - O[0], EX[1] - O[1]], dY = [EY[0] - O[0], EY[1] - O[1]];
  const ang = (a, b) => { const d = Math.abs(Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])) % Math.PI; return Math.min(d, Math.PI - d); };
  const tl = traceLine(g), had = (tl && tl.traces) || {}, groups = { x: [], y: [] };
  for (const st of strokes) {
    const a = st[0], b = st[st.length - 1], ch = [b[0] - a[0], b[1] - a[1]];
    if (Math.hypot(ch[0], ch[1]) < 16) continue;
    let ax = ang(ch, dX), ay = ang(ch, dY);
    if (had.x && !had.y) ay -= 0.26; else if (had.y && !had.x) ax -= 0.26;   // the missing direction is the likely one
    groups[ax <= ay ? 'x' : 'y'].push(st);
  }
  if (!groups.x.length && !groups.y.length) { flash('Draw a longer curve, along the x axis or the y axis'); showGhost(ge, strokes, 500); return; }
  const got = {}; let err = null;
  for (const ax of ['x', 'y']) if (groups[ax].length) { const r = fitTrace(geo, pr, groups[ax], ax); if (r.error) err = r.error; else got[ax] = r; }
  if (!got.x && !got.y) {
    flash(err === 'axis' ? 'Turn the graph so that axis runs across the screen, then draw again' : err === 'vertical' ? 'That’s straight up: draw how z changes as you move along the axis' : 'Couldn’t read that curve. Try one smooth stroke along the axis');
    showGhost(ge, strokes, 500); return;
  }
  const traces = { ...had, ...got }, alts = composeTraces(traces);
  let l = tl;
  transact(() => {
    if (!l) { l = { id: uid(), fitted: true, gid: g.id, strokeIds: [], clusters: [], status: 'ok', dirty: false, ver: 1, colorIdx: nextColor(), anchors: [] }; doc.lines.push(l); g.lineIds.push(l.id); }
    l.traces = traces; l.fam = 'traces'; l.expr = alts[0].expr; l.name = alts[0].name; l.alts = alts;
    fittedAnchors(l);
  });
  showGhost(ge, strokes, SKETCH_SHOW);
  refresh(); queueGraph(g.id);
  const one = !(traces.x && traces.y);
  flash(one ? `Trace along ${traces.x ? 'x' : 'y'}: ${exprPlain(l.expr)} · now draw along ${traces.x ? 'y' : 'x'}` : exprPlain(l.expr));
}

function seedBounds(g) {
  const v = g.view, span = v.x1 - v.x0, c = (v.x0 + v.x1) / 2;
  if (g.x0 < v.x0 || g.x0 > v.x1) g.x0 = r2(c + span * 0.15);
  if (g.a < v.x0 || g.a > v.x1 || g.b < v.x0 || g.b > v.x1 || g.a >= g.b) { g.a = r2(c - span * 0.2); g.b = r2(c + span * 0.2); }
}
function zoomGraph(g, k, fx, fy) {
  const v = g.view;
  const cx = v.x0 + fx * (v.x1 - v.x0), cy = v.y1 - fy * (v.y1 - v.y0);
  g.view = { x0: cx - (cx - v.x0) * k, x1: cx + (v.x1 - cx) * k, y0: cy - (cy - v.y0) * k, y1: cy + (v.y1 - cy) * k };
  queueGraph(g.id); scheduleSave();
}
function toggleLock(g) {
  transact(() => { g.locked = !g.locked; });
  const ge = graphEls.get(g.id); if (ge) { ge.el.classList.toggle('locked', !!g.locked); ge.sig = null; ge.pending = []; ge.sk = null; clearTimeout(ge.skTimer); drawSketchOverlay(ge); }
  closeLineMenu(); refresh(); queueGraph(g.id);
  flash(g.locked ? 'Graph locked: write on it' : 'Graph unlocked');
}
function lockedGraphAt(wx, wy) { for (let i = doc.graphs.length - 1; i >= 0; i--) { const g = doc.graphs[i]; if (g.locked && wx >= g.x && wx <= g.x + g.w && wy >= g.y && wy <= g.y + g.h) return g; } return null; }
function placeGraph(g) {
  const ge = ensureGraphEl(g);
  ge.el.classList.toggle('locked', !!g.locked);
  ge.el.style.left = g.x + 'px'; ge.el.style.top = g.y + 'px'; ge.el.style.width = g.w + 'px'; ge.el.style.height = g.h + 'px';
}
function renderGraphs() {
  const live = new Set(doc.graphs.map(g => g.id));
  for (const [id, ge] of graphEls) if (!live.has(id)) { ge.el.remove(); graphEls.delete(id); }
  const scope = doc.lines.map(l => l.expr + ':' + l.status + ':' + (l.ver || 0) + ':' + l.colorIdx + (l.ignored ? '!' : '')).join('|') + JSON.stringify(doc.params);
  for (const g of doc.graphs) {
    placeGraph(g); updateGraphBar(g);
    const ge = graphEls.get(g.id), sig = JSON.stringify(g) + scope;
    if (!ge || ge.sig !== sig) { if (ge) ge.sig = sig; queueGraph(g.id); }
  }
}
function updateGraphBar(g) {
  const ge = ensureGraphEl(g);
  const lines = g.lineIds.map(lineById).filter(Boolean);
  const kinds = [...new Set(lines.filter(liveLine).map(l => anOf(l).kind))];
  const NAMES = { function: 'f(x)', polar: 'Polar', parametric: 'Parametric', implicit: 'Curve', surface: 'z = f(x, y)', curve3d: '3D curve', implicit3d: '3D surface', solid: 'Solid' };
  ge.el.querySelector('.gtype').textContent = kinds.map(k => NAMES[k] || k).join(' + ') || (g.is3d ? '3D graph' : 'Graph');
  const d3 = graphIs3D(g), surf = d3 && primarySurface(g);
  const hasF = !d3 && !!primaryFn(g);
  ge.el.querySelector('.gtools').hidden = !hasF;
  const gm = ge.el.querySelector('.gmodes'); gm.hidden = !surf;
  const mode = g.mode || 'surface';
  gm.querySelectorAll('.gt').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const g3 = ge.el.querySelector('.g3t'); g3.hidden = !surf;
  g3.querySelector('[data-k="floor"]').hidden = MODES2D.has(mode);
  g3.querySelectorAll('.gt').forEach(b => b.setAttribute('aria-pressed', String(!!g.show[b.dataset.k])));
  const gd = ge.el.querySelector('.gdraw'); gd.hidden = d3; gd.setAttribute('aria-pressed', String(!!g.drawOn));
  const g3d = ge.el.querySelector('.gd3'); g3d.hidden = !(d3 && (g.is3d || lines.some(l => l.fitted)));
  g3d.querySelectorAll('.gt').forEach(b => b.setAttribute('aria-pressed', String(!!g.drawOn && (g.draw3 || 'solid') === b.dataset.d3)));
  ge.el.querySelector('.gclear').hidden = !lines.some(l => l.fitted || l.sketch);
  const gc = ge.el.querySelector('.gcalc'); gc.hidden = !surf;
  gc.querySelectorAll('.gt[data-k]').forEach(b => b.setAttribute('aria-pressed', String(!!g.show[b.dataset.k])));
  gc.querySelector('.gnb').hidden = !g.show.box; gc.querySelector('.gnbv').textContent = `${g.nb || 4}×${g.nb || 4}`;
  ge.el.classList.toggle('is3d', d3);
  ge.el.querySelectorAll('.gtools .gt').forEach(b => b.setAttribute('aria-pressed', String(!!g.show[b.dataset.k])));
  const rm = ge.el.querySelector('.griem'); rm.hidden = !(hasF && g.show.riem);
  ge.el.querySelector('.griem .gn').textContent = 'n = ' + g.n;
  ge.el.querySelectorAll('.gm .gt').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === g.method)));
}
function niceStep(range, px, target = 70) {
  const raw = range / Math.max(1, px / target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
function fmtTick(v, step) { const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)); return (Math.abs(v) < step / 2 ? 0 : v).toFixed(Math.min(6, d)).replace('-', '−'); }
function drawGraph(id) {
  const g = graphById(id); if (!g) return;
  const ge = ensureGraphEl(g);
  updateGraphBar(g);
  const cv = ge.canvas;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = Math.min(3, (window.devicePixelRatio || 1) * Math.max(1, view.s));
  const cw = Math.round(W * dpr), ch = Math.round(H * dpr);
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  if (!g.view) g.view = defaultView(g, W, H);
  if (!g.show) g.show = {};
  if (graphIs3D(g)) { renderFits(g, ge); drawGraph3D(g, ge, c, W, H); return; }
  const v = g.view;
  const X = x => (x - v.x0) / (v.x1 - v.x0) * W, Y = y => (v.y1 - y) / (v.y1 - v.y0) * H;
  const IX = px => v.x0 + px / W * (v.x1 - v.x0), IY = py => v.y1 - py / H * (v.y1 - v.y0);
  const lines = g.lineIds.map(lineById).filter(liveLine);
  const kinds = lines.map(l => anOf(l).kind);
  const polarOnly = kinds.length && kinds.every(k => k === 'polar');
  // surfaces first (fill)
  for (const l of lines) if (anOf(l).kind === 'surface') drawSurface(c, anOf(l), W, H, IX, IY, GCOL[(l.colorIdx || 0) % GCOL.length]);
  drawAxes2D(c, v, W, H, polarOnly);
  for (const l of lines) { const al = sketchAlpha(l); if (!al) continue;
    c.save(); c.strokeStyle = `rgba(22, 28, 26, ${(0.26 * al).toFixed(3)})`; c.lineWidth = 2.2; c.lineJoin = 'round'; c.lineCap = 'round';
    for (const st of l.sketch) { c.beginPath(); st.forEach(([x, y], i) => i ? c.lineTo(X(x), Y(y)) : c.moveTo(X(x), Y(y))); c.stroke(); }
    c.restore();
  }
  if (!lines.length && g.drawOn && !(ge.pending.length || ge.sk)) {
    c.save(); c.textAlign = 'center'; c.fillStyle = '#7d8884'; c.font = '600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    c.fillText('Draw a curve here', W / 2, H / 2 - 30); c.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    c.fillText('It becomes the closest elementary function', W / 2, H / 2 - 10); c.restore();
  }
  renderFits(g, ge);
  const legend = [];
  const prim = primaryFn(g);
  const pan = prim ? anOf(prim) : null;
  const f = pan ? (x => pan.c.f(scope, x)) : null;
  const pcol = prim ? GCOL[(prim.colorIdx || 0) % GCOL.length] : '#000';
  // area / riemann under curve
  if (f && (g.show.area || g.show.riem)) {
    const a = Math.min(g.a, g.b), b = Math.max(g.a, g.b);
    if (g.show.area) {
      const n = Math.max(2, Math.ceil(Math.abs(X(b) - X(a))));
      c.beginPath(); c.moveTo(X(a), Y(0));
      for (let i = 0; i <= n; i++) { const x = a + (b - a) * i / n; const y = f(x); c.lineTo(X(x), Y(isFinite(y) ? clamp(y, v.y0 - 1e3, v.y1 + 1e3) : 0)); }
      c.lineTo(X(b), Y(0)); c.closePath();
      c.fillStyle = hexA(pcol, 0.18); c.fill();
      const I = ME.simpson(f, a, b, 600);
      legend.push(`<span style="color:${pcol}">∫<sub>${fmt2(a)}</sub><sup>${fmt2(b)}</sup> f(x) dx = <b>${ME.fmt(r4(I))}</b></span>`);
    }
    if (g.show.riem) {
      const n = g.n, dx = (b - a) / n; let sum = 0;
      c.strokeStyle = hexA(pcol, 0.85); c.lineWidth = 1; c.fillStyle = hexA(pcol, 0.1);
      for (let i = 0; i < n; i++) {
        const xl = a + i * dx, xs = g.method === 'left' ? xl : g.method === 'right' ? xl + dx : xl + dx / 2;
        const y = f(xs); if (!isFinite(y)) continue; sum += y * dx;
        const top = Y(clamp(y, v.y0 - 1e3, v.y1 + 1e3));
        c.fillRect(X(xl), Math.min(top, Y(0)), X(xl + dx) - X(xl), Math.abs(Y(0) - top));
        c.strokeRect(X(xl) + .5, Math.min(top, Y(0)) + .5, X(xl + dx) - X(xl), Math.abs(Y(0) - top));
      }
      legend.push(`<span>${{ left: 'Left', mid: 'Midpoint', right: 'Right' }[g.method]} sum, n = ${n}: <b>${ME.fmt(r4(sum))}</b></span>`);
    }
    for (const [k, xv] of [['a', g.a], ['b', g.b]]) drawBoundHandle(c, X(xv), clamp(Y(0), 8, H - 8), k);
  }
  // curves
  for (const l of lines) {
    const an = anOf(l), col = GCOL[(l.colorIdx || 0) % GCOL.length];
    c.strokeStyle = col; c.lineWidth = 2.4; c.lineJoin = 'round'; c.lineCap = 'round';
    if (an.kind === 'function') plotFn(c, x => an.c.f(scope, x), W, H, X, Y, IX);
    else if (an.kind === 'polar' || an.kind === 'parametric') {
      const ptsC = sampleCurve(l, 1400);
      c.beginPath(); let pen = false;
      for (const [x, y] of ptsC) { if (!isFinite(x) || !isFinite(y)) { pen = false; continue; } const px = X(x), py = Y(y); if (pen) c.lineTo(px, py); else { c.moveTo(px, py); pen = true; } }
      c.stroke();
    } else if (an.kind === 'implicit') marching(c, (x, y) => an.c.g(scope, x, y), W, H, IX, IY, 3, [0], col);
  }
  // derivative
  if (f && g.show.d && pan.c.df) {
    c.save(); c.setLineDash([7, 5]); c.strokeStyle = hexA(pcol, 0.8); c.lineWidth = 2;
    plotFn(c, x => pan.c.df(scope, x), W, H, X, Y, IX); c.restore();
    legend.push(`<span style="color:${pcol}">f′(x) = ${ME.pp(pan.df)}</span>`);
  }
  // antiderivative
  if (f && g.show.anti) {
    const N = Math.ceil(W);
    const xs = [], Fv = [];
    // integrate from 0 outward
    const step = (v.x1 - v.x0) / N;
    const F0 = x => ME.simpson(f, 0, x, 200);
    let start = IX(0), acc = F0(start);
    for (let i = 0; i <= N; i++) { const x = IX(i); if (i > 0) acc += ME.simpson(f, x - step, x, 4); xs.push(x); Fv.push(acc + g.C); }
    c.save(); c.setLineDash([2, 4]); c.strokeStyle = '#7a3fd1'; c.lineWidth = 2.2;
    c.beginPath(); let pen = false;
    for (let i = 0; i <= N; i++) { const y = Fv[i]; if (!isFinite(y)) { pen = false; continue; } const py = Y(y); if (pen) c.lineTo(i, py); else { c.moveTo(i, py); pen = true; } }
    c.stroke(); c.restore();
    drawDot(c, X(0), Y(g.C), '#7a3fd1', true);
    legend.push(`<span style="color:#7a3fd1">F(x) = ∫<sub>0</sub><sup>x</sup> f(t) dt + C, C = ${ME.fmt(r2(g.C))}</span>`);
  }
  // tangent
  if (f && g.show.tan) {
    const x0 = g.x0, y0 = f(x0);
    const m = pan.c.df ? pan.c.df(scope, x0) : (f(x0 + 1e-5) - f(x0 - 1e-5)) / 2e-5;
    if (isFinite(y0) && isFinite(m)) {
      c.strokeStyle = '#1b2230'; c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(0, Y(y0 + m * (IX(0) - x0))); c.lineTo(W, Y(y0 + m * (IX(W) - x0))); c.stroke();
      drawDot(c, X(x0), Y(y0), '#1b2230', true);
      legend.push(`<span>Tangent at x = ${fmt2(x0)}: slope <b>${ME.fmt(r4(m))}</b></span>`);
    }
  }
  // hover trace
  if (f && ge.hover && !g.show.tan) {
    const x = IX(ge.hover[0]), y = f(x);
    if (isFinite(y)) {
      drawDot(c, X(x), Y(y), pcol, false);
      c.fillStyle = '#1b2230'; c.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; c.textAlign = 'left'; c.textBaseline = 'bottom';
      c.fillText(`(${fmt2(x)}, ${fmt2(y)})`, clamp(X(x) + 8, 2, W - 120), clamp(Y(y) - 6, 14, H - 2));
    }
  }
  for (const l of lines) if (anOf(l).kind === 'surface') legend.push(`<span>Level curves of z = ${ME.pp(anOf(l).f)}</span>`);
  if (!lines.length && !g.drawOn) legend.push('<span class="muted">Waiting for the line to be read…</span>');
  const html = legend.join('');
  if (ge.legend.dataset.html !== html) { ge.legend.innerHTML = html; ge.legend.dataset.html = html; }
  ge.legend.hidden = !legend.length;
  ge.legend.classList.toggle('min', !!g.legendMin && legend.length > 1);
}
function drawAxes2D(c, v, W, H, polarOnly, faint) {
  const X = x => (x - v.x0) / (v.x1 - v.x0) * W, Y = y => (v.y1 - y) / (v.y1 - v.y0) * H;
  const sx = niceStep(v.x1 - v.x0, W), sy = niceStep(v.y1 - v.y0, H);
  c.lineWidth = 1;
  if (polarOnly) {
    const rmax = Math.hypot(Math.max(Math.abs(v.x0), Math.abs(v.x1)), Math.max(Math.abs(v.y0), Math.abs(v.y1)));
    const st = Math.max(sx, sy);
    c.strokeStyle = '#e3e9f3';
    for (let r = st; r <= rmax; r += st) { c.beginPath(); c.ellipse(X(0), Y(0), r / (v.x1 - v.x0) * W, r / (v.y1 - v.y0) * H, 0, 0, Math.PI * 2); c.stroke(); }
    for (let k = 0; k < 12; k++) { const a = k * Math.PI / 6; c.beginPath(); c.moveTo(X(0), Y(0)); c.lineTo(X(rmax * Math.cos(a)), Y(rmax * Math.sin(a))); c.stroke(); }
  } else if (!faint) {
    c.strokeStyle = '#edf1f7';
    for (let x = Math.ceil(v.x0 / sx) * sx; x <= v.x1; x += sx) { c.beginPath(); c.moveTo(Math.round(X(x)) + .5, 0); c.lineTo(Math.round(X(x)) + .5, H); c.stroke(); }
    for (let y = Math.ceil(v.y0 / sy) * sy; y <= v.y1; y += sy) { c.beginPath(); c.moveTo(0, Math.round(Y(y)) + .5); c.lineTo(W, Math.round(Y(y)) + .5); c.stroke(); }
  }
  c.strokeStyle = faint ? 'rgba(60,70,90,.55)' : '#7b8494'; c.lineWidth = 1.2;
  const ax = clamp(X(0), 0, W), ay = clamp(Y(0), 0, H);
  c.beginPath(); c.moveTo(0, ay); c.lineTo(W, ay); c.moveTo(ax, 0); c.lineTo(ax, H); c.stroke();
  c.fillStyle = '#5b6474'; c.font = '10.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  c.textAlign = 'center'; c.textBaseline = 'top';
  for (let x = Math.ceil(v.x0 / sx) * sx; x <= v.x1; x += sx) { if (Math.abs(x) < sx / 2) continue; const px = X(x); if (px < 12 || px > W - 12) continue; c.fillText(fmtTick(x, sx), px, clamp(ay + 4, 2, H - 14)); }
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let y = Math.ceil(v.y0 / sy) * sy; y <= v.y1; y += sy) { if (Math.abs(y) < sy / 2) continue; const py = Y(y); if (py < 10 || py > H - 10) continue; c.fillText(fmtTick(y, sy), clamp(ax - 5, 30, W - 2), py); }
}
const r4 = v => Math.round(v * 1e4) / 1e4;
const fmt2 = v => ME.fmt(Math.round(v * 100) / 100);
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
function drawDot(c, x, y, col, big) { c.beginPath(); c.arc(x, y, big ? 7 : 4.5, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.lineWidth = 2.4; c.strokeStyle = col; c.stroke(); if (big) { c.beginPath(); c.arc(x, y, 2.6, 0, Math.PI * 2); c.fillStyle = col; c.fill(); } }
function drawBoundHandle(c, x, y, label) {
  c.fillStyle = '#1b2230'; c.beginPath(); c.moveTo(x, y); c.lineTo(x - 7, y + 12); c.lineTo(x + 7, y + 12); c.closePath(); c.fill();
  c.strokeStyle = 'rgba(27,34,48,.5)'; c.setLineDash([3, 3]); c.lineWidth = 1; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, c.canvas.clientHeight); c.stroke(); c.setLineDash([]);
  c.font = 'italic 12px system-ui, -apple-system, "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'top'; c.fillStyle = '#1b2230'; c.fillText(label, x, Math.min(y + 14, c.canvas.clientHeight - 14));
}
function hitHandle(g, ge, px, py) {
  const cv = ge.canvas, W = cv.clientWidth, H = cv.clientHeight, v = g.view;
  const X = x => (x - v.x0) / (v.x1 - v.x0) * W, Y = y => (v.y1 - y) / (v.y1 - v.y0) * H;
  if (graphIs3D(g)) {
    if (!primarySurface(g) || !['level', 'heat', 'grad'].includes(g.mode)) return null;
    calcDefaults(g);
    if (g.show.dir) { const t = dirTip(g, W, H); if (Math.hypot(px - t[0], py - t[1]) < 16) return 'U'; }
    if (g.show.vol || g.show.box) { if (Math.hypot(px - X(g.R.a), py - Y(g.R.c)) < 16) return 'RA'; if (Math.hypot(px - X(g.R.b), py - Y(g.R.d)) < 16) return 'RB'; }
    if ((g.show.tp || g.show.dir) && Math.hypot(px - X(g.px), py - Y(g.py)) < 16) return 'P';
    return null;
  }
  const f0 = primaryFn(g); if (!f0) return null;
  const an = anOf(f0), f = x => an.c.f(scope, x);
  const near = (x, y, r = 14) => Math.hypot(px - x, py - y) < r;
  if (g.show.tan) { const y = f(g.x0); if (isFinite(y) && near(X(g.x0), Y(y), 16)) return 'x0'; }
  if (g.show.anti && near(X(0), Y(g.C), 16)) return 'C';
  if (g.show.area || g.show.riem) {
    const hy = clamp(Y(0), 8, H - 8);
    for (const k of ['a', 'b']) if (Math.abs(px - X(g[k])) < 12 && py > hy - 14 && py < hy + 28) return k;
    for (const k of ['a', 'b']) if (Math.abs(px - X(g[k])) < 6) return k;
  }
  return null;
}
function plotFn(c, f, W, H, X, Y, IX) {
  c.beginPath();
  let pen = false, prevPy = 0;
  const N = Math.ceil(W * 1.5);
  for (let i = 0; i <= N; i++) {
    const px = i / 1.5, x = IX(px), y = f(x);
    if (!isFinite(y)) { pen = false; continue; }
    const py = Y(y);
    if (pen && Math.abs(py - prevPy) > H * 1.5) { pen = false; }
    const cy = clamp(py, -H * 2, H * 3);
    if (pen) c.lineTo(px, cy); else { c.moveTo(px, cy); pen = true; }
    prevPy = py;
  }
  c.stroke();
}
function marching(c, F, W, H, IX, IY, cell, levels, col, colors, labels) {
  const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
  const grid = new Float64Array((nx + 1) * (ny + 1));
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) grid[j * (nx + 1) + i] = F(IX(i * cell), IY(j * cell));
  levels.forEach((lv, li) => {
    c.strokeStyle = colors ? colors[li] : col; c.lineWidth = colors ? 1.2 : 2.4;
    c.beginPath();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = grid[j * (nx + 1) + i] - lv, b = grid[j * (nx + 1) + i + 1] - lv, d = grid[(j + 1) * (nx + 1) + i] - lv, e = grid[(j + 1) * (nx + 1) + i + 1] - lv;
      if (![a, b, d, e].every(isFinite)) continue;
      const big = Math.max(Math.abs(a), Math.abs(b), Math.abs(d), Math.abs(e));
      const segs = [];
      const x0 = i * cell, y0 = j * cell;
      const edge = (p, q, ax2, ay2, bx, by) => { const t = p / (p - q); return [ax2 + (bx - ax2) * t, ay2 + (by - ay2) * t]; };
      if ((a < 0) !== (b < 0)) segs.push(edge(a, b, x0, y0, x0 + cell, y0));
      if ((b < 0) !== (e < 0)) segs.push(edge(b, e, x0 + cell, y0, x0 + cell, y0 + cell));
      if ((d < 0) !== (e < 0)) segs.push(edge(d, e, x0, y0 + cell, x0 + cell, y0 + cell));
      if ((a < 0) !== (d < 0)) segs.push(edge(a, d, x0, y0, x0, y0 + cell));
      if (segs.length >= 2 && big < 1e6) {
        c.moveTo(segs[0][0], segs[0][1]); c.lineTo(segs[1][0], segs[1][1]); if (segs.length === 4) { c.moveTo(segs[2][0], segs[2][1]); c.lineTo(segs[3][0], segs[3][1]); }
        if (labels && ((i * 7 + j * 13) % 9 === 0)) { const mx2 = (segs[0][0] + segs[1][0]) / 2, my2 = (segs[0][1] + segs[1][1]) / 2; if (mx2 > 30 && mx2 < W - 30 && my2 > 20 && my2 < H - 20) labels.push([li, mx2, my2]); }
      }
    }
    c.stroke();
  });
}
function drawSurface(c, an, W, H, IX, IY, col) {
  const cell = 4, nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
  const vals = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) vals.push(an.c.f(scope, IX((i + .5) * cell), IY((j + .5) * cell)));
  const fin = vals.filter(isFinite).sort((a, b) => a - b);
  if (!fin.length) return;
  const lo = fin[Math.floor(fin.length * 0.04)], hi = fin[Math.floor(fin.length * 0.96)] || lo + 1;
  const off = document.createElement('canvas'); off.width = nx; off.height = ny;
  const oc = off.getContext('2d'), img = oc.createImageData(nx, ny);
  for (let k = 0; k < vals.length; k++) {
    const t = clamp((vals[k] - lo) / (hi - lo || 1), 0, 1);
    const [r, g, b] = t < 0.5 ? mix([10, 112, 150], [255, 255, 255], t * 2) : mix([255, 255, 255], [236, 140, 18], (t - 0.5) * 2);
    img.data[k * 4] = r; img.data[k * 4 + 1] = g; img.data[k * 4 + 2] = b; img.data[k * 4 + 3] = isFinite(vals[k]) ? 120 : 0;
  }
  oc.putImageData(img, 0, 0);
  c.imageSmoothingEnabled = true; c.drawImage(off, 0, 0, nx * cell, ny * cell);
  const levels = [], cols = [];
  for (let i = 1; i <= 9; i++) { const lv = lo + (hi - lo) * i / 10; levels.push(lv); cols.push(i < 5 ? '#0b5f7d' : i > 5 ? '#a8590a' : '#4a5560'); }
  marching(c, (x, y) => an.c.f(scope, x, y), W, H, IX, IY, 4, levels, col, cols);
}
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

/* ---------- 3D & multivariable graphs ---------- */
const CMAP = [[20, 58, 108], [12, 126, 156], [46, 188, 162], [156, 220, 96], [244, 224, 70]];
function cmap(t) { t = clamp(isFinite(t) ? t : 0.5, 0, 1) * (CMAP.length - 1); const i = Math.min(CMAP.length - 2, Math.floor(t)); return mix(CMAP[i], CMAP[i + 1], t - i); }
const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const hexRGB = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const LIGHT = (() => { const v = [-0.35, -0.55, 0.76]; const n = Math.hypot(...v); return v.map(x => x / n); })();
function scopeKey(lines) { const names = new Set(); lines.forEach(l => (anOf(l).params || []).forEach(p => names.add(p))); return [...names].map(n => n + '=' + scope[n]).join(','); }
function hasTrig(node) { return /"n":"(sin|cos|tan|sec|csc|cot)"/.test(JSON.stringify(node)); }
function tRange3(an) {
  const parts = [an.fx, an.fy, an.fz];
  const outside = parts.some(p => usesOutsideTrig(p, 't')), trig = parts.some(hasTrig);
  return trig && !outside ? [0, 2 * Math.PI] : trig ? [0, 4 * Math.PI] : [-4, 4];
}
function partial(an, v, x, y) {
  const fn = v === 'x' ? an.c.fx : an.c.fy;
  if (fn) { const r = fn(scope, x, y); if (isFinite(r)) return r; }
  const h = 1e-5;
  return v === 'x' ? (an.c.f(scope, x + h, y) - an.c.f(scope, x - h, y)) / (2 * h) : (an.c.f(scope, x, y + h) - an.c.f(scope, x, y - h)) / (2 * h);
}
function faceNormal(a, b, c, d) {
  const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v = [d[0] - b[0], d[1] - b[1], d[2] - b[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const L = Math.hypot(n[0], n[1], n[2]) || 1; return [n[0] / L, n[1] / L, n[2] / L];
}
function marchTetra(F, lo, hi, n, emit) {
  const st = (hi - lo) / n, N1 = n + 1;
  const val = new Float64Array(N1 * N1 * N1);
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) val[i + N1 * (j + N1 * k)] = F(lo + i * st, lo + j * st, lo + k * st);
  const CO = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const TET = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
  const P = new Array(8), V = new Array(8);
  const ip = (a, b) => { const t = V[a] / (V[a] - V[b]); return [P[a][0] + (P[b][0] - P[a][0]) * t, P[a][1] + (P[b][1] - P[a][1]) * t, P[a][2] + (P[b][2] - P[a][2]) * t]; };
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let anyIn = false, anyOut = false, bad = false;
    for (let q = 0; q < 8; q++) {
      const o = CO[q], vv = val[(i + o[0]) + N1 * ((j + o[1]) + N1 * (k + o[2]))];
      if (!isFinite(vv)) bad = true;
      V[q] = vv; P[q] = [lo + (i + o[0]) * st, lo + (j + o[1]) * st, lo + (k + o[2]) * st];
      if (vv < 0) anyIn = true; else anyOut = true;
    }
    if (bad || !anyIn || !anyOut) continue;
    for (const T of TET) {
      const ins = T.filter(q => V[q] < 0), outs = T.filter(q => V[q] >= 0);
      if (!ins.length || ins.length === 4) continue;
      if (ins.length === 1 || ins.length === 3) { const one = ins.length === 1 ? ins[0] : outs[0], o = ins.length === 1 ? outs : ins; emit([ip(one, o[0]), ip(one, o[1]), ip(one, o[2])]); }
      else { const [a, b] = ins, [c, d] = outs; const p1 = ip(a, c), p2 = ip(a, d), p3 = ip(b, d), p4 = ip(b, c); emit([p1, p2, p3]); emit([p1, p3, p4]); }
    }
  }
}
function marchGrid(z, N, levels, cb) {
  const W1 = N + 1;
  levels.forEach((lv, li) => {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = z[j * W1 + i] - lv, b = z[j * W1 + i + 1] - lv, d = z[(j + 1) * W1 + i] - lv, e = z[(j + 1) * W1 + i + 1] - lv;
      if (!(isFinite(a) && isFinite(b) && isFinite(d) && isFinite(e))) continue;
      const sg = [];
      if ((a < 0) !== (b < 0)) sg.push([i + a / (a - b), j]);
      if ((b < 0) !== (e < 0)) sg.push([i + 1, j + b / (b - e)]);
      if ((d < 0) !== (e < 0)) sg.push([i + d / (d - e), j + 1]);
      if ((a < 0) !== (d < 0)) sg.push([i, j + a / (a - d)]);
      if (sg.length >= 2) { cb(sg[0], sg[1], li); if (sg.length === 4) cb(sg[2], sg[3], li); }
    }
  });
}
function build3D(g, lines, mode) {
  const v = g.view;
  const items = lines.map(l => ({ l, an: anOf(l), col: hexRGB(GCOL[(l.colorIdx || 0) % GCOL.length]) }));
  const surfs = items.filter(i => i.an.kind === 'surface'), curves = items.filter(i => i.an.kind === 'curve3d'), imps = items.filter(i => i.an.kind === 'implicit3d'), solids = items.filter(i => i.an.kind === 'solid');
  let x0 = v.x0, x1 = v.x1, y0 = v.y0, y1 = v.y1, lo = Infinity, hi = -Infinity;
  const solidsOnly = solids.length && !surfs.length && !imps.length && !curves.length, blank = !items.length;
  for (const it of solids) { it.v = solidVals(it.an); it.ext = solidExt(it.an.solid, it.v); }
  for (const it of curves) {
    const an = it.an, [t0, t1] = tRange3(an), n = 800; it.pts = [];
    for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * i / n; it.pts.push([an.c.fx(scope, 0, 0, t, t), an.c.fy(scope, 0, 0, t, t), an.c.fz(scope, 0, 0, t, t)]); }
  }
  if (!surfs.length && !imps.length && curves.length) {
    let ex = 0;
    for (const it of curves) for (const p of it.pts) if (p.every(isFinite)) ex = Math.max(ex, Math.abs(p[0]), Math.abs(p[1]));
    ex = (ex || 1) * 1.15; x0 = y0 = -ex; x1 = y1 = ex;
  }
  if (imps.length || blank) { const R = Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)); x0 = y0 = -R; x1 = y1 = R; lo = -R; hi = R; }
  if (solidsOnly) {   // the box fits the solids, same scale on every axis
    let E = 0, z0 = Infinity, z1 = -Infinity, xa = Infinity, xb = -Infinity, ya = Infinity, yb = -Infinity;
    for (const it of solids) {
      const e = it.ext; E = Math.max(E, e.ex, e.ey); z0 = Math.min(z0, e.z0); z1 = Math.max(z1, e.z1);
      xa = Math.min(xa, e.x0 != null ? e.x0 : -e.ex); xb = Math.max(xb, e.x1 != null ? e.x1 : e.ex); ya = Math.min(ya, e.y0 != null ? e.y0 : -e.ey); yb = Math.max(yb, e.y1 != null ? e.y1 : e.ey);
    }
    const hzS = (z1 - z0) / 2, m = 0.2 * Math.max(E, hzS);
    if (Math.abs(xa + xb) < 1e-9 && Math.abs(ya + yb) < 1e-9) { const Hxy = Math.max(E * 1.4, hzS * 0.9, 0.5); x0 = y0 = -Hxy; x1 = y1 = Hxy; }
    else {   // off-centre (a plane in the first octant): a square floor around it and the origin
      const pad = 0.22 * Math.max(xb - xa, yb - ya, z1 - z0); x0 = Math.min(xa, 0) - pad; y0 = Math.min(ya, 0) - pad; x1 = Math.max(xb, 0) + pad; y1 = Math.max(yb, 0) + pad;
      const L = Math.max(x1 - x0, y1 - y0); x1 = x0 + L; y1 = y0 + L;
    }
    lo = z0 >= 0 ? 0 : z0 - m; hi = z1 + m;   // solids on the xy-plane stand on the floor
  } else for (const it of solids) { lo = Math.min(lo, it.ext.z0); hi = Math.max(hi, it.ext.z1); }
  const N = mode === 'wire' ? 30 : 40;
  for (const it of surfs) {
    const z = new Float64Array((N + 1) * (N + 1));
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) z[j * (N + 1) + i] = it.an.c.f(scope, x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N);
    it.z = z;
  }
  const ps0 = surfs[0], extra = [];
  if (ps0) {
    calcDefaults(g);
    const dfn = (v) => (x, y) => partial(ps0.an, v, x, y);
    for (const [k, v, col] of [['dx', 'x', [124, 92, 255]], ['dy', 'y', [229, 72, 77]]]) {
      if (!g.show[k]) continue;
      const fn = dfn(v), z = new Float64Array((N + 1) * (N + 1));
      for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) z[j * (N + 1) + i] = fn(x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N);
      extra.push({ z, col });
    }
  }
  if (surfs.length) {
    const all = []; surfs.forEach(it => it.z.forEach(q => { if (isFinite(q)) all.push(q); })); extra.forEach(it => it.z.forEach(q => { if (isFinite(q)) all.push(q); })); all.sort((a, b) => a - b);

    if (all.length) {
      const p2 = all[Math.floor(all.length * 0.02)], p98 = all[Math.min(all.length - 1, Math.floor(all.length * 0.98))], mn = all[0], mx = all[all.length - 1];
      const spiky = (mx - mn) > 3 * Math.max(1e-9, p98 - p2);
      lo = Math.min(lo, spiky ? p2 : mn); hi = Math.max(hi, spiky ? p98 : mx);
    }
  }
  for (const it of curves) for (const p of it.pts) if (isFinite(p[2])) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
  if (ps0 && (g.show.vol || g.show.box) && isFinite(lo) && isFinite(hi)) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  // on a graph made for drawing, the box stays at least a cube, so there's room to draw the next trace
  if (g.is3d && !solidsOnly) { const R = Math.max(x1 - x0, y1 - y0) / 2; lo = Math.min(isFinite(lo) ? lo : -R, -R); hi = Math.max(isFinite(hi) ? hi : R, R); }
  if (!isFinite(lo) || !isFinite(hi)) { lo = -1; hi = 1; }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const equal = !surfs.length && (imps.length || solidsOnly || blank);
  if (!imps.length && !solidsOnly && !blank) { const pad = (hi - lo) * 0.03; lo -= pad; hi += pad; }
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (hi - lo) / 2, xc = (x0 + x1) / 2, yc = (y0 + y1) / 2, zc = (lo + hi) / 2;
  const bx = 1, by = hy / hx, bz = surfs.length ? 0.78 * Math.max(bx, by) : equal ? hz / hx : Math.min(1.1, Math.max(0.3, hz / hx));
  const NZ = z => clamp((z - zc) / hz * bz, -bz, bz);
  const N3 = (x, y, z) => [(x - xc) / hx * bx, (y - yc) / hy * by, NZ(z)];
  const geo = { x0, x1, y0, y1, lo, hi, bx, by, bz, NZ, N3, xc, yc, zc, hx, hy, hz, sc: [bx / hx, by / hy, bz / hz], faces: [], wires: [], floor: [], curves: [], marker: null,
    segs: [], domains: [] };
  const single = surfs.length + imps.length === 1;
  for (const it of surfs) {
    const P = (i, j) => { const q = it.z[j * (N + 1) + i]; return isFinite(q) ? N3(x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N, q) : null; };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = P(i, j), b = P(i + 1, j), c2 = P(i + 1, j + 1), d = P(i, j + 1);
      if (!a || !b || !c2 || !d) continue;
      const zavg = (it.z[j * (N + 1) + i] + it.z[j * (N + 1) + i + 1] + it.z[(j + 1) * (N + 1) + i + 1] + it.z[(j + 1) * (N + 1) + i]) / 4;
      const col = single ? cmap((zavg - lo) / (hi - lo)) : it.col;
      if (mode === 'wire') { geo.wires.push([a, b, col], [a, d, col]); if (i === N - 1) geo.wires.push([b, c2, col]); if (j === N - 1) geo.wires.push([d, c2, col]); }
      else geo.faces.push({ p: [a, b, c2, d], col, n: faceNormal(a, b, c2, d), alpha: it === ps0 && g.show.box ? 0.42 : undefined, main: true, lid: it.l.id });
    }
  }
  for (const it of solids) solidMesh(geo, it, lo);
  // a surface built from drawn traces shows them: z = f(x, 0) in red, z = f(0, y) in blue
  for (const it of surfs) if (it.l.traces) {
    const f = (x, y) => it.an.c.f(scope, x, y), m = 90, ok = z => isFinite(z) && z >= lo && z <= hi;
    if (it.l.traces.x) { const pts = []; for (let i = 0; i <= m; i++) { const x = x0 + (x1 - x0) * i / m, z = f(x, 0); pts.push(ok(z) ? N3(x, 0, z) : null); } geo.curves.push({ pts, col: [214, 64, 69], w: 2.4 }); }
    if (it.l.traces.y) { const pts = []; for (let i = 0; i <= m; i++) { const y = y0 + (y1 - y0) * i / m, z = f(0, y); pts.push(ok(z) ? N3(0, y, z) : null); } geo.curves.push({ pts, col: [43, 111, 224], w: 2.4 }); }
  }
  for (const it of extra) {
    const P = (i, j) => { const q = it.z[j * (N + 1) + i]; return isFinite(q) ? N3(x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N, q) : null; };
    const st = mode === 'wire' ? 1 : 2;
    for (let j = 0; j < N; j += st) for (let i = 0; i < N; i += st) {
      const i2 = Math.min(N, i + st), j2 = Math.min(N, j + st);
      const a = P(i, j), b = P(i2, j), c2 = P(i2, j2), d = P(i, j2);
      if (!a || !b || !c2 || !d) continue;
      if (mode === 'wire') { geo.wires.push([a, b, it.col], [a, d, it.col]); }
      else geo.faces.push({ p: [a, b, c2, d], col: it.col, n: faceNormal(a, b, c2, d), alpha: 0.5, tint: it.col });
    }
  }
  geo.lines3 = [];
  if (ps0 && (g.show.vol || g.show.box)) {
    const f = (x, y) => ps0.an.c.f(scope, x, y), R = normR(g.R), z0n = clamp(0, lo, hi);
    const TEAL = [8, 127, 140];
    if (g.show.vol) {
      const m = 24, edge = [];
      const pts = [];
      for (let k = 0; k <= m; k++) pts.push([R.a + (R.b - R.a) * k / m, R.c]);
      for (let k = 1; k <= m; k++) pts.push([R.b, R.c + (R.d - R.c) * k / m]);
      for (let k = 1; k <= m; k++) pts.push([R.b - (R.b - R.a) * k / m, R.d]);
      for (let k = 1; k <= m; k++) pts.push([R.a, R.d - (R.d - R.c) * k / m]);
      for (let k = 0; k < pts.length - 1; k++) {
        const [xa, ya] = pts[k], [xb, yb] = pts[k + 1], fa = f(xa, ya), fb = f(xb, yb);
        if (!isFinite(fa) || !isFinite(fb)) continue;
        const A = N3(xa, ya, z0n), B = N3(xb, yb, z0n), C2 = N3(xb, yb, fb), D2 = N3(xa, ya, fa);
        geo.faces.push({ p: [A, B, C2, D2], col: TEAL, n: faceNormal(A, B, C2, D2), alpha: 0.34, tint: TEAL });
        edge.push(D2);
      }
      edge.push(edge[0]);
      geo.lines3.push({ pts: edge, col: TEAL, w: 2.6 });
      const base = [N3(R.a, R.c, z0n), N3(R.b, R.c, z0n), N3(R.b, R.d, z0n), N3(R.a, R.d, z0n)];
      geo.faces.push({ p: base, col: TEAL, n: [0, 0, 1], alpha: 0.18, tint: TEAL });
      const mm = 10;
      for (let j = 0; j < mm; j++) for (let i = 0; i < mm; i++) {
        const xa = R.a + (R.b - R.a) * i / mm, xb = R.a + (R.b - R.a) * (i + 1) / mm, ya = R.c + (R.d - R.c) * j / mm, yb = R.c + (R.d - R.c) * (j + 1) / mm;
        const q = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]].map(([x, y]) => N3(x, y, f(x, y)));
        if (q.some(v => !v.every(isFinite))) continue;
        geo.faces.push({ p: q, col: [46, 188, 162], n: faceNormal(...q), alpha: 0.55, tint: TEAL });
      }
    }
    if (g.show.box) {
      const n = g.nb, dx = (R.b - R.a) / n, dy = (R.d - R.c) / n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const xa = R.a + i * dx, xb = xa + dx, ya = R.c + j * dy, yb = ya + dy, h = f(xa + dx / 2, ya + dy / 2);
        if (!isFinite(h)) continue;
        const b0 = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]].map(([x, y]) => N3(x, y, z0n)), t0 = [[xa, ya], [xb, ya], [xb, yb], [xa, yb]].map(([x, y]) => N3(x, y, h));
        const col = cmap((h - lo) / (hi - lo || 1));
        geo.faces.push({ p: t0, col, n: [0, 0, 1], alpha: 0.92, box: true });
        for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4, q = [b0[k], b0[k2], t0[k2], t0[k]]; geo.faces.push({ p: q, col: col.map(v => v * 0.86), n: faceNormal(...q), alpha: 0.92, box: true }); }
      }
    }
  }
  if (ps0 && g.show.dir) {
    const an = ps0.an, px = g.px, py = g.py, z0 = an.c.f(scope, px, py), ux = Math.cos(g.dirA), uy = Math.sin(g.dirA);
    const Du = partial(an, 'x', px, py) * ux + partial(an, 'y', px, py) * uy;
    if (isFinite(z0) && isFinite(Du)) {
      const s3 = 0.55 * hx, pts = [];
      for (let k = -12; k <= 12; k++) { const t = s3 * k / 12; pts.push(N3(px + t * ux, py + t * uy, z0 + t * Du)); }
      geo.lines3.push({ pts, col: [229, 72, 77], w: 3.2 });
      geo.dirFloor = [N3(px, py, lo), N3(px + 0.45 * hx * ux, py + 0.45 * hx * uy, lo)].map(q => [q[0], q[1], -bz]);
    }
  }
  for (const it of imps) {
    const G = (x, y, z) => it.an.c.g(scope, x, y, 0, 0, z), e = hx * 1e-3;
    marchTetra(G, -hx, hx, 26, tri => {
      const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2], vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
      if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < hx * hx * 1e-7) return;
      const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3, cz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
      let n = [G(cx + e, cy, cz) - G(cx - e, cy, cz), G(cx, cy + e, cz) - G(cx, cy - e, cz), G(cx, cy, cz + e) - G(cx, cy, cz - e)];
      const L = Math.hypot(n[0], n[1], n[2]); n = L > 0 && isFinite(L) ? n.map(q => q / L) : [0, 0, 1];
      const p = tri.map(q => N3(q[0], q[1], q[2]));
      geo.faces.push({ p, col: single ? cmap((cz - lo) / (hi - lo)) : it.col, n, tri: true });
    });
  }
  for (const it of curves) geo.curves.push({ col: it.col, pts: it.pts.map(p => p.every(isFinite) ? N3(p[0], p[1], p[2]) : null) });
  const ps = surfs[0];
  if (ps && g.show.floor) {
    const levels = []; for (let k = 1; k <= 9; k++) levels.push(lo + (hi - lo) * k / 10);
    marchGrid(ps.z, N, levels, (a, b, li) => {
      const A = N3(x0 + (x1 - x0) * a[0] / N, y0 + (y1 - y0) * a[1] / N, lo), B = N3(x0 + (x1 - x0) * b[0] / N, y0 + (y1 - y0) * b[1] / N, lo);
      A[2] = B[2] = -bz; geo.floor.push([A, B, cmap((li + 1) / 10)]);
    });
  }
  if (ps && (g.show.tp || g.show.dir)) {
    const an = ps.an, px = g.px, py = g.py, z0 = an.c.f(scope, px, py), fx = partial(an, 'x', px, py), fy = partial(an, 'y', px, py);
    if (isFinite(z0)) {
      geo.marker = N3(px, py, z0); geo.markerFloor = [geo.marker[0], geo.marker[1], -bz];
      if (isFinite(fx) && isFinite(fy) && g.show.tp) {
        const s2 = 0.42 * hx, m = 6;
        const Q = (a, b) => { const x = px - s2 + 2 * s2 * a / m, y = py - s2 + 2 * s2 * b / m; return N3(x, y, z0 + fx * (x - px) + fy * (y - py)); };
        for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) { const a = Q(i, j), b = Q(i + 1, j), c2 = Q(i + 1, j + 1), d = Q(i, j + 1); geo.faces.push({ p: [a, b, c2, d], col: [122, 63, 209], alpha: 0.4, n: faceNormal(a, b, c2, d) }); }
      }
    }
  }
  return geo;
}
/* a drawn solid on the graph: the graph of f (top) and of g (bottom) over D, with grid lines along
   x and y on both, the edge of D lifted to each graph, D shaded on the floor, and (cylinder, box)
   faint walls between them */
function solidMesh(geo, it, lo) {
  const S = solidFuncs(it.an.solid, it.v); if (!S) return;
  const { N3 } = geo, lid = it.l.id, cT = it.col, cB = SOLID_BOTTOM(it.col), ink = it.col.map(x => x * 0.45), D = S.D, PI2 = 2 * Math.PI;
  const face = (pts, col) => geo.faces.push({ p: pts, col, n: faceNormal(pts[0], pts[1 % pts.length], pts[2 % pts.length], pts[3 % pts.length]), lid, smooth: true });
  const graphs = [[S.top, cT]].concat(S.bot ? [[S.bot, cB]] : []);
  // each graph over D: rings for a disk (denser toward the rim) or a ring-shaped D (denser toward the hole), a grid for a rectangle, a triangle grid
  for (const [F, col] of graphs) {
    const at = (x, y) => N3(x, y, F.f(x, y));
    if (D.kind === 'disk' || D.kind === 'annulus') {
      const NR = 14, NT = 60, rr = i => D.kind === 'disk' ? D.r * Math.sin(Math.PI / 2 * i / NR) : D.r0 + (D.r1 - D.r0) * (i / NR) ** 2;
      const P = (i, j) => { const r = rr(i), t = PI2 * j / NT; return at(r * Math.cos(t), r * Math.sin(t)); };
      for (let j = 0; j < NT; j++) for (let i = 0; i < NR; i++) face(i === 0 && D.kind === 'disk' ? [at(0, 0), P(1, j), P(1, j + 1)] : [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)], col);
    } else if (D.kind === 'rect') {
      const N = it.an.solid === 'saddle' ? 18 : 10, P = (i, j) => at(-D.a / 2 + D.a * i / N, -D.b / 2 + D.b * j / N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) face([P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)], col);
    } else {
      const N = 12, P = (i, j) => at(D.a * i / N, D.b * j / N);
      for (let j = 0; j < N; j++) for (let i = 0; i + j < N; i++) { face([P(i, j), P(i + 1, j), P(i, j + 1)], col); if (i + j + 1 < N) face([P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)], col); }
    }
  }
  // the edge of D (one or two loops), lifted to each graph
  const circle = r => { const o = []; for (let k = 0; k <= 96; k++) { const t = PI2 * k / 96; o.push([r * Math.cos(t), r * Math.sin(t)]); } return o; };
  const poly = P => { const o = []; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; for (let k = 0; k < 12; k++) o.push([p[0] + (q[0] - p[0]) * k / 12, p[1] + (q[1] - p[1]) * k / 12]); } o.push(o[0]); return o; };
  const loops = D.kind === 'disk' ? [circle(D.r)] : D.kind === 'annulus' ? [circle(D.r1), circle(D.r0)]
    : D.kind === 'rect' ? [poly([[-D.a / 2, -D.b / 2], [D.a / 2, -D.b / 2], [D.a / 2, D.b / 2], [-D.a / 2, D.b / 2]])] : [poly([[0, 0], [D.a, 0], [0, D.b]])];
  const seg = (pts, al, w) => { for (let k = 0; k + 1 < pts.length; k++) geo.segs.push({ a: pts[k], b: pts[k + 1], col: ink, al, w }); };
  for (const [F] of graphs) for (const L of loops) seg(L.map(([x, y]) => N3(x, y, F.f(x, y))), 0.85, 1.4);
  // grid lines x = const and y = const on each graph: these are what make it read as z = f(x, y)
  const chords = (ax, u) => {   // the pieces of the line (x = u or y = u) inside D, as [from, to] in the other variable
    if (D.kind === 'disk') return Math.abs(u) < D.r * 0.999 ? [[-Math.sqrt(D.r ** 2 - u * u), Math.sqrt(D.r ** 2 - u * u)]] : [];
    if (D.kind === 'annulus') { if (Math.abs(u) >= D.r1 * 0.999) return []; const h1 = Math.sqrt(D.r1 ** 2 - u * u); if (Math.abs(u) >= D.r0) return [[-h1, h1]]; const h0 = Math.sqrt(D.r0 ** 2 - u * u); return [[-h1, -h0], [h0, h1]]; }
    if (D.kind === 'rect') { const [U, V] = ax === 'x' ? [D.a / 2, D.b / 2] : [D.b / 2, D.a / 2]; return Math.abs(u) < U * 0.999 ? [[-V, V]] : []; }
    const [U, V] = ax === 'x' ? [D.a, D.b] : [D.b, D.a]; return u > 1e-9 && u < U * 0.999 ? [[0, V * (1 - u / U)]] : [];
  };
  const ext = D.kind === 'disk' ? D.r : D.kind === 'annulus' ? D.r1 : D.kind === 'rect' ? Math.max(D.a, D.b) / 2 : Math.max(D.a, D.b) / 2, st = niceStep(2 * ext, 7 * 70);
  const u0 = D.kind === 'tri' ? 0 : -ext, u1 = D.kind === 'tri' ? 2 * ext : ext;
  for (const ax of ['x', 'y']) for (let u = Math.ceil(u0 / st) * st; u <= u1 + 1e-9; u += st) for (const [w0, w1] of chords(ax, u)) for (const [F] of graphs) {
    const pts = []; for (let k = 0; k <= 28; k++) { const w = w0 + (w1 - w0) * k / 28, x = ax === 'x' ? u : w, y = ax === 'x' ? w : u; pts.push(N3(x, y, F.f(x, y))); }
    seg(pts, 0.32, 0.8);
  }
  // walls where the side isn't a graph (cylinder, box, the tetrahedron's back faces): faint, between the two graphs
  if (S.walls && S.bot) {
    for (const L of loops) for (let k = 0; k + 1 < L.length; k++) {
      const [x0, y0] = L[k], [x1, y1] = L[k + 1];
      const q = [N3(x0, y0, S.bot.f(x0, y0)), N3(x1, y1, S.bot.f(x1, y1)), N3(x1, y1, S.top.f(x1, y1)), N3(x0, y0, S.top.f(x0, y0))];
      if (Math.abs(q[3][2] - q[0][2]) + Math.abs(q[2][2] - q[1][2]) < 1e-9) continue;
      geo.faces.push({ p: q, col: [168, 178, 188], n: faceNormal(q[0], q[1], q[2], q[3]), lid, alpha: 0.2, wall: true });
    }
    const corners = D.kind === 'rect' ? [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => [sx * D.a / 2, sy * D.b / 2]) : D.kind === 'tri' ? [[0, 0]] : [];
    for (const [x, y] of corners) seg([N3(x, y, S.bot.f(x, y)), N3(x, y, S.top.f(x, y))], 0.6, 1);
  }
  // D, the region of the xy-plane under it, on the floor
  geo.domains.push({ loops: loops.map(L => L.map(([x, y]) => { const q = N3(x, y, lo); q[2] = -geo.bz; return q; })), col: it.col, txt: `D: ${D.txt}` });
}
function drawTraceGuides(c, geo, T, planes) {   // the planes y = 0 and x = 0, where traces are drawn (just the axes once both are in)
  const { N3, x0, x1, y0, y1, lo, hi } = geo;
  for (const [ax, col] of [['x', [214, 64, 69]], ['y', [43, 111, 224]]]) {
    const q = (ax === 'x' ? [[x0, 0, lo], [x1, 0, lo], [x1, 0, hi], [x0, 0, hi]] : [[0, y0, lo], [0, y1, lo], [0, y1, hi], [0, y0, hi]]).map(p => T(N3(p[0], p[1], p[2])));
    arrow(c, q[0][0], q[0][1], q[1][0], q[1][1], rgb(col, 0.9), 1.8);
    if (!planes) continue;
    c.beginPath(); q.forEach((t, i) => i ? c.lineTo(t[0], t[1]) : c.moveTo(t[0], t[1])); c.closePath();
    c.fillStyle = rgb(col, 0.045); c.fill();
    c.save(); c.setLineDash([5, 4]); c.strokeStyle = rgb(col, 0.38); c.lineWidth = 1; c.stroke(); c.restore();
    c.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif'; c.fillStyle = rgb(col); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(`z along ${ax}`, (q[2][0] + q[3][0] * 0.25) / 1.25, (q[2][1] + q[3][1] * 0.25) / 1.25 - 10);
  }
}
function render3D(g, geo, c, W, H) {
  const cam = camOf(g);
  const cyw = Math.cos(cam.yaw), syw = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const Sc = Math.min(W, H) * 0.44 / Math.hypot(geo.bx, geo.by, geo.bz) * cam.zoom, D = 5.5, oy = H * 0.02;
  const T = p => { const xr = p[0] * cyw - p[1] * syw, yr = p[0] * syw + p[1] * cyw; const up = p[2] * cp + yr * sp, depth = yr * cp - p[2] * sp; const f = D / (D + depth); return [W / 2 + xr * Sc * f, H / 2 + oy - up * Sc * f, depth]; };
  const seg = (a, b) => { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); };
  const { bx, by, bz } = geo;
  const NX = x => (x - (geo.x0 + geo.x1) / 2) / ((geo.x1 - geo.x0) / 2) * bx, NY = y => (y - (geo.y0 + geo.y1) / 2) / ((geo.y1 - geo.y0) / 2) * by;
  // floor
  const fl = [[-bx, -by, -bz], [bx, -by, -bz], [bx, by, -bz], [-bx, by, -bz]].map(T);
  c.beginPath(); fl.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.closePath();
  c.fillStyle = '#f3f6fb'; c.fill(); c.strokeStyle = '#bcc6d4'; c.lineWidth = 1; c.stroke();
  const stx = niceStep(geo.x1 - geo.x0, 320), sty = niceStep(geo.y1 - geo.y0, 320);
  c.strokeStyle = '#e0e6ef';
  for (let x = Math.ceil(geo.x0 / stx) * stx; x <= geo.x1 + 1e-9; x += stx) seg(T([NX(x), -by, -bz]), T([NX(x), by, -bz]));
  for (let y = Math.ceil(geo.y0 / sty) * sty; y <= geo.y1 + 1e-9; y += sty) seg(T([-bx, NY(y), -bz]), T([bx, NY(y), -bz]));
  c.lineWidth = 1.4;
  for (const [A, B, col] of geo.floor) { c.strokeStyle = rgb(col, 0.95); seg(T(A), T(B)); }
  if (g.drawOn && g.draw3 === 'trace') { const tl = traceLine(g); drawTraceGuides(c, geo, T, !(tl && tl.traces.x && tl.traces.y)); }
  (geo.domains || []).forEach((dm, di) => {   // D on the floor (a ring-shaped D has a hole)
    const loops = dm.loops.map(L => L.map(T)), q = loops[0];
    c.beginPath(); for (const L of loops) { L.forEach((t, i) => i ? c.lineTo(t[0], t[1]) : c.moveTo(t[0], t[1])); c.closePath(); }
    c.fillStyle = rgb(dm.col, 0.13); c.fill('evenodd');
    c.save(); c.setLineDash([5, 3]); c.strokeStyle = rgb(dm.col.map(x => x * 0.7), 0.9); c.lineWidth = 1.3; c.stroke(); c.restore();
    let fi = 0; q.forEach((t, i) => { if (t[1] > q[fi][1]) fi = i; });
    c.font = 'italic 12px ui-serif, Georgia, "Times New Roman", serif'; c.textAlign = 'center'; c.textBaseline = 'top'; c.lineJoin = 'round';
    c.lineWidth = 3.4; c.strokeStyle = 'rgba(255,255,255,.92)'; const ty = q[fi][1] + 6 + di * 15;
    c.strokeText(dm.txt, q[fi][0], ty); c.fillStyle = rgb(dm.col.map(x => x * 0.6)); c.fillText(dm.txt, q[fi][0], ty);
  });
  // back vertical axis (z)
  let bi = 0; fl.forEach((q, i) => { if (q[2] > fl[bi][2]) bi = i; });
  const cr = [[-bx, -by], [bx, -by], [bx, by], [-bx, by]][bi];
  c.strokeStyle = '#9aa5b5'; c.lineWidth = 1; seg(T([cr[0], cr[1], -bz]), T([cr[0], cr[1], bz]));
  c.font = '10.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; c.fillStyle = '#5b6474'; c.textBaseline = 'middle';
  const stz = niceStep(geo.hi - geo.lo, 260);
  c.textAlign = 'right';
  for (let z = Math.ceil(geo.lo / stz) * stz; z <= geo.hi + 1e-9; z += stz) { const q = T([cr[0], cr[1], geo.NZ(z)]); c.fillText(fmtTick(z, stz), q[0] - 6, q[1]); c.strokeStyle = '#9aa5b5'; seg([q[0] - 3, q[1]], [q[0] + 3, q[1]]); }
  const zt = T([cr[0], cr[1], bz]); c.font = 'italic 13px system-ui, -apple-system, "Segoe UI", sans-serif'; c.textAlign = 'center'; c.fillText('z', zt[0], zt[1] - 10);
  // surfaces (painter's algorithm, far to near)
  const fs = geo.faces.map(f => { const q = f.p.map(T); let d = 0; for (const t of q) d += t[2]; return { f, q, d: d / q.length }; });
  // grid lines lying on a graph are sorted with the faces, so the far side of a sphere hides its own lines
  const ss = (geo.segs || []).map(sg => { const a = T(sg.a), b = T(sg.b); return { sg, q: [a, b], d: (a[2] + b[2]) / 2 - 0.03 }; });
  const order = ss.length ? fs.concat(ss).sort((a, b) => b.d - a.d) : fs.sort((a, b) => b.d - a.d);
  for (const { f, q, sg } of order) {
    if (sg) { c.strokeStyle = rgb(sg.col, sg.al); c.lineWidth = sg.w; c.beginPath(); c.moveTo(q[0][0], q[0][1]); c.lineTo(q[1][0], q[1][1]); c.stroke(); continue; }
    const sh = 0.52 + 0.48 * Math.abs(f.n[0] * LIGHT[0] + f.n[1] * LIGHT[1] + f.n[2] * LIGHT[2]);
    const col = [f.col[0] * sh, f.col[1] * sh, f.col[2] * sh];
    c.beginPath(); q.forEach((t, i) => i ? c.lineTo(t[0], t[1]) : c.moveTo(t[0], t[1])); c.closePath();
    c.fillStyle = rgb(col, f.alpha || 1); c.fill();
    if (f.wall) continue;
    if (f.smooth) { c.strokeStyle = c.fillStyle; c.lineWidth = 0.7; }
    else if (f.box) { c.strokeStyle = 'rgba(16,40,36,.45)'; c.lineWidth = 0.8; }
    else if (f.tint) { c.strokeStyle = rgb(f.tint, 0.35); c.lineWidth = 0.6; }
    else if (f.alpha && f.main) { c.strokeStyle = 'rgba(20,28,45,.1)'; c.lineWidth = 0.5; }
    else if (f.alpha) { c.strokeStyle = 'rgba(122,63,209,.3)'; c.lineWidth = 0.6; }
    else if (f.tri) { c.strokeStyle = rgb(col); c.lineWidth = 0.6; }
    else { c.strokeStyle = 'rgba(20,28,45,.17)'; c.lineWidth = 0.6; }
    c.stroke();
  }
  c.lineWidth = 1.1;
  for (const [A, B, col] of geo.wires) { c.strokeStyle = rgb(col, 0.95); seg(T(A), T(B)); }
  // where each drawn object sits on screen (for the eraser)
  geo.hits = [];
  const hb = new Map();
  for (const { f, q } of fs) if (f.lid) { let b = hb.get(f.lid); if (!b) hb.set(f.lid, b = { lid: f.lid, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }); for (const t of q) { b.x0 = Math.min(b.x0, t[0]); b.x1 = Math.max(b.x1, t[0]); b.y0 = Math.min(b.y0, t[1]); b.y1 = Math.max(b.y1, t[1]); } }
  geo.hits.push(...hb.values());
  c.lineWidth = 2.6; c.lineJoin = 'round'; c.lineCap = 'round';
  for (const cu of geo.curves) {
    c.lineWidth = cu.w || 2.6;
    c.strokeStyle = rgb(cu.col); c.beginPath(); let pen = false;
    for (const p of cu.pts) { if (!p) { pen = false; continue; } const q = T(p); if (pen) c.lineTo(q[0], q[1]); else { c.moveTo(q[0], q[1]); pen = true; } }
    c.stroke();
  }
  for (const ln of geo.lines3 || []) {
    c.strokeStyle = rgb(ln.col); c.lineWidth = ln.w; c.beginPath();
    ln.pts.forEach((p3, i) => { const q = T(p3); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.stroke();
  }
  if (geo.dirFloor) { const a = T(geo.dirFloor[0]), b = T(geo.dirFloor[1]); arrow(c, a[0], a[1], b[0], b[1], '#e5484d', 2.2); }
  if (geo.marker) {
    const m = T(geo.marker), mf = T(geo.markerFloor);
    c.save(); c.setLineDash([3, 3]); c.strokeStyle = 'rgba(122,63,209,.8)'; c.lineWidth = 1.2; seg(m, mf); c.restore();
    drawDot(c, m[0], m[1], '#7a3fd1', true);
    c.font = 'italic 600 12px system-ui, -apple-system, "Segoe UI", sans-serif'; c.fillStyle = '#7a3fd1'; c.textAlign = 'left'; c.fillText('P', m[0] + 9, m[1] - 9);
  }
  // front-edge axis labels
  const yF = T([0, -by, -bz])[2] < T([0, by, -bz])[2] ? -by : by;
  const xF = T([-bx, 0, -bz])[2] < T([bx, 0, -bz])[2] ? -bx : bx;
  c.font = '10.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; c.fillStyle = '#5b6474'; c.textAlign = 'center'; c.textBaseline = 'middle';
  for (let x = Math.ceil(geo.x0 / stx) * stx; x <= geo.x1 + 1e-9; x += stx) { const q = T([NX(x), yF * 1.13, -bz]); c.fillText(fmtTick(x, stx), q[0], q[1]); }
  for (let y = Math.ceil(geo.y0 / sty) * sty; y <= geo.y1 + 1e-9; y += sty) { const q = T([xF * 1.13, NY(y), -bz]); c.fillText(fmtTick(y, sty), q[0], q[1]); }
  c.font = 'italic 13px system-ui, -apple-system, "Segoe UI", sans-serif'; c.fillStyle = '#1b2230';
  const xl = T([bx * 1.12, yF * 1.3, -bz]), yl = T([xF * 1.3, by * 1.12, -bz]);
  c.fillText('x', xl[0], xl[1]); c.fillText('y', yl[0], yl[1]);
  c.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'; c.fillStyle = '#8a94a4'; c.textAlign = 'right'; c.textBaseline = 'top';
  c.fillText('Drag to rotate · pinch to zoom', W - 10, 8);
}
function lineLabel(l) {
  const an = anOf(l);
  if (an.kind === 'surface') return `<i>z</i> = ${ME.pp(an.f)}`;
  if (an.kind === 'implicit3d') return `${ME.pp(an.g.a)} = ${ME.pp(an.g.b)}`;
  if (an.kind === 'curve3d') return `(${ME.pp(an.fx)}, ${ME.pp(an.fy)}, ${ME.pp(an.fz)})`;
  if (an.kind === 'solid') return solidShort(an);
  return l.expr;
}
function planeEq(z0, fx, fy, px, py) {
  const term = (k, v, p) => {
    if (Math.abs(k) < 1e-12) return '';
    const inner = Math.abs(p) < 1e-12 ? `<i>${v}</i>` : `(<i>${v}</i> ${p < 0 ? '+' : '−'} ${ME.fmt(Math.abs(r2(p)))})`;
    return (k < 0 ? ' − ' : ' + ') + (Math.abs(Math.abs(k) - 1) < 1e-12 ? '' : ME.fmt(Math.abs(r4(k)))) + inner;
  };
  return `<i>z</i> = ${ME.fmt(r4(z0))}${term(fx, 'x', px)}${term(fy, 'y', py)}`;
}
function calcDefaults(g) {
  if (!g.show) g.show = {};
  if (!g.R) g.R = { a: 0, b: 1, c: 0, d: 1 };
  if (g.nb == null) g.nb = 4;
  if (g.dirA == null) g.dirA = Math.PI / 4;
  if (g.px == null) { g.px = 1; g.py = 0.5; }
}
const normR = R => ({ a: Math.min(R.a, R.b), b: Math.max(R.a, R.b), c: Math.min(R.c, R.d), d: Math.max(R.c, R.d) });
function dirTip(g, W, H) {
  const v = g.view, X = x => (x - v.x0) / (v.x1 - v.x0) * W, Y = y => (v.y1 - y) / (v.y1 - v.y0) * H;
  let dx = Math.cos(g.dirA) * W / (v.x1 - v.x0), dy = -Math.sin(g.dirA) * H / (v.y1 - v.y0); const L = Math.hypot(dx, dy) || 1;
  return [X(g.px) + dx / L * 58, Y(g.py) + dy / L * 58];
}
function dbl(f, a, b, c, d, n = 48) {
  if (n % 2) n++;
  const hx = (b - a) / n, hy = (d - c) / n, w = k => (k === 0 || k === n) ? 1 : (k % 2 ? 4 : 2);
  let s = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const v = f(a + i * hx, c + j * hy); if (isFinite(v)) s += w(i) * w(j) * v; }
  return s * hx * hy / 9;
}
function calcLegend(surf, g, mode) {
  const an = anOf(surf), out = [];
  calcDefaults(g);
  const in3D = !MODES2D.has(mode);
  if (g.show.dx) out.push(`<span style="color:#7c5cff">∂f/∂x = ${an.fxN ? ME.pp(an.fxN) : 'numeric'}${in3D ? ' (violet surface)' : ''}</span>`);
  if (g.show.dy) out.push(`<span style="color:#e5484d">∂f/∂y = ${an.fyN ? ME.pp(an.fyN) : 'numeric'}${in3D ? ' (coral surface)' : ''}</span>`);
  if (g.show.dir) {
    const ux = Math.cos(g.dirA), uy = Math.sin(g.dirA), fx = partial(an, 'x', g.px, g.py), fy = partial(an, 'y', g.px, g.py);
    const deg = Math.round(((g.dirA * 180 / Math.PI) % 360 + 360) % 360);
    out.push(`<span style="color:#c4373c">D<sub>u</sub>f(P) = ∇f·u = <b>${ME.fmt(r4(fx * ux + fy * uy))}</b>, u = ⟨${ME.fmt(r2(ux))}, ${ME.fmt(r2(uy))}⟩ (${deg}°)${in3D ? '' : ', drag the arrow tip'}</span>`);
  }
  if (g.show.vol || g.show.box) {
    const R = normR(g.R), f = (x, y) => an.c.f(scope, x, y), I = dbl(f, R.a, R.b, R.c, R.d), area = (R.b - R.a) * (R.d - R.c);
    const rs = `R = [${fmt2(R.a)}, ${fmt2(R.b)}] × [${fmt2(R.c)}, ${fmt2(R.d)}]`;
    if (g.show.vol) out.push(`<span style="color:#087f8c">∬<sub>R</sub> f dA = <b>${ME.fmt(r4(I))}</b> over ${rs}${area > 0 ? `, average value <b>${ME.fmt(r4(I / area))}</b>` : ''}</span>`);
    if (g.show.box) {
      const n = g.nb, dx = (R.b - R.a) / n, dy = (R.d - R.c) / n; let S2 = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const v = f(R.a + (i + .5) * dx, R.c + (j + .5) * dy); if (isFinite(v)) S2 += v * dx * dy; }
      out.push(`<span>Riemann sum, ${n}×${n} midpoint boxes: <b>${ME.fmt(r4(S2))}</b>${g.show.vol ? '' : ` (exact ${ME.fmt(r4(I))})`}</span>`);
    }
    if (!in3D) { } else out.push(`<span class="muted">Drag R’s corners in the Level, Heat or ∇f view</span>`);
  }
  return out;
}
function pointLegend(surf, g) {
  const an = anOf(surf), px = g.px, py = g.py, z0 = an.c.f(scope, px, py), fx = partial(an, 'x', px, py), fy = partial(an, 'y', px, py);
  return [
    `<span style="color:#7a3fd1">P = (${fmt2(px)}, ${fmt2(py)}), f(P) = <b>${ME.fmt(r4(z0))}</b>, ∇f = ⟨${ME.fmt(r4(fx))}, ${ME.fmt(r4(fy))}⟩</span>`,
    `<span>∂f/∂x = ${an.fxN ? ME.pp(an.fxN) : ME.fmt(r4(fx))}, ∂f/∂y = ${an.fyN ? ME.pp(an.fyN) : ME.fmt(r4(fy))}</span>`,
    `<span style="color:#7a3fd1">Tangent plane: ${planeEq(z0, fx, fy, px, py)}</span>`,
    ...secondLegend(an, px, py, fx, fy, z0)
  ];
}
function secondLegend(an, px, py, fx, fy, z0) {
  if (!an.c.fxx) return [];
  const fxx = an.c.fxx(scope, px, py), fyy = an.c.fyy(scope, px, py), fxy = an.c.fxy(scope, px, py);
  if (![fxx, fyy, fxy].every(isFinite)) return [];
  const D = fxx * fyy - fxy * fxy;
  let verdict = '';
  if (Math.abs(fx) < 1e-6 * (1 + Math.abs(z0)) && Math.abs(fy) < 1e-6 * (1 + Math.abs(z0))) verdict = D > 1e-12 ? (fxx > 0 ? ' → P is a local minimum' : ' → P is a local maximum') : D < -1e-12 ? ' → P is a saddle point' : ' → the test can’t decide here';
  return [`<span>f<sub>xx</sub> = ${ME.fmt(r4(fxx))}, f<sub>yy</sub> = ${ME.fmt(r4(fyy))}, f<sub>xy</sub> = ${ME.fmt(r4(fxy))}, D = ${ME.fmt(r4(D))}${verdict}</span>`];
}
function drawGraph3D(g, ge, c, W, H) {
  const lines = g.lineIds.map(lineById).filter(l => liveLine(l) && GRAPH3D.has(anOf(l).kind));
  const surf = primarySurface(g);
  const mode = surf ? (g.mode || 'surface') : 'surface';
  if (g.px == null) { g.px = 1; g.py = 0.5; }
  const legend = [];
  if (surf && MODES2D.has(mode)) drawSurface2D(g, c, W, H, surf, mode, legend);
  else {
    calcDefaults(g);
    const key = JSON.stringify([lines.map(l => l.id + ':' + l.expr), g.view, mode, scopeKey(lines), g.show, g.px, g.py, g.R, g.nb, g.dirA]);
    if (ge.geoKey !== key) { ge.geo = build3D(g, lines, mode); ge.geoKey = key; }
    render3D(g, ge.geo, c, W, H);
    const nonSolid = lines.filter(l => anOf(l).kind !== 'solid');
    if (lines.length > 1) nonSolid.forEach(l => legend.push(`<span style="color:${GCOL[(l.colorIdx || 0) % GCOL.length]}">${lineLabel(l)}</span>`));
    for (const l of lines) { const an = anOf(l); if (an.kind !== 'solid') continue; const v = solidVals(an), inf = solidInfo(an.solid, v), S = solidFuncs(an.solid, v), col = GCOL[(l.colorIdx || 0) % GCOL.length];
      legend.push(`<span style="color:${col}">${SOLID[an.solid].name}: ${solidRegionHTML(an)}${S.walls ? '' : `,&nbsp; <i>D</i>: ${S.D.html}`}</span>`);
      if (inf.V != null) legend.push(`<span><i>V</i> = ∬<sub><i>D</i></sub> (<i>f</i> − <i>g</i>) <i>dA</i> = <b>${fmtS(inf.V)}</b>${inf.S != null ? `, &nbsp;<i>S</i> = <b>${fmtS(inf.S)}</b>` : ''}</span>`); }
    if (g.drawOn && !lines.length && !(ge.pending.length || ge.sk) && !ge.ghostOn) {
      const tr = g.draw3 === 'trace', t1 = tr ? 'Draw how z changes along x, then along y' : 'Draw a solid or a surface the way a textbook does', t2 = tr ? 'The two traces become a surface z = f(x, y)' : 'Sphere · ellipsoid · cone · cylinder · paraboloid · hyperboloid · saddle · box · plane';
      c.save(); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
      c.font = '600 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'; c.lineWidth = 4; c.strokeStyle = 'rgba(255,255,255,.9)'; c.strokeText(t1, W / 2, 34); c.fillStyle = '#4f5b57'; c.fillText(t1, W / 2, 34);
      c.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'; c.strokeText(t2, W / 2, 54); c.fillStyle = '#6f7a76'; c.fillText(t2, W / 2, 54); c.restore();
    }
  }
  if (surf) legend.push(...calcLegend(surf, g, mode));
  if (surf && g.show.tp && mode !== 'slice') legend.push(...pointLegend(surf, g));
  if (!lines.length && !g.is3d) legend.push('<span class="muted">Waiting for the line to be read…</span>');
  const html = legend.join('');
  if (ge.legend.dataset.html !== html) { ge.legend.innerHTML = html; ge.legend.dataset.html = html; }
  ge.legend.hidden = !legend.length;
  ge.legend.classList.toggle('min', !!g.legendMin && legend.length > 1);
}
function drawSurface2D(g, c, W, H, surf, mode, legend) {
  const an = anOf(surf), v = g.view;
  if (mode === 'slice') return drawSlices(g, c, W, H, surf, legend);
  const X = x => (x - v.x0) / (v.x1 - v.x0) * W, Y = y => (v.y1 - y) / (v.y1 - v.y0) * H;
  const IX = px => v.x0 + px / W * (v.x1 - v.x0), IY = py => v.y1 - py / H * (v.y1 - v.y0);
  const F = (x, y) => an.c.f(scope, x, y);
  const vals = [];
  for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) { const q = F(IX((i + .5) * W / 40), IY((j + .5) * H / 40)); if (isFinite(q)) vals.push(q); }
  vals.sort((a, b) => a - b);
  const lo = vals.length ? vals[Math.floor(vals.length * 0.04)] : -1, hi = vals.length ? vals[Math.floor(vals.length * 0.96)] : 1;
  if (mode === 'heat') { drawSurface(c, an, W, H, IX, IY, '#000'); legend.push('<span><span style="color:#0a7096">Teal: low</span> · <span style="color:#c77208">amber: high</span></span>'); }
  drawAxes2D(c, v, W, H, false, mode === 'heat');
  if (mode === 'level' || mode === 'grad') {
    const n = 11, levels = [], cols = [];
    for (let k = 0; k < n; k++) { const t = (k + 0.5) / n; levels.push(lo + (hi - lo) * t); cols.push(rgb(cmap(t).map(x => x * 0.82), mode === 'grad' ? 0.45 : 1)); }
    const cands = [];
    marching(c, F, W, H, IX, IY, 3, levels, null, cols, mode === 'level' ? cands : null);
    if (mode === 'level') {
      const placed = [{ x: 150, y: 70 }];
      c.font = '10.5px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
      for (let li = 0; li < levels.length; li++) {
        let best = null, bd = 0;
        for (const [k, x, y] of cands) { if (k !== li) continue; const d = Math.min(...placed.map(p => Math.hypot(p.x - x, p.y - y))); if (d > bd) { bd = d; best = [x, y]; } }
        if (!best || bd < 34) continue;
        placed.push({ x: best[0], y: best[1] });
        const t = fmtTick(levels[li], niceStep(hi - lo, 600, 40));
        c.lineWidth = 3.5; c.strokeStyle = '#fff'; c.strokeText(t, best[0], best[1]); c.fillStyle = cols[li]; c.fillText(t, best[0], best[1]);
      }
      legend.push('<span>Level curves f(x, y) = c</span>');
    }
  }
  if (mode === 'grad') {
    const cols = 15, rows = Math.max(6, Math.round(cols * H / W)), cw = W / cols, ch = H / rows;
    const gr = []; let mx = 0;
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const x = IX((q + .5) * cw), y = IY((r + .5) * ch), gx = partial(an, 'x', x, y), gy = partial(an, 'y', x, y), m = Math.hypot(gx, gy);
      if (isFinite(m)) { gr.push([(q + .5) * cw, (r + .5) * ch, gx, gy, m]); mx = Math.max(mx, m); }
    }
    for (const [sx, sy, gx, gy, m] of gr) {
      if (m < 1e-12) continue;
      let dx = gx * W / (v.x1 - v.x0), dy = -gy * H / (v.y1 - v.y0); const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const len = clamp(m / (mx || 1), 0.25, 1) * 0.82 * Math.min(cw, ch);
      arrow(c, sx - dx * len / 2, sy - dy * len / 2, sx + dx * len / 2, sy + dy * len / 2, rgb(cmap(m / (mx || 1)).map(x => x * 0.75)), 1.4);
    }
    legend.push('<span>Arrows: ∇f, pointing uphill</span>');
  }
  calcDefaults(g);
  if (g.show.vol || g.show.box) {
    const R = normR(g.R), rx0 = X(R.a), rx1 = X(R.b), ry0 = Y(R.d), ry1 = Y(R.c);
    c.fillStyle = 'rgba(8,127,140,.12)'; c.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
    c.save(); c.setLineDash([6, 4]); c.strokeStyle = '#087f8c'; c.lineWidth = 1.6; c.strokeRect(rx0, ry0, rx1 - rx0, ry1 - ry0); c.restore();
    if (g.show.box) { c.strokeStyle = 'rgba(8,127,140,.45)'; c.lineWidth = 1; for (let k = 1; k < g.nb; k++) { const xx = rx0 + (rx1 - rx0) * k / g.nb, yy = ry0 + (ry1 - ry0) * k / g.nb; c.beginPath(); c.moveTo(xx, ry0); c.lineTo(xx, ry1); c.moveTo(rx0, yy); c.lineTo(rx1, yy); c.stroke(); } }
    for (const [hx2, hy2] of [[X(g.R.a), Y(g.R.c)], [X(g.R.b), Y(g.R.d)]]) { c.fillStyle = '#fff'; c.strokeStyle = '#087f8c'; c.lineWidth = 2; c.beginPath(); c.rect(hx2 - 6, hy2 - 6, 12, 12); c.fill(); c.stroke(); }
    c.font = 'italic 600 13px system-ui, -apple-system, "Segoe UI", sans-serif'; c.fillStyle = '#087f8c'; c.textAlign = 'left'; c.textBaseline = 'top'; c.fillText('R', Math.min(rx0, rx1) + 6, Math.min(ry0, ry1) + 5);
  }
  if (g.show.dir) {
    const t = dirTip(g, W, H), sx = X(g.px), sy = Y(g.py);
    arrow(c, sx, sy, t[0], t[1], '#e5484d', 2.6);
    c.beginPath(); c.arc(t[0], t[1], 7, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.lineWidth = 2.2; c.strokeStyle = '#e5484d'; c.stroke();
    c.font = 'italic 600 12px system-ui, -apple-system, "Segoe UI", sans-serif'; c.fillStyle = '#e5484d'; c.textAlign = 'left'; c.textBaseline = 'bottom'; c.fillText('u', t[0] + 9, t[1] - 4);
  }
  if (g.show.tp) {
    const px = X(g.px), py = Y(g.py), gx = partial(an, 'x', g.px, g.py), gy = partial(an, 'y', g.px, g.py);
    let dx = gx * W / (v.x1 - v.x0), dy = -gy * H / (v.y1 - v.y0); const L = Math.hypot(dx, dy);
    if (L > 1e-9) { dx /= L; dy /= L; arrow(c, px, py, px + dx * 46, py + dy * 46, '#7a3fd1', 2.4); }
    drawDot(c, px, py, '#7a3fd1', true);
    c.font = 'italic 600 12px system-ui, -apple-system, "Segoe UI", sans-serif'; c.fillStyle = '#7a3fd1'; c.textAlign = 'left'; c.textBaseline = 'bottom'; c.fillText('P', px + 9, py - 6);
  }
}
function arrow(c, x0, y0, x1, y1, col, w) {
  c.strokeStyle = col; c.fillStyle = col; c.lineWidth = w;
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0), hl = 4 + w * 2;
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x1 - hl * Math.cos(a - 0.45), y1 - hl * Math.sin(a - 0.45)); c.lineTo(x1 - hl * Math.cos(a + 0.45), y1 - hl * Math.sin(a + 0.45)); c.closePath(); c.fill();
}
function drawSlices(g, c, W, H, surf, legend) {
  const an = anOf(surf), v = g.view, px = g.px, py = g.py;
  const s0 = Math.min(v.x0, v.y0), s1 = Math.max(v.x1, v.y1);
  const fA = s => an.c.f(scope, s, py), fB = s => an.c.f(scope, px, s);
  const vals = [];
  for (let i = 0; i <= 200; i++) { const s = s0 + (s1 - s0) * i / 200; for (const q of [fA(s), fB(s)]) if (isFinite(q)) vals.push(q); }
  vals.sort((a, b) => a - b);
  let lo = vals.length ? vals[Math.floor(vals.length * 0.03)] : -1, hi = vals.length ? vals[Math.floor(vals.length * 0.97)] : 1;
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.15;
  const vv = { x0: s0, x1: s1, y0: Math.min(lo - pad, -pad), y1: Math.max(hi + pad, pad) };
  drawAxes2D(c, vv, W, H, false);
  const X = x => (x - vv.x0) / (vv.x1 - vv.x0) * W, Y = y => (vv.y1 - y) / (vv.y1 - vv.y0) * H, IX = q => vv.x0 + q / W * (vv.x1 - vv.x0);
  const CA = '#0b8aa4', CB = '#e5484d';
  c.lineWidth = 2.4; c.lineJoin = 'round';
  c.strokeStyle = CA; plotFn(c, fA, W, H, X, Y, IX);
  c.strokeStyle = CB; plotFn(c, fB, W, H, X, Y, IX);
  const z0 = an.c.f(scope, px, py), fx = partial(an, 'x', px, py), fy = partial(an, 'y', px, py);
  c.save(); c.setLineDash([6, 4]); c.lineWidth = 1.5;
  if (isFinite(z0) && isFinite(fx)) { c.strokeStyle = CA; c.beginPath(); c.moveTo(0, Y(z0 + fx * (vv.x0 - px))); c.lineTo(W, Y(z0 + fx * (vv.x1 - px))); c.stroke(); }
  if (isFinite(z0) && isFinite(fy)) { c.strokeStyle = CB; c.beginPath(); c.moveTo(0, Y(z0 + fy * (vv.x0 - py))); c.lineTo(W, Y(z0 + fy * (vv.x1 - py))); c.stroke(); }
  c.restore();
  if (isFinite(z0)) { drawDot(c, X(px), Y(z0), CA, true); drawDot(c, X(py), Y(z0), CB, true); }
  legend.push(`<span style="color:${CA}">z = f(x, ${fmt2(py)}): slope ∂f/∂x = <b>${ME.fmt(r4(fx))}</b></span>`);
  legend.push(`<span style="color:${CB}">z = f(${fmt2(px)}, y), against y: slope ∂f/∂y = <b>${ME.fmt(r4(fy))}</b></span>`);
  legend.push(`<span class="muted">Move P in the Level, Heat or ∇f view</span>`);
}

/* ---------- selection (lasso) ---------- */
let sel = null;
function pointInPoly(x, y, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
function selectByLasso(poly) {
  if (poly.length < 3) return;
  const ids = [];
  for (const id of doc.order) {
    const s = doc.strokes[id]; if (!s) continue;
    const step = Math.max(1, Math.floor(s.pts.length / 24));
    let inC = 0, tot = 0;
    for (let i = 0; i < s.pts.length; i += step) { tot++; if (pointInPoly(s.pts[i][0], s.pts[i][1], poly)) inC++; }
    if (tot && inC / tot >= 0.5) ids.push(id);
  }
  const gids = doc.graphs.filter(g => pointInPoly(g.x + g.w / 2, g.y + g.h / 2, poly)).map(g => g.id);
  const iids = doc.imgs.filter(im => pointInPoly(im.x + im.w / 2, im.y + im.h / 2, poly)).map(im => im.id);
  if (!ids.length && !gids.length && !iids.length) { clearSelection(); return; }
  sel = { ids, gids, iids };
  renderSelection();
}
function selBB() {
  if (!sel) return null;
  const bbs = sel.ids.map(id => doc.strokes[id] && bbox(doc.strokes[id]));
  for (const gid of sel.gids) { const g = graphById(gid); if (g) bbs.push({ x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h }); }
  for (const iid of sel.iids || []) { const im = doc.imgs.find(q => q.id === iid); if (im) bbs.push({ x0: im.x, y0: im.y, x1: im.x + im.w, y1: im.y + im.h }); }
  const b = unionBB(bbs);
  return isFinite(b.x0) ? b : null;
}
function renderSelection() {
  gTemp.querySelectorAll('.sel').forEach(n => n.remove());
  const menu = $('#selmenu');
  if (!sel) { menu.hidden = true; return; }
  const b = selBB(); if (!b) { clearSelection(); return; }
  const pad = 8;
  gTemp.appendChild(S('rect', { x: b.x0 - pad, y: b.y0 - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, class: 'sel sel-box' }));
  if (sel.ids.length || (sel.iids || []).length) gTemp.appendChild(S('circle', { cx: b.x1 + pad, cy: b.y1 + pad, r: 8 / view.s, class: 'sel sel-handle' }));
  menu.hidden = false;
  $('#selRead').hidden = !sel.ids.length;
  positionOverlays();
}
function clearSelection() { sel = null; renderSelection(); }
function selAction(act, arg) {
  if (!sel) return;
  if (act === 'delete') { transact(() => { sel.ids.forEach(removeStroke); doc.graphs = doc.graphs.filter(g => !sel.gids.includes(g.id)); doc.imgs = doc.imgs.filter(im => !(sel.iids || []).includes(im.id)); cleanupLines(); }); renderImgs(); }
  else if (act === 'dup') transact(() => {
    const map = new Map();
    const newIds = [];
    for (const id of sel.ids) { const s = doc.strokes[id]; if (!s) continue; const n = { id: uid(), tool: s.tool, color: s.color, w: s.w, pts: s.pts.map(p => [p[0] + 24, p[1] + 24, p[2]]) }; addStroke(n); newIds.push(n.id); map.set(id, n.id); }
    const newImgs = []; for (const iid of sel.iids || []) { const im = doc.imgs.find(q => q.id === iid); if (im) { const c = Object.assign({}, im, { id: uid(), x: im.x + 24, y: im.y + 24 }); doc.imgs.push(c); newImgs.push(c.id); } }
    sel = { ids: newIds, gids: [], iids: newImgs }; renderImgs();
  });
  else if (act === 'color') transact(() => { for (const id of sel.ids) { const s = doc.strokes[id]; if (!s || s.tool === 'hl') continue; touch(id); s.color = s.tool === 'pencil' ? PENCIL[INK.indexOf(arg)] || arg : arg; } });
  else if (act === 'read') {
    transact(() => {
      for (const id of sel.ids) { const s = doc.strokes[id]; if (s && s.lineId) { const l = lineById(s.lineId); if (l) { l.strokeIds = l.strokeIds.filter(x => x !== id); l.dirty = true; } } }
      const ids = sel.ids.filter(id => doc.strokes[id] && doc.strokes[id].tool !== 'hl');
      if (!ids.length) return;
      ids.forEach(id => { doc.strokes[id].lineId = null; });
      const col = findColumns(ids)[0];
      let l;
      if (col && col.rows.flat().length + 1 + col.below.length >= ids.length * 0.8) l = newColumnLine(col);
      else {
        l = { id: uid(), strokeIds: ids, clusters: [], expr: '', status: 'new', dirty: true, ver: 1, colorIdx: null, anchors: [] };
        ids.forEach(id => { doc.strokes[id].lineId = l.id; });
        doc.lines.push(l);
      }
      cleanupLines();
      clearSelection();
      queueRead(l);
    });
  }
  syncInk(); refresh(); renderSelection();
}

/* ---------- pointer input on the page ----------
   Apple Pencil (and mouse) write. Once a pencil has been seen, fingers never draw:
   they scroll, zoom, tap numbers, move a selection, and use every button and graph.
   Smoothness: every pencil sample is kept (coalesced events), painted once per frame,
   smoothed without lag, and never cut off by a resting palm. */
let gesture = null;
const touches = new Map();          // finger touches on the page: pointerId -> [x, y]
const palmIds = new Set();          // touches that landed while the pencil was busy: ignored until lifted
const downIds = new Set();          // pointers whose pointerdown we saw (used to recover swallowed ones)
let spaceDown = false, tapT = null, lastTap = null, lastPenEnd = null, liveRaf = 0;
const DRAW_TOOLS = new Set(['pen', 'pencil', 'hl']);
const NO_INK = '.chip, .graph, #addPage, #quickSwitch, #pop, .edit-box';
const INPUT_KEY = STORE_KEY + ':input';
const inputPrefs = Object.assign({ pencilOnly: null, tapUndo: true, quickSwitch: true, penSeen: false },
  (() => { try { return JSON.parse(localStorage.getItem(INPUT_KEY) || '{}') || {}; } catch (e) { return {}; } })());
function saveInputPrefs() { try { localStorage.setItem(INPUT_KEY, JSON.stringify(inputPrefs)); } catch (e) { } }
let penSeen = !!inputPrefs.penSeen;
function fingersDraw() { return inputPrefs.pencilOnly === false || (inputPrefs.pencilOnly == null && !penSeen); }
function notePen() {
  if (penSeen) return;
  penSeen = true; inputPrefs.penSeen = true; saveInputPrefs();
  updateInputUI();
  if (inputPrefs.pencilOnly == null) toast('Pencil detected: only the pencil writes now. Fingers scroll, zoom and tap.');
}

viewport.addEventListener('pointerdown', onDown);
viewport.addEventListener('pointermove', onMove);
viewport.addEventListener('pointerup', e => endPointer(e, false));
viewport.addEventListener('pointercancel', e => endPointer(e, true));
viewport.addEventListener('pointerleave', e => { if (e.pointerType === 'pen') hideHover(); });
viewport.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('pointerdown', e => downIds.add(e.pointerId), true);
document.addEventListener('pointerup', e => downIds.delete(e.pointerId), true);
document.addEventListener('pointercancel', e => downIds.delete(e.pointerId), true);
// iPadOS Scribble can swallow pencil pointer events on web pages; a non-passive touch handler
// that cancels the default keeps every stroke coming to us (and stops the text loupe / callout).
const TOUCH_UI = 'button, input, select, textarea, a, label, .chip, .graph, #pop, .edit-box, #quickSwitch, .glegend';
viewport.addEventListener('touchstart', e => {
  if (e.target.closest(TOUCH_UI)) return;
  for (const t of e.changedTouches) if (t.touchType === 'stylus') { e.preventDefault(); return; }
}, { passive: false });
viewport.addEventListener('touchmove', e => { if (!e.target.closest('input, textarea, select, .glegend')) e.preventDefault(); }, { passive: false });
viewport.addEventListener('gesturestart', e => e.preventDefault());

function syncInking() { viewport.classList.toggle('inking', !!(gesture && gesture.type === 'draw')); }
function onDown(e) {
  if (e.target.closest(NO_INK)) return;
  onDownInner(e); syncInking();
}
function onDownInner(e) {
  const pt = e.pointerType;
  if (pt === 'mouse' && e.button === 2) return;
  if (pt === 'touch') { touchDown(e); return; }
  if (pt === 'pen') { notePen(); hideHover(); }
  if (gesture && gesture.pointerType === 'touch') cancelTouchGesture(true);
  else if (gesture && gesture.id !== e.pointerId) { const g = gesture; gesture = null; finishGesture(g, e, true); }
  // stylus eraser end / eraser button (Surface Pen, Wacom…) erases for that stroke
  beginPointer(e, pt === 'pen' && (e.button === 5 || (e.buttons & 32)) ? 'eraser' : null);
}
function beginPointer(e, toolOverride, bridge) {
  closeMenus(); closeLineMenu();
  if (pop && !e.target.closest('#pop')) closePop();
  clearTimeout(idleT); lastInkAt = performance.now();
  try { viewport.setPointerCapture(e.pointerId); } catch (err) { }
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  const base = { id: e.pointerId, pointerType: e.pointerType };
  if (e.button === 1 || spaceDown || ui.tool === 'hand') { gesture = { ...base, type: 'pan', sx: e.clientX, sy: e.clientY, tx0: view.tx, ty0: view.ty, t0: performance.now() }; return; }
  if (selInteract(e, wx, wy, true)) return;
  const tool = toolOverride || ui.tool;
  if (!toolOverride && !bridge && (tool === 'pen' || tool === 'pencil')) {
    const hit = hitAnchor(wx, wy);
    if (hit) { gesture = { ...base, type: 'maybeTap', hit, sx: e.clientX, sy: e.clientY, t0: performance.now(), e0: e, buf: [e] }; return; }
    const line = lineAt(wx, wy, false);
    if (line) { gesture = { ...base, type: 'maybeTap', line, sx: e.clientX, sy: e.clientY, t0: performance.now(), e0: e, buf: [e] }; return; }
  }
  startTool(e, wx, wy, tool, bridge);
}
function selInteract(e, wx, wy, clearOutside) {
  if (!sel) return false;
  const b = selBB();
  if (b) {
    const hr = Math.max(14, e.pointerType === 'touch' ? 22 : 14) / view.s, pad = (e.pointerType === 'touch' ? 14 : 8) / view.s;
    const base = { id: e.pointerId, pointerType: e.pointerType };
    if ((sel.ids.length || (sel.iids || []).length) && Math.hypot(wx - (b.x1 + 8), wy - (b.y1 + 8)) < hr) { beginTx(); gesture = { ...base, type: 'selScale', b0: b, orig: sel.ids.map(id => [id, clone(doc.strokes[id].pts), doc.strokes[id].w]), origImgs: (sel.iids || []).map(iid => clone(doc.imgs.find(q => q.id === iid))).filter(Boolean) }; return true; }
    if (wx >= b.x0 - pad && wx <= b.x1 + pad && wy >= b.y0 - pad && wy <= b.y1 + pad) { beginTx(); gesture = { ...base, type: 'selMove', lx: wx, ly: wy, moved: false }; return true; }
  }
  if (clearOutside) clearSelection();
  return false;
}
function touchDown(e) {
  // the pencil (or mouse) is busy: this is a resting palm or a stray finger
  if (gesture && gesture.pointerType !== 'touch') { palmIds.add(e.pointerId); return; }
  const now = performance.now();
  if (!touches.size) tapT = { t0: now, n: 0, moved: false, bad: false, start: new Map(), view0: { tx: view.tx, ty: view.ty, s: view.s } };
  if (tapT) { if (now - tapT.t0 < 260 && !tapT.moved) { tapT.n++; tapT.start.set(e.pointerId, [e.clientX, e.clientY]); } else tapT.bad = true; }
  touches.set(e.pointerId, [e.clientX, e.clientY]);
  try { viewport.setPointerCapture(e.pointerId); } catch (err) { }
  if (touches.size === 2) {
    if (gesture) cancelTouchGesture(false);
    const [a, b] = [...touches.values()];
    gesture = { type: 'pinch', pointerType: 'touch', t0: now, d0: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), s0: view.s, tx0: view.tx, ty0: view.ty, c0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    return;
  }
  if (touches.size > 2) return;
  if (fingersDraw() && ui.tool !== 'hand') { beginPointer(e, null); return; }
  // Pencil-only: one finger moves a selection it lands on, otherwise scrolls; quick taps act
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  if (selInteract(e, wx, wy, false)) return;
  gesture = { type: 'pan', id: e.pointerId, pointerType: 'touch', sx: e.clientX, sy: e.clientY, tx0: view.tx, ty0: view.ty, t0: now };
}
function cancelTouchGesture(byPen) {
  const g = gesture; if (!g) return;
  gesture = null;
  if (g.type === 'draw' || g.type === 'lasso') g.el.remove();
  else if (g.type === 'erase') { g.hit.forEach(id => { const el = strokeEls.get(id); if (el) el.style.opacity = ''; }); endTx(); }
  else if (g.type === 'selMove' || g.type === 'selScale') { endTx(); refresh(); }
  else if ((g.type === 'pan' || g.type === 'pinch') && byPen && performance.now() - g.t0 < 450) {
    // a palm that landed just before the pencil: undo the little scroll it caused
    view.tx = g.tx0; view.ty = g.ty0; if (g.s0) view.s = g.s0; applyView();
  }
  if (byPen) { for (const id of touches.keys()) palmIds.add(id); touches.clear(); tapT = null; }
}
function startTool(e, wx, wy, tool = ui.tool, bridge = null) {
  const t = tool, base = { id: e.pointerId, pointerType: e.pointerType, rect: viewport.getBoundingClientRect(), sx: e.clientX, sy: e.clientY, t0: performance.now(), maxD: 0 };
  if (DRAW_TOOLS.has(t)) {
    const s = { id: uid(), tool: t, color: ui.color[t], w: WIDTHS[t][ui.width[t]], pts: [] };
    // live ink: settled pieces are painted once, only the tip is redrawn each frame;
    // the group carries the tool's transparency so overlapping pieces don't darken
    const el = S('g'), tail = S('path');
    if (t === 'hl') el.setAttribute('opacity', '0.42'); else if (t === 'pencil') el.setAttribute('opacity', '0.9');
    el.appendChild(tail); (t === 'hl' ? gHL : gInk).appendChild(el);
    gesture = { ...base, type: 'draw', s, el, tail, frozenTo: 0, raw: bridge ? [bridge.slice()] : [], pr: bridge ? bridge[2] : null, last: null, vel: 0, pred: null };
    addDrawPoint(e);
  } else if (t === 'eraser') {
    gesture = { ...base, type: 'erase', hit: new Set(), last: [wx, wy] };
    beginTx();
    eraseAt(wx, wy, wx, wy);
  } else if (t === 'lasso') {
    const el = S('path', { class: 'lasso' }); gTemp.appendChild(el);
    gesture = { ...base, type: 'lasso', poly: [[wx, wy]], el };
  } else if (t === 'laser') {
    gesture = { ...base, type: 'laser' };
    laserPts.push([wx, wy, performance.now()]); startLaser();
  }
}
function coalesced(e) { const c = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null; return c && c.length ? c : [e]; }
function inkPressure(g, ce) {
  if (ce.pointerType === 'pen') {
    // Apple Pencil: lift light pressure so quick, light writing never turns hairline-thin or gappy
    if (ce.pressure > 0) { const m = clamp(0.22 + 0.9 * Math.pow(ce.pressure, 0.6), 0.25, 1); g.pr = g.pr == null ? m : g.pr + (m - g.pr) * 0.4; }
    return g.pr == null ? 0.62 : g.pr;
  }
  const now = ce.timeStamp || performance.now();
  if (g.last) { const dt = Math.max(1, now - g.last[2]); const v = Math.hypot(ce.clientX - g.last[0], ce.clientY - g.last[1]) / dt; g.vel = g.vel * 0.7 + v * 0.3; }
  g.last = [ce.clientX, ce.clientY, now];
  return clamp(1.1 - g.vel * 0.35, 0.35, 1);
}
function addDrawPoint(e) {
  const g = gesture, raw = g.raw, r = g.rect || viewport.getBoundingClientRect(), minD = 0.6 / view.s;
  for (const ce of coalesced(e)) {
    const x = (ce.clientX - r.left - view.tx) / view.s, y = (ce.clientY - r.top - view.ty) / view.s;
    if (g.sx != null) g.maxD = Math.max(g.maxD, Math.abs(ce.clientX - g.sx) + Math.abs(ce.clientY - g.sy));
    const p = inkPressure(g, ce);
    const lp = raw[raw.length - 1];
    if (lp && Math.hypot(x - lp[0], y - lp[1]) < minD) { lp[2] = p; continue; }
    raw.push([x, y, p]);
  }
  // draw slightly ahead of the pencil tip (iPadOS predicts the next sample) to cut the lag
  g.pred = null;
  if (e.pointerType === 'pen' && typeof e.getPredictedEvents === 'function' && raw.length > 2) {
    const pe = e.getPredictedEvents(), q = pe && pe.length ? pe[pe.length - 1] : null;
    if (q) {
      const x = (q.clientX - r.left - view.tx) / view.s, y = (q.clientY - r.top - view.ty) / view.s, lp = raw[raw.length - 1];
      if (Math.hypot(x - lp[0], y - lp[1]) * view.s < 28) g.pred = [x, y, lp[2]];
    }
  }
  if (!liveRaf) liveRaf = requestAnimationFrame(paintLive);
}
const LIVE_CHUNK = 96;
function paintLive() {
  liveRaf = 0;
  const g = gesture; if (!g || g.type !== 'draw' || !g.raw.length) return;
  const sm = smoothPts(g.raw), st = { tool: g.s.tool, color: g.s.color, w: g.s.w };
  while (sm.length - g.frozenTo > LIVE_CHUNK + 12) {   // points this far behind the tip no longer change
    const a = Math.max(0, g.frozenTo - 4), b = g.frozenTo + LIVE_CHUNK;
    const p = S('path'); styleStrokeEl(p, { ...st, pts: sm.slice(a, b + 1) }); p.removeAttribute('opacity');
    g.el.insertBefore(p, g.tail); g.frozenTo = b;
  }
  const tip = sm.slice(Math.max(0, g.frozenTo - 4));
  if (g.pred) tip.push(g.pred);
  styleStrokeEl(g.tail, { ...st, pts: tip }); g.tail.removeAttribute('opacity');
}
// symmetric smoothing: removes jitter without the lag that makes stroke ends fall short
function smoothPts(raw) {
  const n = raw.length;
  if (n < 3) return raw.map(p => p.slice());
  const out = new Array(n);
  out[0] = raw[0].slice(); out[n - 1] = raw[n - 1].slice();
  for (let i = 1; i < n - 1; i++) {
    if (i === 1 || i === n - 2) { const a = raw[i - 1], b = raw[i], c = raw[i + 1]; out[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4, b[2]]; }
    else { const a = raw[i - 2], b = raw[i - 1], c = raw[i], d = raw[i + 1], f = raw[i + 2]; out[i] = [(a[0] + 4 * b[0] + 6 * c[0] + 4 * d[0] + f[0]) / 16, (a[1] + 4 * b[1] + 6 * c[1] + 4 * d[1] + f[1]) / 16, c[2]]; }
  }
  return out;
}
function finalizePts(raw) {
  const sm = smoothPts(raw), minD = 0.8 / view.s, out = [];
  for (let i = 0; i < sm.length; i++) {
    const p = sm[i], q = out[out.length - 1];
    if (q && i < sm.length - 1 && Math.hypot(p[0] - q[0], p[1] - q[1]) < minD) continue;
    out.push([r1(p[0]), r1(p[1]), r2(p[2])]);
  }
  return out;
}
// a pencil touching the page whose pointerdown never arrived (Scribble, system gestures): pick it up anyway
function recoverPen(e) {
  notePen();
  if (gesture && gesture.pointerType === 'touch') cancelTouchGesture(true);
  let bridge = null;
  const le = lastPenEnd;
  if (le && performance.now() - le.t < 180) { const [sx, sy] = toScreen(le.x, le.y); if (Math.hypot(sx - e.clientX, sy - e.clientY) < 48) bridge = [le.x, le.y, le.p]; }
  downIds.add(e.pointerId);
  beginPointer(e, null, bridge); syncInking();
}

function onMove(e) {
  const pt = e.pointerType;
  if (pt === 'touch') {
    if (palmIds.has(e.pointerId) || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (tapT && !tapT.moved) { const s = tapT.start.get(e.pointerId); if (s && Math.hypot(e.clientX - s[0], e.clientY - s[1]) > 10) tapT.moved = true; }
  }
  const g = gesture;
  if (!g) {
    if (pt === 'pen') {
      if ((e.buttons & 1) || e.pressure > 0) { if (!downIds.has(e.pointerId) && !e.target.closest(NO_INK)) { recoverPen(e); } }
      else showHover(e);
    }
    return;
  }
  if (g.type === 'pinch') {
    if (pt !== 'touch' || touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const ns = clamp(g.s0 * d / g.d0, 0.25, 5), k = ns / g.s0;
    const r = viewport.getBoundingClientRect();
    const px = g.c0[0] - r.left, py = g.c0[1] - r.top;
    view.s = ns; view.tx = px - (px - g.tx0) * k + (c[0] - g.c0[0]); view.ty = py - (py - g.ty0) * k + (c[1] - g.c0[1]);
    applyView(); return;
  }
  if (g.id != null && e.pointerId !== g.id) return;
  if (g.type === 'pan') { view.tx = g.tx0 + (e.clientX - g.sx); view.ty = g.ty0 + (e.clientY - g.sy); applyView(); return; }
  if (g.type === 'draw') { addDrawPoint(e); return; }
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  if (g.type === 'maybeTap') {
    g.buf.push(e);
    if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6) { const buf = g.buf; startTool(g.e0, ...toWorld(g.e0.clientX, g.e0.clientY)); for (const be of buf.slice(1)) addDrawPoint(be); }
    return;
  }
  if (g.sx != null) g.maxD = Math.max(g.maxD, Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy));
  if (g.type === 'erase') { for (const ce of coalesced(e)) { const [x, y] = toWorld(ce.clientX, ce.clientY); eraseAt(g.last[0], g.last[1], x, y); g.last = [x, y]; } }
  else if (g.type === 'lasso') { g.poly.push([wx, wy]); g.el.setAttribute('d', 'M' + g.poly.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L')); }
  else if (g.type === 'laser') { laserPts.push([wx, wy, performance.now()]); }
  else if (g.type === 'selMove') {
    const dx = wx - g.lx, dy = wy - g.ly; g.lx = wx; g.ly = wy; g.moved = true;
    for (const id of sel.ids) moveStroke(id, dx, dy);
    for (const gid of sel.gids) { const gr = graphById(gid); if (gr) { gr.x = Math.round(gr.x + dx); gr.y = Math.round(gr.y + dy); placeGraph(gr); } }
    if ((sel.iids || []).length) { for (const iid of sel.iids) { const im = doc.imgs.find(q => q.id === iid); if (im) { im.x = r1(im.x + dx); im.y = r1(im.y + dy); } } renderImgs(); }
    for (const id of sel.ids) { const s = doc.strokes[id]; if (s) renderStroke(s); }
    renderSelection(); renderOverlays(); renderChips();
  } else if (g.type === 'selScale') {
    const b0 = g.b0;
    const k = clamp(Math.max((wx - b0.x0) / Math.max(1, b0.w), (wy - b0.y0) / Math.max(1, b0.h)), 0.15, 8);
    for (const [id, pts, w] of g.orig) { const s = doc.strokes[id]; if (!s) continue; touch(id); s.pts = pts.map(p => [r1(b0.x0 + (p[0] - b0.x0) * k), r1(b0.y0 + (p[1] - b0.y0) * k), p[2]]); s.w = r2(w * (s.tool === 'hl' ? Math.sqrt(k) : k)); renderStroke(s); }
    if (g.origImgs && g.origImgs.length) { for (const o of g.origImgs) { const im = doc.imgs.find(q => q.id === o.id); if (!im) continue; im.x = r1(b0.x0 + (o.x - b0.x0) * k); im.y = r1(b0.y0 + (o.y - b0.y0) * k); im.w = r1(o.w * k); im.h = r1(o.h * k); } renderImgs(); }
    renderSelection(); renderOverlays(); renderChips();
  }
}
function endPointer(e, cancelled) { endPointerInner(e, cancelled); syncInking(); }
function endPointerInner(e, cancelled) {
  if (e.pointerType === 'touch') {
    if (palmIds.delete(e.pointerId)) return;
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    const g = gesture;
    if (g && g.type === 'pinch') { if (!touches.size) gesture = null; }
    else if (g && g.id === e.pointerId) { gesture = null; finishGesture(g, e, cancelled); }
    if (!touches.size) endTouchSequence(cancelled);
    return;
  }
  const g = gesture;
  if (!g || (g.id != null && g.id !== e.pointerId)) return;
  gesture = null;
  finishGesture(g, e, cancelled);
}
function finishGesture(g, e, cancelled) {
  if (g.type === 'pinch') return;
  if (g.type === 'pan') {
    if (!cancelled && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 8 && performance.now() - g.t0 < 350) tapPage(e, g);
    scheduleSave(); return;
  }
  if (g.type === 'maybeTap') { if (!cancelled) { if (g.hit) openPop(g.hit.l, g.hit.a); else openLineMenu(g.line); } return; }
  if (g.type === 'draw') { commitDraw(g, cancelled); return; }
  if ((g.type === 'erase' || g.type === 'lasso') && !cancelled && g.maxD < 8 && performance.now() - g.t0 < 320) {
    const [wx, wy] = toWorld(e.clientX, e.clientY), lg = lockedGraphAt(wx, wy);
    if (lg) { const now = performance.now(); if (lockTap && lockTap.gid === lg.id && now - lockTap.t < 400) { lockTap = null; if (g.type === 'lasso') g.el.remove(); else endTx(); toggleLock(lg); return; } lockTap = { t: now, gid: lg.id }; }
  }
  if (g.type === 'erase') { if (g.hit.size) { g.hit.forEach(id => removeStroke(id)); cleanupLines(); } endTx(); syncInk(); refresh(); scheduleIdle(); return; }
  if (g.type === 'lasso') { g.el.remove(); selectByLasso(g.poly); return; }
  if (g.type === 'laser') return;
  if (g.type === 'selMove' || g.type === 'selScale') {
    // line bookkeeping: partial moves make lines dirty
    for (const l of doc.lines) { const inSel = l.strokeIds.filter(id => sel.ids.includes(id)).length; if (inSel && inSel < l.strokeIds.length) lineChanged(l); }
    if (g.type === 'selScale') for (const l of doc.lines) if (l.strokeIds.some(id => sel.ids.includes(id))) l.charH = null;
    endTx(); refresh(); scheduleIdle(); markVisibleDirty();
  }
}
let pendingDot = null, lockTap = null;
function commitDraw(g, cancelled) {
  if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; }
  g.el.remove();
  if (!g.raw.length) return;
  const s = g.s;
  s.pts = finalizePts(g.raw);
  if (g.pointerType === 'pen') { const lp = s.pts[s.pts.length - 1]; lastPenEnd = { t: performance.now(), x: lp[0], y: lp[1], p: lp[2], cancelled }; }
  lastInkAt = performance.now();
  if (!cancelled && g.maxD < 8 && performance.now() - g.t0 < 320) {
    const [wx, wy] = s.pts[0], lg = lockedGraphAt(wx, wy);
    if (lg) {
      const p = pendingDot;
      if (p && p.gid === lg.id && performance.now() - p.t < 400 && Math.hypot(p.x - wx, p.y - wy) * view.s < 40) { pendingDot = null; clearTimeout(p.timer); p.el.remove(); toggleLock(lg); return; }
      flushPendingDot();
      const el = S('path'); gTemp.appendChild(el); styleStrokeEl(el, s);
      pendingDot = { s, t: performance.now(), x: wx, y: wy, gid: lg.id, el, timer: setTimeout(flushPendingDot, 400) };
      return;
    }
  }
  flushPendingDot();
  storeStroke(s);
}
function storeStroke(s) {
  transact(() => { addStroke(s); attachToLine(s); });
  renderStroke(s);
  if (s.tool !== 'hl') { scheduleIdle(); refresh(); }
}
function flushPendingDot() { const p = pendingDot; if (!p) return; pendingDot = null; clearTimeout(p.timer); p.el.remove(); storeStroke(p.s); }
// a quick tap on the page (finger in Pencil-only mode, or the hand tool)
function tapPage(e, g) {
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  const hit = hitAnchor(wx, wy);
  if (hit) { closeLineMenu(); openPop(hit.l, hit.a); lastTap = null; return; }
  if (pop) closePop();
  const line = lineAt(wx, wy, g.pointerType === 'touch');
  if (line) { lastTap = null; if (lmenu && lmenu.l === line) closeLineMenu(); else openLineMenu(line); return; }
  if (lmenu) { closeLineMenu(); lastTap = null; return; }
  const lg = lockedGraphAt(wx, wy);
  if (lg) {
    const now = performance.now();
    if (lastTap && lastTap.gid === lg.id && now - lastTap.t < 380 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 44) { lastTap = null; toggleLock(lg); }
    else lastTap = { t: now, x: e.clientX, y: e.clientY, gid: lg.id };
    return;
  }
  if (g.pointerType !== 'touch') return;
  if (sel) clearSelection();
  if (!inputPrefs.tapUndo || fingersDraw() || (tapT && tapT.n > 1)) return;
  const now = performance.now();
  if (lastTap && !lastTap.gid && now - lastTap.t < 340 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 44) { lastTap = null; doUndo(); }
  else lastTap = { t: now, x: e.clientX, y: e.clientY };
}
// two-finger tap = undo, three-finger tap = redo (like GoodNotes)
function endTouchSequence(cancelled) {
  const t = tapT; tapT = null;
  if (!t || cancelled || t.bad || t.moved || t.n < 2 || !inputPrefs.tapUndo) return;
  if (performance.now() - t.t0 > 400) return;
  view.tx = t.view0.tx; view.ty = t.view0.ty; view.s = t.view0.s; applyView();
  lastTap = null;
  if (t.n === 2) doUndo(); else if (t.n === 3) doRedo();
}
function doUndo() { if (!undoStack.length) { flash('Nothing to undo'); return; } undo(); flash('↶ Undo'); }
function doRedo() { if (!redoStack.length) { flash('Nothing to redo'); return; } redo(); flash('↷ Redo'); }
function flash(msg) {
  const f = $('#gflash'); if (!f) return;
  f.textContent = msg; f.classList.add('show');
  clearTimeout(flash.t); flash.t = setTimeout(() => f.classList.remove('show'), 750);
}

/* pencil hover preview (iPad Pro / Air with hover): a dot shows where the tip will land */
let hoverEl = null, hoverT = 0;
function showHover(e) {
  const t = ui.tool;
  if (!DRAW_TOOLS.has(t) && t !== 'eraser') return;
  const [x, y] = toWorld(e.clientX, e.clientY);
  if (!hoverEl) hoverEl = S('circle', { class: 'phover' });
  if (!hoverEl.isConnected) gTemp.appendChild(hoverEl);
  const r = t === 'eraser' ? WIDTHS.eraser[ui.width.eraser] / 2 : Math.max(1.3, WIDTHS[t][ui.width[t]] * 0.55);
  hoverEl.setAttribute('cx', x.toFixed(1)); hoverEl.setAttribute('cy', y.toFixed(1)); hoverEl.setAttribute('r', r.toFixed(1));
  hoverEl.setAttribute('class', t === 'eraser' ? 'phover ring' : 'phover');
  hoverEl.style.fill = t === 'eraser' ? 'none' : ui.color[t];
  hoverEl.style.strokeWidth = (1.2 / view.s).toFixed(2);
  hoverEl.style.display = '';
  clearTimeout(hoverT); hoverT = setTimeout(hideHover, 450);
}
function hideHover() { if (hoverEl) hoverEl.style.display = 'none'; }

/* pen ⇄ eraser: Apple Pencil double-tap (iPad app), the floating switch, or the E key */
let prevDrawTool = 'pen';
function toggleEraser() {
  if (ui.tool === 'eraser') setTool(DRAW_TOOLS.has(prevDrawTool) || prevDrawTool === 'lasso' ? prevDrawTool : 'pen');
  else setTool('eraser');
  flash(ui.tool === 'eraser' ? 'Eraser' : ({ pen: 'Pen', pencil: 'Pencil', hl: 'Highlighter', lasso: 'Lasso' })[ui.tool] || 'Pen');
}
// hook for the native iPad app shell: it forwards UIPencilInteraction double-taps / squeezes here
window.LiveMath = Object.assign(window.LiveMath || {}, { pencilDoubleTap: toggleEraser, undo: doUndo, redo: doRedo });
function openKeyDialog() {
  const d = $('#keyDlg'), inp = $('#keyIn'), has = !!apiKey();
  inp.value = ''; inp.placeholder = has ? 'A key is saved on this device · type a new one to replace it' : 'sk-ant-…';
  d.querySelector('[data-k="remove"]').hidden = !has; d.hidden = false; setTimeout(() => inp.focus(), 50);
}
if ($('#keyDlg')) {
  $('#keyDlg').addEventListener('pointerdown', e => e.stopPropagation());
  $('#keyDlg').addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b && e.target.id !== 'keyDlg') return;
    const k = b ? b.dataset.k : 'cancel', d = $('#keyDlg');
    if (k === 'save') { const v = $('#keyIn').value.trim(); if (!v) return; try { localStorage.setItem(KEY_STORE, v); } catch (err) { } }
    if (k === 'remove') { try { localStorage.removeItem(KEY_STORE); } catch (err) { } }
    $('#keyIn').value = ''; d.hidden = true;
    if (k === 'save' || k === 'remove') {
      samplerP = null; getSampler();
      for (const l of doc.lines) if (l.status === 'unavailable') { l.status = 'idle'; l.dirty = true; }
      scheduleIdle(120); refresh();
      toast(k === 'save' ? 'Key saved on this device · reading is on' : 'Key removed from this device');
    }
  });
  $('#keyIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#keyDlg [data-k="save"]').click(); } if (e.key === 'Escape') $('#keyDlg [data-k="cancel"]').click(); });
}
document.querySelectorAll('[data-standalone]').forEach(el => { el.hidden = !STANDALONE; });
function updateQuickSwitch() {
  const qs = $('#quickSwitch'); if (!qs) return;
  qs.hidden = !(penSeen && inputPrefs.quickSwitch);
  const back = ui.tool === 'eraser' ? prevDrawTool : ui.tool;
  const src = document.querySelector(`#bar [data-tool="${DRAW_TOOLS.has(back) || back === 'lasso' ? back : 'pen'}"] svg`);
  const a = qs.querySelector('.qs-a');
  if (src && a.dataset.t !== back) { a.innerHTML = src.outerHTML; a.dataset.t = back; }
  a.classList.toggle('on', ui.tool !== 'eraser');
  qs.querySelector('.qs-b').classList.toggle('on', ui.tool === 'eraser');
}
function updateInputUI() {
  updateQuickSwitch();
  const set = (k, v) => { const b = document.querySelector(`[data-do="${k}"]`); if (b) b.setAttribute('aria-checked', String(v)); };
  set('pencilonly', !fingersDraw());
  set('tapundo', !!inputPrefs.tapUndo);
  set('qswitch', !!inputPrefs.quickSwitch);
}
function eraseAt(x0, y0, x1, y1) {
  const r = WIDTHS.eraser[ui.width.eraser] / 2;
  for (const id of doc.order) {
    if (gesture.hit.has(id)) continue;
    const s = doc.strokes[id]; if (!s) continue;
    const b = bbox(s), rr = r + s.w / 2 + 1;
    if (Math.max(x0, x1) < b.x0 - rr || Math.min(x0, x1) > b.x1 + rr || Math.max(y0, y1) < b.y0 - rr || Math.min(y0, y1) > b.y1 + rr) continue;
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i], q = s.pts[Math.min(s.pts.length - 1, i + 1)];
      if (segDist(p[0], p[1], q[0], q[1], x0, y0, x1, y1) < rr) { gesture.hit.add(id); const el = strokeEls.get(id); if (el) el.style.opacity = '0.12'; break; }
    }
  }
}
function segDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const pd = (px, py, x1, y1, x2, y2) => { const vx = x2 - x1, vy = y2 - y1, L = vx * vx + vy * vy; let t = L ? ((px - x1) * vx + (py - y1) * vy) / L : 0; t = clamp(t, 0, 1); return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)); };
  return Math.min(pd(ax, ay, cx, cy, dx, dy), pd(bx, by, cx, cy, dx, dy), pd(cx, cy, ax, ay, bx, by), pd(dx, dy, ax, ay, bx, by));
}
viewport.addEventListener('wheel', e => {
  if (e.target.closest('.graph') && (e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
  else { view.tx -= e.deltaX; view.ty -= e.deltaY; applyView(); }
}, { passive: false });

/* laser pointer */
const laserPts = []; let laserRaf = 0;
function startLaser() { if (!laserRaf) laserRaf = requestAnimationFrame(laserFrame); }
function laserFrame() {
  laserRaf = 0;
  const now = performance.now();
  while (laserPts.length && now - laserPts[0][2] > 650) laserPts.shift();
  let el = $('#laser');
  if (!el) { el = S('path', { id: 'laser' }); gTemp.appendChild(el); }
  el.setAttribute('d', laserPts.length ? 'M' + laserPts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') : '');
  el.setAttribute('stroke-width', 5 / view.s);
  if (laserPts.length || (gesture && gesture.type === 'laser')) laserRaf = requestAnimationFrame(laserFrame);
}

/* ---------- overlays in screen space ---------- */
function positionOverlays() {
  if (lmenu) positionLineMenu();
  if (pop) {
    const el = $('#pop');
    let b = pop.a.ci && pop.a.ci.length ? anchorBB(pop.l, pop.a) : lineBB(pop.l);
    if (!isFinite(b.x0)) b = lineBB(pop.l);
    const [sx, sy] = toScreen(b.cx, b.y0);
    const w = el.offsetWidth || 280, h = el.offsetHeight || 96;
    el.style.left = clamp(sx - w / 2, 8, window.innerWidth - w - 8) + 'px';
    el.style.top = (sy - h - 14 < 60 ? toScreen(b.cx, b.y1)[1] + 14 : sy - h - 14) + 'px';
  }
  if (sel) {
    const b = selBB(); const m = $('#selmenu');
    if (b) {
      const [sx, sy] = toScreen(b.x0, b.y0);
      const w = m.offsetWidth || 320;
      m.style.left = clamp(sx, 8, window.innerWidth - w - 8) + 'px';
      m.style.top = Math.max(60, sy - 54) + 'px';
    }
    gTemp.querySelectorAll('.sel-handle').forEach(c => c.setAttribute('r', 8 / view.s));
  }
}

/* ---------- refresh ---------- */
let refreshRaf = 0;
function refresh() { if (!refreshRaf) refreshRaf = requestAnimationFrame(() => { refreshRaf = 0; doRefresh(); }); }
function doRefresh() {
  syncVirtuals();
  computeScope();
  syncInk();
  renderOverlays();
  renderChips();
  renderGraphs();
  positionOverlays();
  scheduleSave();
  updateReadStatus();
  if (lmenu) { const m = $('#lineMenu .lm-math'); if (m && loopState(lmenu.l) === 'ok' && !lmenu.tx) m.innerHTML = lineMathHTML(lmenu.l, anOf(lmenu.l)); }
  if (currentNb != null) markVisibleDirty();
}
function renderAll() { renderPages(); syncInk(true); doRefresh(); markPaperMenu(); renderSidebar(true); updatePageUI(); }

/* ---------- save / load ---------- */
let saveT = 0;
let lastSaveAt = 0;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(() => { if (gesture || (performance.now() - lastInkAt < 900 && performance.now() - lastSaveAt < 8000)) { scheduleSave(); return; } saveNow(); }, 700); }
function loadDoc(d) {
  const base = newDoc(); if (!Array.isArray(d.pageList)) delete base.pageList;
  doc = normalizeDoc(Object.assign(base, d));
  bbCache.clear(); anCache.clear();
  for (const id of [...strokeEls.keys()]) { strokeEls.get(id).remove(); strokeEls.delete(id); }
  for (const l of doc.lines) { if (l.status === 'reading' || l.status === 'pending') { l.status = 'stale'; l.dirty = true; } }
  for (const [, ge] of graphEls) ge.el.remove(); graphEls.clear();
  for (const [, el] of chipEls) el.remove(); chipEls.clear();
  undoStack.length = 0; redoStack.length = 0; updateUndo();
  clearSelection(); closePop();
  renderAll();
}

/* ---------- example pages ---------- */
function addGlyphStrokes(lay, color, w = 2.6) {
  const ids = [];
  for (const g of lay.glyphs) for (const st of g.strokes) { const s = { id: uid(), tool: 'pen', color, w, pts: st.map(p => [r1(p[0]), r1(p[1]), r2(p[2])]) }; addStroke(s); ids.push(s.id); }
  return ids;
}
function writeLine(text, x, y, h, seed, color = INK[0], w = 2.6) {
  const lay = HandFont.layout(text, x, y, h, seed);
  const clusters = lay.glyphs.map(g => ({ ids: addGlyphStrokes({ glyphs: [g] }, color, w), text: g.ch }));
  const l = { id: uid(), strokeIds: clusters.flatMap(c => c.ids), clusters, expr: '', status: 'ok', dirty: false, ver: 1, colorIdx: null, anchors: [] };
  l.strokeIds.forEach(id => { doc.strokes[id].lineId = l.id; });
  doc.lines.push(l);
  return l;
}
function writeColumn(rows, right, top, h, seed, color = INK[0]) {
  const clusters = [];
  const numW = Math.max(...rows.map(r => HandFont.advance(r.replace(/^[+×÷-]/, ''), h)));
  const opX = right - numW - 0.8 * h;
  rows.forEach((row, i) => {
    const y = top + i * 1.45 * h, m = row.match(/^([+×÷-])?(.*)$/);
    if (m[1]) clusters.push({ ids: addGlyphStrokes(HandFont.layout(m[1], opX, y, h, seed + i * 7), color), text: m[1], role: 'op' });
    clusters.push({ ids: addGlyphStrokes(layoutRight(m[2], right, y, h, seed + i * 13), color), text: m[2], role: 'num' });
  });
  const by = top + (rows.length - 1) * 1.45 * h + h + 0.42 * h, x0 = opX - 0.3 * h, x1 = right + 0.35 * h;
  const bar = { id: uid(), tool: 'pen', color, w: 2.6, pts: [] };
  for (let k = 0; k <= 18; k++) { const t = k / 18; bar.pts.push([r1(x0 + (x1 - x0) * t), r1(by + Math.sin(t * 3) * 1.1 + t * 1.6), r2(0.45 + 0.45 * Math.sin(Math.PI * t))]); }
  addStroke(bar);
  clusters.push({ ids: [bar.id], text: '_', role: 'bar' });
  const l = { id: uid(), layout: 'column', barId: bar.id, strokeIds: clusters.flatMap(c => c.ids), clusters, expr: '', status: 'ok', dirty: false, ver: 1, colorIdx: null, anchors: [] };
  l.strokeIds.forEach(id => { doc.strokes[id].lineId = l.id; });
  doc.lines.push(l);
  return l;
}
const G0 = () => ({ d: false, tan: false, area: false, riem: false, anti: false, floor: false, tp: false });
function buildExamplePages(oy) { buildCalcPage(oy); build3DPage(oy + PAGE_H + PAGE_GAP); }
function buildCalcPage(oy) {
  // Page A: one-variable calculus
  const hl = { id: uid(), tool: 'hl', color: HLC[0], w: 22, pts: [] };
  for (let x = 60; x <= 318; x += 6) hl.pts.push([x, oy + 96 + Math.sin(x / 40) * 1.2, 0.5]);
  addStroke(hl);
  const L1 = writeLine('y = x^3 - 3x', 70, oy + 70, 40, 11);
  applyReading(L1, 'y = x^3 - 3*x', L1.clusters); L1.colorIdx = 0;
  doc.graphs.push({ id: uid(), x: 64, y: oy + 140, w: 480, h: 340, lineIds: [L1.id], view: { x0: -3.2, x1: 3.2, y0: -4.2, y1: 4.2 }, mode: 'surface', show: Object.assign(G0(), { d: true, tan: true, area: true }), px: 1, py: 0.5, cam: null, x0: 1.4, a: -1.5, b: 0, n: 8, method: 'mid', C: 0 });
  const L3 = writeLine('12 × 7 =', 592, oy + 150, 30, 5); applyReading(L3, '12*7 =', L3.clusters);
  const L4 = writeLine('2x + 3 = 11', 592, oy + 228, 30, 9); applyReading(L4, '2*x + 3 = 11', L4.clusters);
  const L5 = writeLine('a = 2', 592, oy + 306, 30, 13); applyReading(L5, 'a = 2', L5.clusters);
  const L2 = writeLine('r = a cos(3θ)', 70, oy + 548, 38, 17, INK[1]);
  applyReading(L2, 'r = a*cos(3*θ)', L2.clusters); L2.colorIdx = 1;
  doc.graphs.push({ id: uid(), x: 64, y: oy + 614, w: 360, h: 360, lineIds: [L2.id], view: { x0: -2.6, x1: 2.6, y0: -2.35, y1: 2.35 }, mode: 'surface', show: G0(), px: 1, py: 0.5, cam: null, x0: 1, a: -1, b: 1, n: 8, method: 'mid', C: 0 });
  const L6 = writeLine('x^2 + y^2 = 9', 470, oy + 690, 32, 21, INK[3]);
  applyReading(L6, 'x^2 + y^2 = 9', L6.clusters);
}
function build3DPage(pb) {
  // Page B: multivariable + column arithmetic
  const S1 = writeLine('z = x^2 - y^2', 70, pb + 64, 40, 31, INK[4]);
  applyReading(S1, 'z = x^2 - y^2', S1.clusters); S1.colorIdx = 3;
  doc.graphs.push({ id: uid(), x: 64, y: pb + 136, w: 500, h: 440, lineIds: [S1.id], view: { x0: -2, x1: 2, y0: -2, y1: 2 }, mode: 'surface', show: Object.assign(G0(), { floor: true, tp: true }), px: 1, py: 0.5, cam: { yaw: -0.62, pitch: 0.5, zoom: 1 }, x0: 1, a: -1, b: 1, n: 8, method: 'mid', C: 0 });
  const C1 = writeColumn(['12', '×12'], 760, pb + 96, 32, 41); applyReading(C1, '12*12', C1.clusters);
  const C2 = writeColumn(['12', '×12', '×12'], 760, pb + 300, 32, 43); applyReading(C2, '12*12*12', C2.clusters);
  const C3 = writeColumn(['345', '+78'], 760, pb + 556, 32, 47); applyReading(C3, '345+78', C3.clusters);
  const S2 = writeLine('x^2 + y^2 + z^2 = 9', 70, pb + 640, 32, 37, INK[1]);
  applyReading(S2, 'x^2 + y^2 + z^2 = 9', S2.clusters); S2.colorIdx = 1;
  doc.graphs.push({ id: uid(), x: 64, y: pb + 700, w: 420, h: 330, lineIds: [S2.id], view: { x0: -4, x1: 4, y0: -4, y1: 4 }, mode: 'surface', show: G0(), px: 1, py: 0.5, cam: { yaw: -0.62, pitch: 0.45, zoom: 1.05 }, x0: 1, a: -1, b: 1, n: 8, method: 'mid', C: 0 });
  const S3 = writeLine('(cos(t), sin(t), t)', 530, pb + 760, 28, 53, INK[2]);
  applyReading(S3, '(cos(t), sin(t), t)', S3.clusters);
  for (const l of doc.lines) computeAnchors(l);
}

/* ---------- toolbar ---------- */
function setTool(t) {
  if (t === 'eraser' && ui.tool !== 'eraser') prevDrawTool = ui.tool;
  ui.tool = t;
  hideHover();
  document.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  viewport.dataset.tool = t;
  renderSwatches();
  if (t !== 'lasso') clearSelection();
  updateQuickSwitch();
}
function renderSwatches() {
  const t = ui.tool;
  const sw = $('#swatches'), wd = $('#widths');
  const cols = t === 'pen' ? INK : t === 'pencil' ? PENCIL : t === 'hl' ? HLC : null;
  sw.innerHTML = cols ? cols.map((c, i) => `<button class="sw" data-c="${c}" style="--c:${c}" aria-label="Color ${i + 1}" aria-pressed="${ui.color[t] === c}"></button>`).join('') : '';
  const ws = WIDTHS[t];
  wd.innerHTML = ws ? ws.map((w, i) => `<button class="wd" data-w="${i}" aria-label="${['Thin', 'Medium', 'Thick'][i]}" aria-pressed="${ui.width[t] === i}"><span style="--d:${4 + i * 4}px"></span></button>`).join('') : '';
  sw.hidden = !cols; wd.hidden = !ws;
}
$('#swatches').addEventListener('click', e => { const b = e.target.closest('.sw'); if (!b) return; ui.color[ui.tool] = b.dataset.c; renderSwatches(); });
$('#widths').addEventListener('click', e => { const b = e.target.closest('.wd'); if (!b) return; ui.width[ui.tool] = Number(b.dataset.w); renderSwatches(); });
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#autoread').onclick = () => { ui.autoRead = !ui.autoRead; renderReadPill(); scheduleSave(); if (ui.autoRead) { getSampler(); onIdle(); } };
function closeMenus() { document.querySelectorAll('.menu').forEach(m => { m.hidden = true; }); document.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false')); }
function toggleMenu(btn, menu) {
  const open = menu.hidden; closeMenus();
  if (open) { const r = btn.getBoundingClientRect(); menu.style.top = (r.bottom + 6) + 'px'; menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px'; }
  menu.hidden = !open; btn.setAttribute('aria-expanded', String(open));
}
$('#paperBtn').onclick = e => { e.stopPropagation(); toggleMenu($('#paperBtn'), $('#paperMenu')); };
$('#moreBtn').onclick = e => { e.stopPropagation(); toggleMenu($('#moreBtn'), $('#moreMenu')); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.menu, #paperBtn, #moreBtn, #newBtn, #graphBtn, .more, #libFolderMenu')) closeMenus(); if (lmenu && e.target.closest('#bar, #sidebar, #home')) closeLineMenu(); });
$('#paperMenu').addEventListener('click', e => { const all = e.target.closest('[data-tplall]'); if (all) { const p = doc.pageList[currentPage()]; setTemplate(p ? p.t : doc.template, true); closeMenus(); toast('Every page now uses this paper'); return; } const b = e.target.closest('[data-tpl]'); if (!b) return; setTemplate(b.dataset.tpl); closeMenus(); });
function markPaperMenu() { const p = doc.pageList && doc.pageList[currentNb != null ? currentPage() : 0]; const t = p ? p.t : doc.template; document.querySelectorAll('[data-tpl]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tpl === t))); }
$('#addPage').onclick = e => { e.stopPropagation(); openPageMenu(e.currentTarget, doc.pages); };
$('#selmenu').addEventListener('pointerdown', e => e.stopPropagation());
$('#selmenu').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; selAction(b.dataset.act, b.dataset.c); });
$('#selColors').innerHTML = INK.map(c => `<button class="sw" data-act="color" data-c="${c}" style="--c:${c}" aria-label="Recolor"></button>`).join('');
// popover
$('#pop').addEventListener('pointerdown', e => e.stopPropagation());
let popSl = null;
function popSlider() { if (!popSl) popSl = makeInfSlider($('#popSlider'), { value: 0, step: 1, label: 'Value', onInput: v => { if (pop) { pop.playing = false; pop.raw = null; setPopValue(v); } } }); return popSl; }
$('#popSteps').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || !pop) return; pop.step = Number(b.dataset.step); syncPop(); });
$('#popPlay').onclick = () => { if (!pop) return; pop.playing = !pop.playing; if (pop.playing) { const [lo, hi] = popSlider().win(); pop.min = lo; pop.max = hi; } pop.last = 0; pop.raw = pop.v; if (pop.step >= 1 && pop.playing) pop.step = 0.1; syncPop(); if (pop.playing) requestAnimationFrame(playLoop); };
$('#popClose').onclick = closePop;
// keyboard
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); return; }
  if (e.key === 'Escape') { closeMenus(); closeLineMenu(); }
  if (e.target.closest('input, textarea, select') || $('#nbview').hidden || !$('#sheet').hidden) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); selAction('delete'); }
  else if (e.key === 'Escape') { closePop(); clearSelection(); closeMenus(); }
  else if (e.key === ' ') { spaceDown = true; viewport.classList.add('panning'); }
  else if (!mod && !e.altKey && e.key.toLowerCase() === 'e') toggleEraser();
  else if (!mod && !e.altKey && e.key.toLowerCase() === 'g') insertBlankGraph({ d3: e.shiftKey });
  else if (!mod && !e.altKey) { const map = { p: 'pen', n: 'pencil', h: 'hl', l: 'lasso', k: 'laser' }; if (map[e.key]) setTool(map[e.key]); }
});
window.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; viewport.classList.remove('panning'); } });
window.addEventListener('resize', () => positionOverlays());

/* ---------- export / files ---------- */
let downloads = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600); }
const MIME = { pdf: 'application/pdf', png: 'image/png', json: 'application/json' };
async function saveOnDevice({ filename, data }) {
  const ext = (filename.split('.').pop() || '').toLowerCase(), type = MIME[ext] || 'application/octet-stream';
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  if (NATIVE) { window.webkit.messageHandlers.lmnSave.postMessage({ filename, type, data: await blobB64(blob) }); return; }
  const file = new File([blob], filename, { type: blob.type || type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') throw Object.assign(new Error('declined'), { code: 'declined' }); }
  }
  const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000);
}
async function initDownloads() {
  try { downloads = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { downloads = null; }
  if (!downloads && STANDALONE) downloads = { save: saveOnDevice };
  document.querySelectorAll('[data-needs="downloads"]').forEach(b => { b.hidden = !downloads; });
}
function currentPage() { const r = viewport.getBoundingClientRect(); const [, wy] = toWorld(r.left + r.width / 2, r.top + r.height / 2); return clamp(Math.floor(wy / (PAGE_H + PAGE_GAP)), 0, doc.pages - 1); }
async function exportPage() {
  const pi = currentPage(), oy = pageY(pi), k = 2;
  const cv = document.createElement('canvas'); cv.width = PAGE_W * k; cv.height = PAGE_H * k;
  const c = cv.getContext('2d'); c.scale(k, k); c.translate(0, -oy);
  drawPageBase(c, doc.pageList[pi], oy);
  drawPageContent(c, doc, oy, true);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  const m = nbMeta(currentNb), base = (m ? m.title : 'math-notes').replace(/[^\w\- ]+/g, '').trim() || 'math-notes';
  try { await downloads.save({ filename: `${base} page ${pi + 1}.png`, data: blob }); toast('Page saved'); }
  catch (e) { if (e && e.code !== 'declined') toast('Couldn’t save the image here'); }
}
$('#moreMenu').addEventListener('click', async e => {
  const b = e.target.closest('[data-do]'); if (!b) return;
  const act = b.dataset.do;
  if (act === 'pencilonly') { inputPrefs.pencilOnly = fingersDraw(); saveInputPrefs(); updateInputUI(); toast(fingersDraw() ? 'Fingers can draw again' : 'Only the pencil writes. Fingers scroll, zoom and tap.'); return; }
  if (act === 'tapundo') { inputPrefs.tapUndo = !inputPrefs.tapUndo; saveInputPrefs(); updateInputUI(); toast(inputPrefs.tapUndo ? 'Double-tap or two-finger tap to undo, three-finger tap to redo' : 'Tap gestures are off'); return; }
  if (act === 'qswitch') { inputPrefs.quickSwitch = !inputPrefs.quickSwitch; saveInputPrefs(); updateInputUI(); return; }
  if (act === 'autograph') { ui.autoGraph = !ui.autoGraph; b.setAttribute('aria-checked', String(ui.autoGraph)); scheduleSave(); toast(ui.autoGraph ? 'New functions will be graphed automatically' : 'Tap a function to graph it'); return; }
  if (act === 'clear') {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to clear every page'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Clear notebook'; }, 3000); return; }
    b.dataset.armed = ''; b.textContent = 'Clear notebook';
    const keep = { pages: 2, template: doc.template };
    loadDoc(Object.assign(newDoc(), keep)); toast('Notebook cleared. Undo isn’t available for this.');
  }
  closeMenus();
  if (act === 'example') {
    const oy = pageY(doc.pages);
    transact(() => { doc.pageList.push({ t: 'grid' }, { t: 'grid' }); doc.pages = doc.pageList.length; buildExamplePages(oy); });
    renderAll();
    const r = viewport.getBoundingClientRect(); view.ty = 16 - oy * view.s; applyView();
    toast('Example pages added at the end');
  }
  else if (act === 'png') exportPage();
  else if (act === 'save') { const m = nbMeta(currentNb); const base = (m ? m.title : 'math-notebook').replace(/[^\w\- ]+/g, '').trim() || 'math-notebook'; try { await downloads.save({ filename: base + '.json', data: JSON.stringify({ title: m ? m.title : 'Notebook', cover: m ? m.cover : 'aqua', doc }) }); toast('Notebook file saved'); } catch (e2) { if (e2 && e2.code !== 'declined') toast('Couldn’t save the file here'); } }
  else if (act === 'open') { importTarget = 'notebook'; $('#openFile').click(); }
  else if (act === 'apikey') openKeyDialog();
  else if (act === 'page') { openPageMenu($('#moreBtn'), currentPage() + 1); }
  else if (act === 'pdf') exportPdf(null);
  else if (act === 'fit') fitWidth();
});
$('#openFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try {
    const raw = JSON.parse(await f.text());
    const d = raw && raw.doc ? raw.doc : raw;
    if (!d || !d.strokes || !Array.isArray(d.order)) throw new Error('bad');
    const title = (raw.title || f.name.replace(/\.json$/i, '') || 'Imported notebook').slice(0, 80);
    const folderId = importTarget === 'library' ? libFolder : (nbMeta(currentNb) || {}).folderId;
    if (currentNb != null) closeNotebook();
    const base = newDoc(); if (!Array.isArray(d.pageList)) delete base.pageList;
    const m = addNotebook(title, folderId, raw.cover || 'mint', normalizeDoc(Object.assign(base, d)));
    saveLib(); openNotebook(m.id); toast('Notebook opened');
  }
  catch (err) { toast('That file isn’t a notebook saved from this app'); }
  e.target.value = '';
});
$('#hintClose').onclick = () => { $('#hint').hidden = true; try { localStorage.setItem(STORE_KEY + ':hint', '0'); } catch (e) { } };

/* ---------- storage: IndexedDB with localStorage fallback ---------- */
const kv = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise(res => {
    try { const r = indexedDB.open('live-math-notebook', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null); }
    catch (e) { res(null); }
  }));
  const req = (db, mode, fn) => new Promise((res, rej) => { try { const t = db.transaction('kv', mode); const q = fn(t.objectStore('kv')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); } catch (e) { rej(e); } });
  return {
    async get(k) { const db = await open(); if (db) { try { const v = await req(db, 'readonly', s => s.get(k)); if (v !== undefined) return v; } catch (e) { } } try { return localStorage.getItem('kv:' + k); } catch (e) { return null; } },
    async set(k, v) { const db = await open(); if (db) { try { await req(db, 'readwrite', s => s.put(v, k)); return true; } catch (e) { } } try { localStorage.setItem('kv:' + k, v); return true; } catch (e) { toast('Storage is full. Save a notebook file, then delete notebooks you don’t need.'); return false; } },
    async del(k) { const db = await open(); if (db) { try { await req(db, 'readwrite', s => s.delete(k)); } catch (e) { } } try { localStorage.removeItem('kv:' + k); } catch (e) { } },
    async delPrefix(p) {
      const db = await open();
      if (db) { try { const keys = await req(db, 'readonly', s => s.getAllKeys()); for (const k of keys) if (String(k).startsWith(p)) await req(db, 'readwrite', s => s.delete(k)); } catch (e) { } }
      try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('kv:' + p)) localStorage.removeItem(k); } } catch (e) { }
    }
  };
})();

/* ---------- pages: per-page paper, bookmarks, backgrounds ---------- */
const STEP = PAGE_H + PAGE_GAP;
const pageOfY = y => clamp(Math.floor(y / STEP), 0, Math.max(0, doc.pages - 1));
function normalizeDoc(d) {
  if (!Array.isArray(d.pageList)) d.pageList = [];
  const want = Math.max(1, d.pages || d.pageList.length || 1);
  while (d.pageList.length < want) d.pageList.push({ t: d.template || 'grid' });
  d.pages = d.pageList.length;
  if (!Array.isArray(d.imgs)) d.imgs = [];
  return d;
}
const imgData = new Map(), imgEls = new Map();
const imgKey = (nb, key) => `img:${nb}:${key}`;
const newImgKey = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function docImageKeys(d) { const ks = new Set(); (d.pageList || []).forEach(p => p.bg && ks.add(p.bg.key)); (d.imgs || []).forEach(i => ks.add(i.key)); return [...ks]; }
function imgEl(key) {
  if (imgEls.has(key)) return Promise.resolve(imgEls.get(key));
  const src = imgData.get(key); if (!src) return Promise.resolve(null);
  return new Promise(res => { const im = new Image(); im.onload = () => { imgEls.set(key, im); res(im); }; im.onerror = () => res(null); im.src = src; });
}
async function loadImages(nb, d) {
  await Promise.all(docImageKeys(d).map(async k => { if (!imgData.has(k)) { const v = await kv.get(imgKey(nb, k)); if (v) imgData.set(k, v); } await imgEl(k); }));
}
async function putImage(key, src) { imgData.set(key, src); await imgEl(key); return kv.set(imgKey(currentNb, key), src); }
function drawPageBase(c, p, oy) {
  p = p || { t: 'grid' };
  c.fillStyle = '#fff'; c.fillRect(0, oy, PAGE_W, PAGE_H);
  if (p.bg) { const im = imgEls.get(p.bg.key); if (im) c.drawImage(im, p.bg.x, oy + p.bg.y, p.bg.w, p.bg.h); }
  drawPaper(c, p.t, oy, true);
}
function renderImgs() {
  gImg.innerHTML = '';
  for (const im of doc.imgs) { const src = imgData.get(im.key); if (!src) continue; gImg.appendChild(S('image', { href: src, x: im.x, y: im.y, width: im.w, height: im.h, preserveAspectRatio: 'none', class: 'pimg' })); }
}
function pagePositions() {
  const sp = new Map(), gp = new Map(), ip = new Map();
  for (const id of doc.order) { const s = doc.strokes[id]; if (s) sp.set(id, pageOfY(bbox(s).cy)); }
  for (const g of doc.graphs) gp.set(g.id, pageOfY(g.y + g.h / 2));
  for (const im of doc.imgs) ip.set(im.id, pageOfY(im.y + im.h / 2));
  return { sp, gp, ip };
}
function afterPageOp() { closePop(); clearSelection(); bbCache.clear(); renderPages(); syncInk(true); refresh(); thumbCache.clear(); renderSidebar(true); updatePageUI(); requestAnimationFrame(() => requestAnimationFrame(drawDirtyThumbs)); }
function insertPages(at, list) {
  transact(() => {
    const { sp, gp, ip } = pagePositions(), n = list.length, dy = n * STEP;
    for (const [id, p] of sp) if (p >= at) moveStroke(id, 0, dy);
    for (const g of doc.graphs) if (gp.get(g.id) >= at) g.y += dy;
    for (const im of doc.imgs) if (ip.get(im.id) >= at) im.y += dy;
    doc.pageList.splice(at, 0, ...list);
    doc.pages = doc.pageList.length;
  });
  afterPageOp();
}
function deletePages(list) {
  list = [...new Set(list)].sort((a, b) => a - b); if (!list.length) return;
  const del = new Set(list), before = p => list.filter(d => d < p).length;
  transact(() => {
    const { sp, gp, ip } = pagePositions();
    for (const [id, p] of sp) { if (del.has(p)) removeStroke(id); else if (before(p)) moveStroke(id, 0, -before(p) * STEP); }
    doc.graphs = doc.graphs.filter(g => !del.has(gp.get(g.id))); doc.graphs.forEach(g => { g.y -= before(gp.get(g.id)) * STEP; });
    doc.imgs = doc.imgs.filter(im => !del.has(ip.get(im.id))); doc.imgs.forEach(im => { im.y -= before(ip.get(im.id)) * STEP; });
    doc.pageList = doc.pageList.filter((_, i) => !del.has(i));
    if (!doc.pageList.length) doc.pageList.push({ t: doc.template || 'grid' });
    doc.pages = doc.pageList.length;
    cleanupLines();
  });
  afterPageOp();
  toast(`Deleted ${list.length} ${list.length === 1 ? 'page' : 'pages'}. Undo brings ${list.length === 1 ? 'it' : 'them'} back.`);
}
function duplicatePages(list) {
  list = [...new Set(list)].sort((a, b) => a - b); if (!list.length) return;
  const dup = new Set(list), shiftOf = p => list.filter(j => j < p).length;
  transact(() => {
    const { sp, gp, ip } = pagePositions();
    for (const [id, p] of sp) if (shiftOf(p)) moveStroke(id, 0, shiftOf(p) * STEP);
    for (const g of doc.graphs) g.y += shiftOf(gp.get(g.id)) * STEP;
    for (const im of doc.imgs) im.y += shiftOf(ip.get(im.id)) * STEP;
    const sMap = new Map(), lMap = new Map();
    for (const [id, p] of sp) if (dup.has(p)) { const s = doc.strokes[id]; const c = clone(s); c.id = uid(); c.lineId = null; c.pts = c.pts.map(q => [q[0], r1(q[1] + STEP), q[2]]); addStroke(c); sMap.set(id, c.id); }
    for (const l of [...doc.lines]) {
      if (!l.strokeIds.length || !l.strokeIds.every(id => sMap.has(id))) continue;
      const c = clone(l); c.id = uid(); c.strokeIds = l.strokeIds.map(id => sMap.get(id)); c.clusters = (l.clusters || []).map(cl => Object.assign({}, cl, { ids: cl.ids.map(id => sMap.get(id)) }));
      if (l.barId) c.barId = sMap.get(l.barId); c.noAutoGraph = true;
      doc.lines.push(c); c.strokeIds.forEach(id => { if (doc.strokes[id]) doc.strokes[id].lineId = c.id; }); lMap.set(l.id, c.id);
    }
    for (const g of [...doc.graphs]) if (dup.has(gp.get(g.id))) { const c = clone(g); c.id = uid(); c.y = g.y + STEP; c.lineIds = g.lineIds.map(id => lMap.get(id)).filter(Boolean); doc.graphs.push(c); }
    for (const im of [...doc.imgs]) if (dup.has(ip.get(im.id))) doc.imgs.push(Object.assign({}, im, { id: uid(), y: im.y + STEP }));
    const pl = []; doc.pageList.forEach((p, i) => { pl.push(p); if (dup.has(i)) pl.push(clone(p)); });
    doc.pageList = pl; doc.pages = pl.length;
  });
  afterPageOp();
  toast(`Duplicated ${list.length} ${list.length === 1 ? 'page' : 'pages'}`);
}
function setBookmarks(list, on) { transact(() => { list.forEach(i => { if (doc.pageList[i]) doc.pageList[i].bm = on; }); }); renderPages(); renderSidebar(true); updatePageUI(); }
function goToPage(i) {
  i = clamp(i, 0, doc.pages - 1);
  view.ty = 16 - pageY(i) * view.s; applyView();
  if (window.innerWidth <= 760) setSidebar(false);
}
function addPageAt(at, t) { insertPages(at, [{ t }]); goToPage(at); toast(`Added a ${({ blank: 'blank', grid: 'graph paper', lined: 'lined', dots: 'dot grid' })[t]} page`); }

/* ---------- sidebar ---------- */
const sb = { tab: 'all', select: false, chosen: new Set(), dirty: new Set(), t: 0 };
const thumbCache = new Map();
function paintThumb(i) { const cc = thumbCache.get(i), cv = document.querySelector(`.pthumb[data-page="${i}"] canvas`); if (cc && cv) { const c = cv.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(cc, 0, 0); } }
function setSidebar(open) { ui.sidebar = open; $('#sidebar').hidden = !open; $('#sbToggle').setAttribute('aria-pressed', String(open)); if (open) renderSidebar(true); scheduleSave(); requestAnimationFrame(positionOverlays); }
function renderSidebar(full) {
  if ($('#sidebar').hidden || currentNb == null) return;
  const grid = $('#sbGrid');
  const idx = [...Array(doc.pages).keys()].filter(i => sb.tab === 'all' || doc.pageList[i].bm);
  for (const i of [...sb.chosen]) if (i >= doc.pages) sb.chosen.delete(i);
  const sig = idx.join(',') + '|' + sb.select + '|' + [...sb.chosen].join(',') + '|' + idx.map(i => doc.pageList[i].bm ? 1 : 0).join('');
  if (full || grid.dataset.sig !== sig) {
    grid.dataset.sig = sig;
    grid.innerHTML = idx.map(i => `<button class="pthumb${sb.chosen.has(i) ? ' chosen' : ''}" data-page="${i}" aria-label="Page ${i + 1}${doc.pageList[i].bm ? ', bookmarked' : ''}" ${sb.select ? `aria-pressed="${sb.chosen.has(i)}"` : ''}>
      <span class="pframe"><canvas width="220" height="285"></canvas>${doc.pageList[i].bm ? '<span class="pbm" aria-hidden="true"></span>' : ''}${sb.select ? '<span class="pcheck" aria-hidden="true"></span>' : ''}</span><span class="pn">${i + 1}</span></button>`).join('') +
      (sb.tab === 'all' && !sb.select ? `<button class="pthumb addthumb" id="sbAdd" aria-haspopup="true"><span class="pframe"><span class="plus sm" aria-hidden="true">+</span></span><span class="pn">Add page</span></button>` : '');
    $('#sbEmpty').hidden = !(sb.tab === 'bm' && !idx.length);
    idx.forEach(i => { if (thumbCache.has(i)) paintThumb(i); else sb.dirty.add(i); });
  }
  $('#sbActions').hidden = !sb.select;
  $('#sbCount').textContent = sb.chosen.size ? `${sb.chosen.size} selected` : 'Tap pages to select';
  document.querySelectorAll('#sbActions [data-pa]').forEach(b => { if (b.dataset.pa !== 'all') b.disabled = !sb.chosen.size; });
  $('#sbSelect').textContent = sb.select ? 'Done' : 'Select';
  document.querySelectorAll('#sbTabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === sb.tab)));
  markCurrentThumb();
  scheduleThumbs();
}
function scheduleThumbs(ms = 350) { clearTimeout(sb.t); sb.t = setTimeout(drawDirtyThumbs, ms); }
function inkBusy() { return !!(gesture && gesture.type !== 'pan' && gesture.type !== 'pinch') || performance.now() - lastInkAt < 900; }
function drawDirtyThumbs() {
  if ($('#sidebar').hidden) return;
  if (inkBusy()) { scheduleThumbs(700); return; }
  for (const i of [...sb.dirty]) {
    sb.dirty.delete(i);
    if (i >= doc.pages) continue;
    let cc = thumbCache.get(i);
    if (!cc) { cc = document.createElement('canvas'); cc.width = 220; cc.height = 285; thumbCache.set(i, cc); }
    const k = cc.width / PAGE_W, c = cc.getContext('2d');
    c.setTransform(k, 0, 0, k, 0, -pageY(i) * k);
    try { drawPageBase(c, doc.pageList[i], pageY(i)); drawPageContent(c, doc, pageY(i), true); } catch (e) { }
    paintThumb(i);
  }
}
function markVisibleDirty() {
  const r = viewport.getBoundingClientRect();
  const y0 = toWorld(0, r.top)[1], y1 = toWorld(0, r.bottom)[1];
  for (let i = pageOfY(y0); i <= pageOfY(y1); i++) sb.dirty.add(i);
  scheduleThumbs(600);
}
function markCurrentThumb() {
  const cur = currentNb != null ? currentPage() : -1;
  document.querySelectorAll('.pthumb[data-page]').forEach(b => b.classList.toggle('current', Number(b.dataset.page) === cur));
}
function updatePageUI() {
  if (currentNb == null || !doc.pageList) return;
  const i = currentPage();
  $('#pageInd').textContent = `${i + 1} / ${doc.pages}`;
  const bm = !!(doc.pageList[i] && doc.pageList[i].bm);
  $('#bmBtn').setAttribute('aria-pressed', String(bm));
  $('#bmBtn').title = bm ? 'Remove bookmark from this page' : 'Bookmark this page';
  if (updatePageUI.last !== i) { updatePageUI.last = i; markCurrentThumb(); const t = document.querySelector(`.pthumb[data-page="${i}"]`); if (t && !$('#sidebar').hidden) { const g = $('#sbScroll'), tr = t.getBoundingClientRect(), gr = g.getBoundingClientRect(); if (tr.top < gr.top || tr.bottom > gr.bottom) g.scrollTop += tr.top - gr.top - gr.height / 3; } markPaperMenu(); }
}
$('#sbGrid').addEventListener('click', e => {
  const add = e.target.closest('#sbAdd'); if (add) { e.stopPropagation(); openPageMenu(add, doc.pages); return; }
  const b = e.target.closest('.pthumb[data-page]'); if (!b) return;
  const i = Number(b.dataset.page);
  if (sb.select) { sb.chosen.has(i) ? sb.chosen.delete(i) : sb.chosen.add(i); renderSidebar(); }
  else goToPage(i);
});
$('#sbTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; sb.tab = b.dataset.tab; renderSidebar(true); });
$('#sbSelect').onclick = () => { sb.select = !sb.select; sb.chosen.clear(); renderSidebar(true); };
$('#sbActions').addEventListener('click', e => {
  const b = e.target.closest('[data-pa]'); if (!b) return;
  const list = [...sb.chosen].sort((a, x) => a - x), act = b.dataset.pa;
  if (act === 'all') { const shown = [...Array(doc.pages).keys()].filter(i => sb.tab === 'all' || doc.pageList[i].bm); const allOn = shown.every(i => sb.chosen.has(i)); shown.forEach(i => allOn ? sb.chosen.delete(i) : sb.chosen.add(i)); renderSidebar(); return; }
  if (!list.length) return;
  if (act === 'del') { sb.chosen.clear(); deletePages(list); }
  else if (act === 'dup') { sb.chosen.clear(); duplicatePages(list); }
  else if (act === 'bm') { const on = !list.every(i => doc.pageList[i].bm); setBookmarks(list, on); toast(on ? 'Bookmarked' : 'Bookmarks removed'); }
  else if (act === 'pdf') exportPdf(list);
});
$('#sbToggle').onclick = () => setSidebar($('#sidebar').hidden);
$('#bmBtn').onclick = () => { const i = currentPage(); const on = !doc.pageList[i].bm; setBookmarks([i], on); toast(on ? `Page ${i + 1} bookmarked` : 'Bookmark removed'); };
function openPageMenu(btn, at) {
  const m = $('#pageMenu'); m.dataset.at = at;
  closeMenus(); m.hidden = false;
  const r = btn.getBoundingClientRect(), w = m.offsetWidth || 240, h = m.offsetHeight || 220;
  m.style.left = clamp(r.left, 8, window.innerWidth - w - 8) + 'px'; m.style.right = 'auto';
  m.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
}
$('#pageMenu').addEventListener('click', e => { const b = e.target.closest('[data-addtpl]'); if (!b) return; const at = Number($('#pageMenu').dataset.at); closeMenus(); addPageAt(at, b.dataset.addtpl); });
$('#addPageBtn').onclick = e => { e.stopPropagation(); openPageMenu(e.currentTarget, currentPage() + 1); };
$('#importBtn').onclick = e => { e.stopPropagation(); const m = $('#importMenu'); closeMenus(); m.hidden = false; const r = e.currentTarget.getBoundingClientRect(), w = m.offsetWidth || 240; m.style.left = clamp(r.right - w, 8, window.innerWidth - w - 8) + 'px'; m.style.right = 'auto'; m.style.top = (r.bottom + 6) + 'px'; };
$('#importMenu').addEventListener('click', e => { const b = e.target.closest('[data-imp]'); if (!b) return; closeMenus(); if (b.dataset.imp === 'img') $('#imgFile').click(); else if (b.dataset.imp === 'pdf') { pdfTarget = 'notebook'; $('#pdfFile').click(); } else { importTarget = 'notebook'; $('#openFile').click(); } });

/* ---------- import: images & PDF ---------- */
async function fileToImage(file, maxDim = 1800) {
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, maxDim / Math.max(im.naturalWidth, im.naturalHeight));
    const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(im.naturalWidth * k)); cv.height = Math.max(1, Math.round(im.naturalHeight * k));
    const c = cv.getContext('2d');
    const png = file.type === 'image/png' || file.type === 'image/gif';
    if (!png) { c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); }
    c.drawImage(im, 0, 0, cv.width, cv.height);
    return { src: cv.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86), w: cv.width, h: cv.height };
  } finally { URL.revokeObjectURL(url); }
}
async function importImages(files) {
  files = [...files].filter(f => /^image\//.test(f.type)); if (!files.length) return;
  const pi = currentPage(), r = viewport.getBoundingClientRect(), cy = toWorld(0, r.top + r.height / 2)[1];
  const iids = [];
  let off = 0;
  for (const f of files) {
    let o; try { o = await fileToImage(f); } catch (e) { toast('That image couldn’t be opened'); continue; }
    const key = newImgKey(); await putImage(key, o.src);
    const k = Math.min(1, PAGE_W * 0.72 / o.w, PAGE_H * 0.6 / o.h), w = Math.round(o.w * k), h = Math.round(o.h * k);
    const y = pageY(pi) + clamp(cy - pageY(pi) - h / 2 + off, 30, PAGE_H - h - 30), x = Math.round((PAGE_W - w) / 2 + off);
    const id = uid(); transact(() => doc.imgs.push({ id, key, x, y: Math.round(y), w, h })); iids.push(id); off += 24;
  }
  renderImgs(); scheduleSave(); markVisibleDirty();
  if (iids.length) { sel = { ids: [], gids: [], iids }; renderSelection(); toast('Image added. Drag it to move, or pull the corner to resize.'); }
}
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', PDFW_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
let pdfjsP = null, pdfTarget = 'notebook';
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsP) pdfjsP = (async () => {
    let wsrc = PDFW_URL;
    if (STANDALONE) { try { await loadScript('vendor/pdf.min.js'); wsrc = 'vendor/pdf.worker.min.js'; } catch (e) { } }
    if (!window.pdfjsLib) await loadScript(PDFJS_URL);
    if (wsrc === PDFW_URL) { try { await loadScript(PDFW_URL); } catch (e) { } }
    if (!window.pdfjsLib) throw new Error('pdf.js missing');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = wsrc;
    return window.pdfjsLib;
  })().catch(e => { pdfjsP = null; throw e; });
  return pdfjsP;
}
async function pdfToPages(file, progress) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n), v1 = page.getViewport({ scale: 1 });
    const fit = Math.min(PAGE_W / v1.width, PAGE_H / v1.height), w = v1.width * fit, h = v1.height * fit;
    const vp = page.getViewport({ scale: fit * 1.6 });
    const cv = document.createElement('canvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: c, viewport: vp }).promise;
    out.push({ src: cv.toDataURL('image/jpeg', 0.82), w: Math.round(w), h: Math.round(h) });
    progress && progress(n, pdf.numPages);
  }
  return out;
}
const bgFor = (key, o) => ({ key, w: o.w, h: o.h, x: Math.round((PAGE_W - o.w) / 2), y: o.h < PAGE_H * 0.8 ? 0 : Math.round((PAGE_H - o.h) / 2) });
async function importPdf(file) {
  toast('Opening PDF…');
  let pages;
  try { pages = await pdfToPages(file, (n, t) => toast(`Importing page ${n} of ${t}…`)); }
  catch (e) { toast('This PDF couldn’t be opened here. You can import its pages as images instead.'); return; }
  if (pdfTarget === 'library') {
    const m = addNotebook(file.name.replace(/\.pdf$/i, '').slice(0, 80) || 'Imported PDF', libFolder, 'cyan', newDoc('blank'));
    const d = newDoc('blank'); d.pageList = [];
    for (const o of pages) { const key = newImgKey(); await kv.set(imgKey(m.id, key), o.src); d.pageList.push({ t: 'blank', bg: bgFor(key, o) }); }
    d.pages = d.pageList.length; m.pages = d.pages;
    await kv.set('nb:' + m.id, JSON.stringify(d));
    saveLib(); await openNotebook(m.id);
    const nm = nbMeta(m.id); if (nm) { try { nm.thumb = renderThumb(doc, true); saveLib(); } catch (e) { } }
    toast(`Imported ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`);
    return;
  }
  const list = [];
  for (const o of pages) { const key = newImgKey(); await putImage(key, o.src); list.push({ t: 'blank', bg: bgFor(key, o) }); }
  const at = currentPage() + 1;
  insertPages(at, list); goToPage(at);
  toast(`Imported ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} after page ${at}`);
}
$('#imgFile').addEventListener('change', e => { const fs = e.target.files; if (fs && fs.length) importImages(fs); e.target.value = ''; });
$('#pdfFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) importPdf(f); e.target.value = ''; });
viewport.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); viewport.classList.add('dropping'); } });
viewport.addEventListener('dragleave', () => viewport.classList.remove('dropping'));
viewport.addEventListener('drop', e => {
  viewport.classList.remove('dropping');
  const fs = e.dataTransfer && [...e.dataTransfer.files]; if (!fs || !fs.length) return;
  e.preventDefault();
  const pdf = fs.find(f => f.type === 'application/pdf'); if (pdf) { pdfTarget = 'notebook'; importPdf(pdf); }
  importImages(fs.filter(f => /^image\//.test(f.type)));
});
window.addEventListener('paste', e => { if ($('#nbview').hidden || e.target.closest('input, textarea')) return; const fs = e.clipboardData && [...e.clipboardData.files].filter(f => /^image\//.test(f.type)); if (fs && fs.length) { e.preventDefault(); importImages(fs); } });

/* ---------- export: PDF (written by hand: one JPEG per page) ---------- */
function buildPdf(pages) {
  const enc = new TextEncoder(), parts = [], off = [];
  let len = 0;
  const push = x => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { off[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
  push('%PDF-1.4\n'); push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
  const n = pages.length;
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${n} >>`));
  pages.forEach((im, i) => {
    const p = 3 + i * 3, cs = `q 612 0 0 792 0 0 cm /Im${i} Do Q`;
    obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im${i} ${p + 2} 0 R >> >> /Contents ${p + 1} 0 R >>`));
    obj(p + 1, () => push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
    obj(p + 2, () => { push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`); push(im.bytes); push('\nendstream'); });
  });
  const xref = len, total = 3 + n * 3;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += String(off[k]).padStart(10, '0') + ' 00000 n \n';
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
function renderPageCanvas(i, k = 2) {
  const cv = document.createElement('canvas'); cv.width = PAGE_W * k; cv.height = PAGE_H * k;
  const c = cv.getContext('2d'); c.setTransform(k, 0, 0, k, 0, -pageY(i) * k);
  drawPageBase(c, doc.pageList[i], pageY(i)); drawPageContent(c, doc, pageY(i), true);
  return cv;
}
async function makePdf(list) {
  const pages = [];
  for (const i of list) {
    const cv = renderPageCanvas(i, 2);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
    pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height });
  }
  return buildPdf(pages);
}
async function exportPdf(list) {
  if (!downloads) { toast('Saving files isn’t available in this view'); return; }
  list = list && list.length ? list : [...Array(doc.pages).keys()];
  toast(`Preparing ${list.length} ${list.length === 1 ? 'page' : 'pages'}…`);
  const pdf = await makePdf(list);
  const m = nbMeta(currentNb), base = (m ? m.title : 'math-notes').replace(/[^\w\- ]+/g, '').trim() || 'math-notes';
  try { await downloads.save({ filename: `${base}${list.length < doc.pages ? ` (${list.length} ${list.length === 1 ? 'page' : 'pages'})` : ''}.pdf`, data: pdf }); toast('PDF saved'); }
  catch (e) { if (e && e.code !== 'declined') toast('Couldn’t save the PDF here'); }
}

/* ---------- library: folders & notebooks ---------- */
const LIB_KEY = 'lmn-library-v2', NBK = id => 'lmn-nb-' + id;
const COVERS = [['lime', '#cde85a'], ['mint', '#8fe0b0'], ['aqua', '#59d3c2'], ['cyan', '#4cbfe3'], ['lilac', '#b5a6ff'], ['coral', '#ff9f82'], ['graphite', '#3c4744']];
const coverHex = k => (COVERS.find(c => c[0] === k) || COVERS[2])[1];
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); return true; } catch (e) { toast('Storage is full. Save a notebook file, then delete notebooks you don’t need.'); return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } }
};
let lib = null, currentNb = null, libFolder = null, libSearch = '', lastSavedStr = '';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function saveLib() { store.set(LIB_KEY, lib); }
function libId() { return lib.nextId++; }
const nbMeta = id => lib.notebooks.find(n => n.id === id);
const folderMeta = id => lib.folders.find(f => f.id === id);
function folderPath(id) { const out = []; let f = folderMeta(id); while (f) { out.unshift(f); f = f.parentId != null ? folderMeta(f.parentId) : null; } return out; }
function folderDescendants(id) { const out = [id]; for (let i = 0; i < out.length; i++) lib.folders.forEach(f => { if (f.parentId === out[i]) out.push(f.id); }); return out; }
function countIn(fid) { const ids = folderDescendants(fid); return lib.notebooks.filter(n => ids.includes(n.folderId)).length; }
function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'Edited just now';
  if (s < 3600) return `Edited ${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `Edited ${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'Edited yesterday';
  return 'Edited ' + new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
function withDoc(d, fn) { const prev = doc; doc = d; try { fn(); } finally { doc = prev; bbCache.clear(); anCache.clear(); } }
function drawPaper(c, template, oy, noFill) {
  if (!noFill) { c.fillStyle = '#fff'; c.fillRect(0, oy, PAGE_W, PAGE_H); }
  c.lineWidth = 0.8; c.strokeStyle = '#d6e8e0'; c.fillStyle = '#b9d6cb';
  if (template === 'grid') { for (let x = 0; x <= PAGE_W; x += 24) { c.beginPath(); c.moveTo(x, oy); c.lineTo(x, oy + PAGE_H); c.stroke(); } for (let y = 0; y <= PAGE_H; y += 24) { c.beginPath(); c.moveTo(0, oy + y); c.lineTo(PAGE_W, oy + y); c.stroke(); } }
  if (template === 'lined') { for (let y = 64; y <= PAGE_H; y += 32) { c.beginPath(); c.moveTo(0, oy + y); c.lineTo(PAGE_W, oy + y); c.stroke(); } c.strokeStyle = '#f2b0a8'; c.beginPath(); c.moveTo(84, oy); c.lineTo(84, oy + PAGE_H); c.stroke(); }
  if (template === 'dots') { for (let x = 12; x <= PAGE_W; x += 24) for (let y = 12; y <= PAGE_H; y += 24) { c.beginPath(); c.arc(x, oy + y, 1.1, 0, 7); c.fill(); } }
}
function drawStrokeTo(c, s) {
  if (s.tool === 'pen') { c.fillStyle = s.color; c.fill(new Path2D(outlinePath(s.pts, s.w))); }
  else { c.save(); c.globalAlpha = s.tool === 'hl' ? 0.42 : 0.9; if (s.tool === 'hl') c.globalCompositeOperation = 'multiply'; c.strokeStyle = s.color; c.lineWidth = s.w; c.lineCap = s.tool === 'hl' ? 'butt' : 'round'; c.lineJoin = 'round'; c.stroke(new Path2D(centerPath(s.pts))); c.restore(); }
}
function drawPageContent(c, d, oy, live) {
  const onPage = s => s.pts.some(p => p[1] >= oy - 20 && p[1] <= oy + PAGE_H + 20);
  for (const im of d.imgs || []) { if (im.y > oy + PAGE_H || im.y + im.h < oy) continue; const el = imgEls.get(im.key); if (el) c.drawImage(el, im.x, im.y, im.w, im.h); }
  for (const g of d.graphs) {
    if (g.y > oy + PAGE_H || g.y + g.h < oy) continue;
    const ge = live && graphEls.get(g.id);
    c.save();
    c.beginPath(); c.roundRect ? c.roundRect(g.x, g.y, g.w, g.h, 6) : c.rect(g.x, g.y, g.w, g.h);
    c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#d3dfda'; c.lineWidth = 1.2; c.stroke(); c.clip();
    if (ge) { const bar = ge.el.querySelector('.gbar').offsetHeight; c.drawImage(ge.canvas, g.x, g.y + bar, ge.canvas.clientWidth, ge.canvas.clientHeight); }
    else {
      c.fillStyle = '#f4f8f6'; c.fillRect(g.x, g.y, g.w, 34);
      c.strokeStyle = '#c9d8d2'; c.beginPath(); c.moveTo(g.x, g.y + 34 + (g.h - 34) / 2); c.lineTo(g.x + g.w, g.y + 34 + (g.h - 34) / 2); c.moveTo(g.x + g.w / 2, g.y + 34); c.lineTo(g.x + g.w / 2, g.y + g.h); c.stroke();
      c.strokeStyle = GCOL[0]; c.lineWidth = 4; c.beginPath();
      for (let i = 0; i <= 60; i++) { const x = g.x + g.w * i / 60, y = g.y + 34 + (g.h - 34) * (0.5 - 0.3 * Math.sin(i / 60 * Math.PI * 2.2)); i ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke();
    }
    c.restore();
  }
  for (const id of d.order) { const s = d.strokes[id]; if (s && s.tool === 'hl' && onPage(s)) drawStrokeTo(c, s); }
  for (const id of d.order) { const s = d.strokes[id]; if (s && s.tool !== 'hl' && onPage(s)) drawStrokeTo(c, s); }
  if (live) gOver.querySelectorAll('path.answer').forEach(p => { c.fillStyle = ANSWER; c.fill(new Path2D(p.getAttribute('d'))); });
}
function renderThumb(d, live) {
  const W = 260, k = W / PAGE_W, H = Math.round(PAGE_H * k);
  const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H * 2;
  const c = cv.getContext('2d'); c.scale(2 * k, 2 * k);
  drawPageBase(c, (d.pageList || [])[0] || { t: d.template }, 0);
  drawPageContent(c, d, 0, live);
  return cv.toDataURL('image/jpeg', 0.8);
}
function exampleDoc(kind) {
  const d = newDoc();
  withDoc(d, () => { if (kind === 'calc') buildCalcPage(0); else build3DPage(0); for (const l of doc.lines) computeAnchors(l); });
  return d;
}
function addNotebook(title, folderId, cover, d) {
  const now = Date.now();
  const m = { id: libId(), title, folderId: folderId == null ? null : folderId, cover, created: now, updated: now, pages: d.pages, thumb: renderThumb(d, false) };
  lib.notebooks.push(m);
  kv.set('nb:' + m.id, JSON.stringify(normalizeDoc(d)));
  return m;
}
function addFolder(name, color, parentId) { const f = { id: libId(), name, color, parentId: parentId == null ? null : parentId, created: Date.now() }; lib.folders.push(f); return f; }
function seedLibrary() {
  const old = store.get(STORE_KEY);
  const fc = addFolder('Calculus', 'lime'), fm = addFolder('Multivariable', 'cyan');
  addNotebook('Derivatives & area', fc.id, 'lime', exampleDoc('calc'));
  addNotebook('Surfaces & column math', fm.id, 'aqua', exampleDoc('3d'));
  if (old && old.strokes && Array.isArray(old.order)) addNotebook('My notes', null, 'mint', Object.assign(newDoc(), old));
  else addNotebook('Quick notes', null, 'mint', newDoc());
  saveLib();
}
function saveNow() {
  lastSaveAt = performance.now();
  try { localStorage.setItem(STORE_KEY + ':ui', JSON.stringify({ autoRead: ui.autoRead, autoGraph2: ui.autoGraph, sidebar: ui.sidebar })); } catch (e) { }
  if (currentNb == null) return;
  const str = JSON.stringify(doc);
  if (str === lastSavedStr) return;
  lastSavedStr = str;
  kv.set('nb:' + currentNb, str);
  const m = nbMeta(currentNb); if (m) { m.updated = Date.now(); m.pages = doc.pages; }
  saveLib();
}
function showView(which) {
  $('#home').hidden = which !== 'home';
  $('#nbview').hidden = which !== 'nb';
}
async function readNotebookDoc(id) {
  let d = await kv.get('nb:' + id);
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
  if (!d) { d = store.get(NBK(id)); if (d) kv.set('nb:' + id, JSON.stringify(d)).then(ok => { if (ok) store.del(NBK(id)); }); }
  return d || newDoc();
}
async function openNotebook(id) {
  const m = nbMeta(id); if (!m) return;
  closeMenus(); closeSheet();
  const raw = await readNotebookDoc(id);
  const base = newDoc(); if (!Array.isArray(raw.pageList)) delete base.pageList;
  const d = normalizeDoc(Object.assign(base, raw));
  imgData.clear(); imgEls.clear(); thumbCache.clear();
  await loadImages(id, d);
  currentNb = id;
  sb.select = false; sb.chosen.clear(); sb.tab = 'all';
  showView('nb');
  $('#sidebar').hidden = !ui.sidebar; $('#sbToggle').setAttribute('aria-pressed', String(!!ui.sidebar));
  loadDoc(d);
  lastSavedStr = JSON.stringify(doc);
  $('#nbTitle').textContent = m.title;
  fitWidth();
  m.opened = Date.now(); saveLib();
}
function closeNotebook() {
  if (currentNb == null) { showView('home'); renderLibrary(); return; }
  clearTimeout(saveT); saveNow();
  const m = nbMeta(currentNb);
  if (m) { try { m.thumb = renderThumb(doc, true); } catch (e) { } saveLib(); }
  recQ.length = 0; for (const [, f] of inflight) f.ctl.abort();
  currentNb = null;
  closePop(); clearSelection(); closeMenus();
  showView('home');
  renderLibrary();
}
function folderIcon(color) {
  const c = coverHex(color);
  return `<svg viewBox="0 0 64 52" aria-hidden="true"><path d="M4 12a6 6 0 0 1 6-6h14l6 6h24a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z" fill="${c}" opacity=".55"/><path d="M4 20a6 6 0 0 1 6-6h44a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z" fill="${c}"/><path d="M4 20a6 6 0 0 1 6-6h44a6 6 0 0 1 6 6v3H4z" fill="#fff" opacity=".28"/></svg>`;
}
function renderLibrary() {
  const q = libSearch.trim().toLowerCase();
  if (libFolder != null && !folderMeta(libFolder)) libFolder = null;
  const cur = libFolder != null ? folderMeta(libFolder) : null;
  const path = cur ? folderPath(cur.id) : [];
  $('#crumbs').innerHTML = q || !cur ? '' : `<button class="crumb" data-folder="">Library</button>` + path.slice(0, -1).map(f => `<span aria-hidden="true">›</span><button class="crumb" data-folder="${f.id}">${esc(f.name)}</button>`).join('') + `<span aria-hidden="true">›</span>`;
  $('#libTitle').textContent = q ? `Results for “${libSearch.trim()}”` : cur ? cur.name : 'Library';
  $('#libFolderMenu').hidden = !cur || !!q;
  const folders = (q ? lib.folders.filter(f => f.name.toLowerCase().includes(q)) : lib.folders.filter(f => (f.parentId ?? null) === libFolder)).sort((a, b) => a.name.localeCompare(b.name));
  let nbs = q ? lib.notebooks.filter(n => n.title.toLowerCase().includes(q)) : lib.notebooks.filter(n => (n.folderId ?? null) === libFolder);
  nbs = nbs.slice().sort(lib.sort === 'name' ? (a, b) => a.title.localeCompare(b.title) : (a, b) => (b.updated || 0) - (a.updated || 0));
  $('#libSub').textContent = [nbs.length + (nbs.length === 1 ? ' notebook' : ' notebooks'), folders.length ? folders.length + (folders.length === 1 ? ' folder' : ' folders') : ''].filter(Boolean).join(' · ');
  $('#foldersSec').hidden = !folders.length;
  $('#folderGrid').innerHTML = folders.map(f => {
    const n = countIn(f.id);
    return `<div class="fcard" data-folder="${f.id}" role="button" tabindex="0" aria-label="Open folder ${esc(f.name)}">
      <div class="ficon">${folderIcon(f.color)}</div>
      <div class="fmeta"><div class="fname">${esc(f.name)}</div><div class="fcount">${n} ${n === 1 ? 'notebook' : 'notebooks'}</div></div>
      <button class="more" data-fmenu="${f.id}" aria-label="Options for ${esc(f.name)}">•••</button></div>`;
  }).join('');
  const newCard = q ? '' : `<button class="ncard newcard" data-new="nb"><div class="cover"><span class="plus" aria-hidden="true">+</span></div><div class="nmeta"><div class="ntitle">New notebook</div><div class="ndate">Blank pages</div></div></button>`;
  $('#nbGrid').innerHTML = newCard + nbs.map(n => {
    const where = q && n.folderId != null ? folderPath(n.folderId).map(f => f.name).join(' › ') : '';
    return `<div class="ncard" data-nb="${n.id}" role="button" tabindex="0" aria-label="Open ${esc(n.title)}">
      <div class="cover" style="--c:${coverHex(n.cover)}"><span class="spine"></span>${n.thumb ? `<img src="${n.thumb}" alt="" draggable="false">` : ''}</div>
      <div class="nmeta"><div class="ntitle">${esc(n.title)}</div><div class="ndate">${esc(where || relTime(n.updated))}</div></div>
      <button class="more" data-nmenu="${n.id}" aria-label="Options for ${esc(n.title)}">•••</button></div>`;
  }).join('');
  $('#emptyNote').hidden = !(q && !nbs.length && !folders.length);
  document.querySelectorAll('#sortSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === (lib.sort || 'recent'))));
}
// sheets (dialogs)
function openSheet(html, mount) {
  const sh = $('#sheet');
  sh.querySelector('.sheet').innerHTML = html;
  sh.hidden = false;
  mount && mount(sh.querySelector('.sheet'));
  const first = sh.querySelector('input, button.btn-primary'); if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
}
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet').addEventListener('pointerdown', e => { if (e.target.id === 'sheet') closeSheet(); });
$('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
function swatchRow(name, sel) { return `<div class="swatches" role="radiogroup" aria-label="Color">${COVERS.map(([k, hex]) => `<label class="cs" style="--c:${hex}"><input type="radio" name="${name}" value="${k}" ${k === sel ? 'checked' : ''}><span></span><em>${k}</em></label>`).join('')}</div>`; }
function folderOptions(sel, excludeIds = []) {
  const opts = [`<option value="">Library</option>`];
  const walk = (pid, depth) => lib.folders.filter(f => (f.parentId ?? null) === pid && !excludeIds.includes(f.id)).sort((a, b) => a.name.localeCompare(b.name)).forEach(f => { opts.push(`<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${'  '.repeat(depth)}${depth ? '└ ' : ''}${esc(f.name)}</option>`); walk(f.id, depth + 1); });
  walk(null, 1);
  return opts.join('');
}
const PAPERS = [['grid', 'Graph paper'], ['lined', 'Lined'], ['dots', 'Dot grid'], ['blank', 'Blank']];
function newNotebookSheet() {
  openSheet(`<h2>New notebook</h2>
    <form id="nbForm">
      <label class="fld"><span>Name</span><input id="fName" value="Untitled notebook" autocomplete="off" maxlength="80"></label>
      <div class="fld"><span>Cover</span>${swatchRow('cover', 'aqua')}</div>
      <div class="fld"><span>Paper</span><div class="papers" role="radiogroup">${PAPERS.map(([k, label], i) => `<label class="pp"><input type="radio" name="paper" value="${k}" ${i === 0 ? 'checked' : ''}><span class="pv pv-${k}"></span><em>${label}</em></label>`).join('')}</div></div>
      <label class="fld"><span>Folder</span><select id="fFolder">${folderOptions(libFolder)}</select></label>
      <div class="sheet-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="submit" class="btn-primary">Create notebook</button></div>
    </form>`, root => {
    root.querySelector('#nbForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const title = root.querySelector('#fName').value.trim() || 'Untitled notebook';
      const cover = root.querySelector('input[name=cover]:checked').value, paper = root.querySelector('input[name=paper]:checked').value;
      const fv = root.querySelector('#fFolder').value;
      const d = newDoc(paper);
      const m = addNotebook(title, fv ? Number(fv) : null, cover, d);
      saveLib(); closeSheet(); openNotebook(m.id);
    });
  });
}
function folderSheet(f) {
  openSheet(`<h2>${f ? 'Edit folder' : 'New folder'}</h2>
    <form id="fForm">
      <label class="fld"><span>Name</span><input id="fName" value="${f ? esc(f.name) : 'New folder'}" autocomplete="off" maxlength="60"></label>
      <div class="fld"><span>Color</span>${swatchRow('fcolor', f ? f.color : 'lime')}</div>
      <div class="sheet-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="submit" class="btn-primary">${f ? 'Save' : 'Create folder'}</button></div>
    </form>`, root => {
    root.querySelector('#fForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const name = root.querySelector('#fName').value.trim() || 'Untitled folder', color = root.querySelector('input[name=fcolor]:checked').value;
      if (f) { f.name = name; f.color = color; } else addFolder(name, color, libFolder);
      saveLib(); closeSheet(); renderLibrary();
    });
  });
}
function renameSheet(m) {
  openSheet(`<h2>Rename notebook</h2><form id="rForm"><label class="fld"><span>Name</span><input id="fName" value="${esc(m.title)}" autocomplete="off" maxlength="80"></label>
    <div class="fld"><span>Cover</span>${swatchRow('cover', m.cover)}</div>
    <div class="sheet-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="submit" class="btn-primary">Save</button></div></form>`, root => {
    root.querySelector('#rForm').addEventListener('submit', ev => { ev.preventDefault(); m.title = root.querySelector('#fName').value.trim() || m.title; m.cover = root.querySelector('input[name=cover]:checked').value; saveLib(); closeSheet(); renderLibrary(); if (currentNb === m.id) $('#nbTitle').textContent = m.title; });
  });
}
function moveSheet(m) {
  openSheet(`<h2>Move “${esc(m.title)}”</h2><form id="mForm"><label class="fld"><span>Move to</span><select id="fFolder">${folderOptions(m.folderId)}</select></label>
    <div class="sheet-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="submit" class="btn-primary">Move</button></div></form>`, root => {
    root.querySelector('#mForm').addEventListener('submit', ev => { ev.preventDefault(); const v = root.querySelector('#fFolder').value; m.folderId = v ? Number(v) : null; saveLib(); closeSheet(); renderLibrary(); toast('Moved to ' + (v ? folderMeta(Number(v)).name : 'Library')); });
  });
}
function deleteSheet(kind, item) {
  const ids = kind === 'folder' ? folderDescendants(item.id) : [];
  const n = kind === 'folder' ? lib.notebooks.filter(nb => ids.includes(nb.folderId)).length : 0;
  const name = kind === 'folder' ? item.name : item.title;
  openSheet(`<h2>Delete “${esc(name)}”?</h2>
    <p class="sheet-p">${kind === 'folder' ? (n ? `This also deletes the ${n} ${n === 1 ? 'notebook' : 'notebooks'} inside it. ` : 'The folder is empty. ') : ''}This can’t be undone.</p>
    <div class="sheet-actions"><button type="button" class="btn-ghost" data-close>Cancel</button><button type="button" class="btn-danger" id="delGo">Delete</button></div>`, root => {
    root.querySelector('#delGo').onclick = () => {
      if (kind === 'folder') {
        lib.notebooks.filter(nb => ids.includes(nb.folderId)).forEach(nb => { store.del(NBK(nb.id)); kv.del('nb:' + nb.id); kv.delPrefix(`img:${nb.id}:`); });
        lib.notebooks = lib.notebooks.filter(nb => !ids.includes(nb.folderId));
        lib.folders = lib.folders.filter(f => !ids.includes(f.id));
        if (ids.includes(libFolder)) libFolder = item.parentId ?? null;
      } else { store.del(NBK(item.id)); kv.del('nb:' + item.id); kv.delPrefix(`img:${item.id}:`); lib.notebooks = lib.notebooks.filter(nb => nb.id !== item.id); }
      saveLib(); closeSheet(); renderLibrary(); toast('Deleted');
    };
  });
}
async function duplicateNotebook(m) {
  const d = await readNotebookDoc(m.id);
  const c = addNotebook(m.title + ' copy', m.folderId, m.cover, d);
  for (const k of docImageKeys(d)) { const v = await kv.get(imgKey(m.id, k)); if (v) await kv.set(imgKey(c.id, k), v); }
  c.thumb = m.thumb || c.thumb; saveLib(); renderLibrary(); toast('Duplicated');
}
// card menus
function openCardMenu(btn, items) {
  const menu = $('#cardMenu');
  menu.innerHTML = items.map(([act, label, cls]) => `<button data-act="${act}" class="${cls || ''}" role="menuitem">${label}</button>`).join('');
  closeMenus();
  menu.hidden = false;
  const r = btn.getBoundingClientRect(), w = menu.offsetWidth || 220, h = menu.offsetHeight || 200;
  menu.style.left = clamp(r.right - w, 8, window.innerWidth - w - 8) + 'px';
  menu.style.right = 'auto';
  menu.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
  return menu;
}
let menuTarget = null;
$('#home').addEventListener('click', e => {
  const t = e.target;
  const nm = t.closest('[data-nmenu]'), fm = t.closest('[data-fmenu]');
  if (nm) { e.stopPropagation(); menuTarget = { kind: 'nb', id: Number(nm.dataset.nmenu) }; openCardMenu(nm, [['open', 'Open'], ['rename', 'Rename & cover'], ['move', 'Move to folder…'], ['dup', 'Duplicate'], ['del', 'Delete', 'danger']]); return; }
  if (fm) { e.stopPropagation(); menuTarget = { kind: 'folder', id: Number(fm.dataset.fmenu) }; openCardMenu(fm, [['open', 'Open'], ['edit', 'Rename & color'], ['del', 'Delete folder', 'danger']]); return; }
  if (t.closest('#libFolderMenu')) { e.stopPropagation(); menuTarget = { kind: 'folder', id: libFolder }; openCardMenu(t.closest('#libFolderMenu'), [['edit', 'Rename & color'], ['newsub', 'New folder inside'], ['del', 'Delete folder', 'danger']]); return; }
  const crumb = t.closest('.crumb'); if (crumb) { libFolder = crumb.dataset.folder ? Number(crumb.dataset.folder) : null; renderLibrary(); return; }
  if (t.closest('[data-new="nb"]')) { newNotebookSheet(); return; }
  const fc = t.closest('.fcard'); if (fc) { libFolder = Number(fc.dataset.folder); libSearch = ''; $('#libSearch').value = ''; renderLibrary(); window.scrollTo && $('#home').scrollTo({ top: 0 }); return; }
  const nc = t.closest('.ncard[data-nb]'); if (nc) { openNotebook(Number(nc.dataset.nb)); return; }
  const sb = t.closest('#sortSeg button'); if (sb) { lib.sort = sb.dataset.sort; saveLib(); renderLibrary(); return; }
  if (t.closest('#newBtn')) { e.stopPropagation(); menuTarget = { kind: 'new' }; openCardMenu(t.closest('#newBtn'), [['newnb', 'New notebook'], ['newfolder', 'New folder'], ['importpdf', 'New notebook from a PDF…'], ['import', 'Open a notebook file…']]); return; }
});
$('#home').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.fcard, .ncard[data-nb]')) { e.preventDefault(); e.target.click(); } });
$('#cardMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || !menuTarget) return;
  const act = b.dataset.act, T = menuTarget; closeMenus();
  if (T.kind === 'new') { if (act === 'newnb') newNotebookSheet(); else if (act === 'newfolder') folderSheet(null); else if (act === 'import') { importTarget = 'library'; $('#openFile').click(); } else if (act === 'importpdf') { pdfTarget = 'library'; $('#pdfFile').click(); } return; }
  if (T.kind === 'nb') { const m = nbMeta(T.id); if (!m) return; if (act === 'open') openNotebook(m.id); else if (act === 'rename') renameSheet(m); else if (act === 'move') moveSheet(m); else if (act === 'dup') duplicateNotebook(m); else if (act === 'del') deleteSheet('nb', m); return; }
  if (T.kind === 'folder') { const f = folderMeta(T.id); if (!f) return; if (act === 'open') { libFolder = f.id; renderLibrary(); } else if (act === 'edit') folderSheet(f); else if (act === 'newsub') { libFolder = f.id; folderSheet(null); } else if (act === 'del') deleteSheet('folder', f); }
});
$('#libSearch').addEventListener('input', e => { libSearch = e.target.value; renderLibrary(); });
$('#backBtn').onclick = () => closeNotebook();
$('#nbTitle').onclick = () => { const m = nbMeta(currentNb); if (m) renameSheet(m); };
let importTarget = 'notebook';
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && currentNb != null) { clearTimeout(saveT); saveNow(); const m = nbMeta(currentNb); if (m) { try { m.thumb = renderThumb(doc, true); saveLib(); } catch (e) { } } } });

/* ---------- boot ---------- */
(function boot() {
  let uiSaved = null;
  try { uiSaved = JSON.parse(localStorage.getItem(STORE_KEY + ':ui') || 'null'); if (localStorage.getItem(STORE_KEY + ':hint') === '0') $('#hint').hidden = true; } catch (e) { }
  if (uiSaved && typeof uiSaved.autoRead === 'boolean') ui.autoRead = uiSaved.autoRead;
  if (uiSaved && typeof uiSaved.autoGraph2 === 'boolean') ui.autoGraph = uiSaved.autoGraph2;
  if (uiSaved && typeof uiSaved.sidebar === 'boolean') ui.sidebar = uiSaved.sidebar;
  $('[data-do="autograph"]').setAttribute('aria-checked', String(ui.autoGraph));
  lib = store.get(LIB_KEY);
  if (!lib || !Array.isArray(lib.notebooks) || !Array.isArray(lib.folders)) { lib = { v: 2, folders: [], notebooks: [], nextId: 1, sort: 'recent' }; seedLibrary(); }
  setTool('pen');
  updateInputUI();
  $('#graphBtn').onclick = e => { e.stopPropagation(); toggleMenu($('#graphBtn'), $('#graphMenu')); };
  $('#graphMenu').addEventListener('click', e => { const b = e.target.closest('[data-ins]'); if (!b) return; closeMenus(); insertBlankGraph({ d3: b.dataset.ins === '3d' }); });
  $('#quickSwitch').addEventListener('pointerdown', e => e.stopPropagation());
  $('#quickSwitch').addEventListener('click', e => { e.stopPropagation(); toggleEraser(); });
  updateUndo();
  renderReadPill();
  showView('home');
  renderLibrary();
  getSampler();
  initDownloads();
  window.__app = { insertBlankGraph, recognizeSketch, SolidFit, composeTraces, getSampler, readState: () => readState, graph3: gid => { const g = graphById(gid), ge = graphEls.get(gid); if (!g || !ge || !ge.geo) return null; const r = ge.canvas.getBoundingClientRect(), k = r.width / (ge.canvas.clientWidth || 1), pr = proj3(ge.geo, camOf(g), ge.canvas.clientWidth, ge.canvas.clientHeight); return { hits: ge.geo.hits, rect: [r.left, r.top, r.width, r.height], proj: p => { const q = pr.T(ge.geo.N3(p[0], p[1], p[2])); return [r.left + q[0] * k, r.top + q[1] * k]; }, unproj: (cx, cy, ax) => pr.unproj((cx - r.left) / k, (cy - r.top) / k, ax), geo: { x0: ge.geo.x0, x1: ge.geo.x1, lo: ge.geo.lo, hi: ge.geo.hi } }; }, unitsPerPx: gid => unitsPerPx(graphById(gid), graphEls.get(gid)), sketchAlpha: lid => sketchAlpha(lineById(lid)), openLineMenu: lid => openLineMenu(lineById(lid)), lineMenuOpen: () => !!lmenu, toggleLock: gid => toggleLock(graphById(gid)), loopScreen: lid => { const l = lineById(lid); if (!l || !loopState(l)) return null; const b = loopBox(l); return [toScreen(b.x0, b.y0), toScreen(b.x1, b.y1)]; }, anchorScreen: (lid, ai) => { const l = lineById(lid); const an = l && l.anchors[ai]; if (!an) return null; const bb = anchorBB(l, an); return toScreen(bb.cx, (bb.y0 + bb.y1) / 2); }, input: () => ({ gesture: gesture && gesture.type, penSeen, fingersDraw: fingersDraw(), tool: ui.tool, touches: touches.size, palms: palmIds.size, undo: undoStack.length, redo: redoStack.length }), inputPrefs, doc: () => doc, view, applyReading, lineById, refresh, onIdle, undo, redo, lib: () => lib, openNotebook, closeNotebook, makePdf, insertPages, deletePages, duplicatePages, currentPage, goToPage };
})();
})();
