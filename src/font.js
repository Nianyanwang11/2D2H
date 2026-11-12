/* ===== Handwriting stroke font: draws digits/letters as pen strokes ===== */
const HandFont = (() => {
  const D2R = Math.PI / 180;
  const arc = (cx, cy, rx, ry, a0, a1, n = 18) => {
    const pts = [];
    for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * D2R; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    return pts;
  };
  const dot = (x, y) => [[x, y], [x + 0.02, y + 0.02]];
  // glyph: { w: advance (em), s: [strokes of [x,y]] } — y down, 0 = top of digit, 1 = baseline
  const G = {
    '0': { w: .62, s: [arc(.3, .5, .26, .48, 265, 625, 28)] },
    '1': { w: .42, s: [[[.08, .2], [.26, 0], [.26, 1]]] },
    '2': { w: .62, s: [[...arc(.29, .28, .25, .26, 195, 380, 16), [.2, .72], [.04, 1], [.58, .99]]] },
    '3': { w: .6, s: [[...arc(.28, .27, .23, .24, 200, 450, 14), ...arc(.28, .73, .27, .27, 265, 510, 16)]] },
    '4': { w: .62, s: [[[.4, 0], [.03, .68], [.6, .68]], [[.44, .32], [.45, 1]]] },
    '5': { w: .6, s: [[[.52, 0], [.13, 0], [.09, .45], ...arc(.29, .69, .26, .3, 215, 480, 16)]] },
    '6': { w: .6, s: [[[.5, .03], [.3, .14], [.13, .38], [.06, .66], ...arc(.3, .7, .24, .29, 180, 540, 22)]] },
    '7': { w: .6, s: [[[.04, .01], [.56, 0], [.22, 1]]] },
    '8': { w: .6, s: [[...arc(.3, .25, .2, .23, 90, 450, 18)], [...arc(.3, .73, .25, .27, 270, 630, 20)]] },
    '9': { w: .6, s: [[...arc(.29, .3, .24, .28, 10, -350, 22), [.54, .4], [.5, 1]]] },
    '+': { w: .64, s: [[[.06, .56], [.56, .56]], [[.31, .3], [.31, .82]]] },
    '-': { w: .56, s: [[[.06, .6], [.48, .6]]] },
    '=': { w: .64, s: [[[.06, .44], [.56, .44]], [[.06, .72], [.56, .72]]] },
    '×': { w: .6, s: [[[.1, .36], [.48, .84]], [[.48, .36], [.1, .84]]] },
    '*': { w: .6, s: [[[.1, .36], [.48, .84]], [[.48, .36], [.1, .84]]] },
    '÷': { w: .62, s: [[[.06, .6], [.54, .6]], dot(.3, .38), dot(.3, .82)] },
    '/': { w: .45, s: [[[.4, 0], [.05, 1]]] },
    '.': { w: .24, s: [dot(.1, .96)] },
    ',': { w: .24, s: [[[.12, .92], [.13, 1], [.06, 1.12]]] },
    '(': { w: .38, s: [arc(.42, .5, .3, .6, 236, 124, 14)] },
    '|': { w: .26, s: [[[.13, -.04], [.13, 1.04]]] },
    '√': { w: .62, s: [[[.02, .6], [.15, .53], [.3, 1.02], [.5, -.04], [.66, -.04]]] },
    ')': { w: .38, s: [arc(-.02, .5, .3, .6, -56, 56, 14)] },
    'x': { w: .56, s: [[[.05, .42], [.46, 1]], [[.46, .42], [.05, 1]]] },
    'y': { w: .56, s: [[[.05, .42], [.27, .86]], [[.5, .42], [.27, .9], [.14, 1.3]]] },
    'z': { w: .52, s: [[[.05, .43], [.46, .43], [.05, 1], [.47, 1]]] },
    'a': { w: .54, s: [[...arc(.24, .72, .2, .28, 330, 30, 18), [.45, .44], [.47, 1]]] },
    'b': { w: .54, s: [[[.06, 0], [.06, 1]], arc(.27, .72, .21, .28, 190, 530, 20)] },
    'c': { w: .5, s: [arc(.27, .71, .22, .29, 325, 35, 18)] },
    'd': { w: .54, s: [arc(.25, .72, .21, .28, 10, 350, 20), [[.47, 0], [.47, 1]]] },
    'e': { w: .52, s: [[[.06, .72], [.46, .71], ...arc(.26, .71, .2, .29, 360, 45, 18)]] },
    'f': { w: .42, s: [[...arc(.34, .2, .13, .17, 330, 180, 10), [.21, 1.05]], [[.05, .46], [.38, .46]]] },
    'i': { w: .3, s: [[[.12, .45], [.12, 1]], dot(.12, .22)] },
    'l': { w: .3, s: [[[.13, 0], [.13, 1]]] },
    'n': { w: .56, s: [[[.06, .42], [.06, 1]], [[.06, .62], ...arc(.26, .64, .2, .22, 200, 360, 12), [.46, 1]]] },
    'o': { w: .52, s: [arc(.26, .71, .21, .29, 265, 625, 24)] },
    'r': { w: .42, s: [[[.06, .42], [.06, 1]], [[.06, .66], ...arc(.25, .64, .19, .2, 200, 300, 8)]] },
    's': { w: .48, s: [[...arc(.25, .56, .18, .14, 330, 90, 12), ...arc(.25, .86, .19, .14, 270, 510, 12)]] },
    't': { w: .42, s: [[[.18, .14], [.18, .88], [.24, .98], [.36, 1]], [[.02, .44], [.38, .44]]] },
    'u': { w: .54, s: [[[.06, .42], ...arc(.26, .78, .2, .22, 180, 0, 12).slice(0), [.46, .42], [.47, 1]]] },
    'g': { w: .54, s: [[...arc(.25, .66, .2, .24, 10, 350, 18), [.46, .44], [.46, 1.1], ...arc(.26, 1.1, .2, .2, 0, 150, 8)]] },
    'p': { w: .54, s: [[[.06, .42], [.06, 1.32]], arc(.27, .7, .21, .28, 190, 530, 20)] },
    'k': { w: .5, s: [[[.06, 0], [.06, 1]], [[.42, .42], [.07, .72], [.44, 1]]] },
    'm': { w: .76, s: [[[.06, .42], [.06, 1]], [[.06, .62], ...arc(.21, .62, .15, .2, 200, 360, 8), [.36, 1]], [[.36, .62], ...arc(.51, .62, .15, .2, 200, 360, 8), [.66, 1]]] },
    'h': { w: .54, s: [[[.06, 0], [.06, 1]], [[.06, .62], ...arc(.26, .64, .2, .22, 200, 360, 12), [.46, 1]]] },
    'θ': { w: .56, s: [arc(.28, .5, .22, .5, 265, 625, 24), [[.08, .5], [.48, .5]]] },
    'π': { w: .6, s: [[[.02, .46], [.56, .43]], [[.18, .45], [.15, 1]], [[.42, .45], [.45, 1]]] },
    '?': { w: .5, s: [[...arc(.24, .26, .2, .22, 200, 430, 12), [.24, .7]], dot(.24, .95)] },
  };
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
  function catmull(pts, per = 4) {
    if (pts.length < 3) return pts.slice();
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < per; k++) {
        const t = k / per, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
        ]);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  // Densify straight segments so pressure varies along them
  function densify(pts, step) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(L / step));
      for (let k = 1; k <= n; k++) out.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
    }
    return out;
  }
  /**
   * Lay out text as strokes. Text uses ^ for a superscript token: "x^3 - 3x".
   * Returns { glyphs: [{ch, strokes:[[ [x,y,p], ...], ...], box:{x,y,w,h}, sup}], width }
   * x,y = top-left of the line box; h = digit height in px.
   */
  function layout(text, x, y, h, seed = 7) {
    const R = rng(seed);
    const glyphs = [];
    let cx = x;
    let sup = false, supLeft = 0, supEnd = -1;
    for (let i = 0; i < text.length; i++) {
      let ch = text[i];
      if (ch === ' ') { cx += h * 0.26; continue; }
      if (ch === '^' && text[i + 1] === '(') {   // ^( … ) : a whole group in superscript, brackets not drawn
        let d = 0, j = i + 1; for (; j < text.length; j++) { if (text[j] === '(') d++; else if (text[j] === ')' && --d === 0) break; }
        supEnd = j; i++; continue;
      }
      if (i === supEnd) { supEnd = -1; continue; }
      if (ch === '^') { sup = true; supLeft = 1; continue; }
      const g = G[ch] || G['?'];
      const isSup = sup || i < supEnd;
      if (sup) { supLeft--; const nxt = text[i + 1]; if (!(nxt && /[0-9.]/.test(ch) && /[0-9.]/.test(nxt))) sup = false; }
      const sc = (isSup ? 0.58 : 1) * h * (1 + (R() - 0.5) * 0.06);
      const oy = y + (isSup ? -0.18 * h : 0) + (R() - 0.5) * 0.04 * h;
      const rot = (R() - 0.5) * 5 * D2R + 0.04;
      const ox = cx + (isSup ? 0.04 * h : 0);
      const strokes = g.s.map(st => {
        const sm = catmull(densify(st, 0.12), 3);
        const n = sm.length;
        return sm.map(([u, v], k) => {
          const uu = u - 0.3, vv = v - 0.5;
          const ru = uu * Math.cos(rot) - vv * Math.sin(rot) + 0.3, rv = uu * Math.sin(rot) + vv * Math.cos(rot) + 0.5;
          const t = k / Math.max(1, n - 1);
          const p = 0.45 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08)) + (R() - 0.5) * 0.05;
          return [ox + ru * sc + (R() - 0.5) * 0.008 * h, oy + rv * sc + (R() - 0.5) * 0.008 * h, Math.max(0.2, Math.min(1, p))];
        });
      });
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of strokes) for (const [px, py] of s) { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); }
      glyphs.push({ ch, strokes, sup: isSup, box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } });
      cx += g.w * sc + h * 0.07;
    }
    return { glyphs, width: cx - x };
  }
  function advance(text, h) {
    let w = 0;
    let sup = false, supEnd = -1;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === ' ') { w += h * 0.26; continue; }
      if (ch === '^' && text[i + 1] === '(') { let d = 0, j = i + 1; for (; j < text.length; j++) { if (text[j] === '(') d++; else if (text[j] === ')' && --d === 0) break; } supEnd = j; i++; continue; }
      if (i === supEnd) { supEnd = -1; continue; }
      if (ch === '^') { sup = true; continue; }
      const g = G[ch] || G['?'], k = sup || i < supEnd ? 0.58 : 1;
      if (sup && !(/[0-9.]/.test(ch) && /[0-9.]/.test(text[i + 1] || ''))) sup = false;
      w += g.w * h * k + h * 0.07;
    }
    return w;
  }
  return { layout, advance, has: ch => !!G[ch] };
})();
if (typeof module !== 'undefined') module.exports = { HandFont };
