/**
 * Shape System for ZiLing (字灵)
 *
 * Converts abstract shapes (颜文字 expressions, 巨字 giant characters,
 * parametric curves) into grid-cell coordinate masks for the里字 engine.
 *
 * Sampling pipeline (v2 — high-resolution):
 *   1) Render the shape onto a SUPERSAMPLED off-screen canvas
 *      (cols·SS × rows·SS) so glyph detail survives.
 *   2) Fit the glyph to the grid box (measureText) so nothing is clipped.
 *   3) Downsample: a grid cell is "on" when its SS×SS block is covered
 *      past a threshold.
 *   4) Sparsify evenly to at most `maxChars` cells.
 *
 * The old version rasterised at 1px-per-cell, which smeared颜文字/巨字 into
 * unreadable blobs and clipped wide emoji — this fixes both (辨形清晰).
 *
 * Shape constraint levels:
 *   'strict' — 颜文字 / 巨字, hold formation (易辨形)
 *   'loose'  — curves / flowers, roam freely
 *
 * @module shape
 * @license MIT
 */

const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif';
const SS = 6; // supersample factor per grid cell

/* ================================================================
 *  SHAPE TEMPLATE DATA
 * ================================================================ */

/**
 * 颜文字 expression templates with anatomy regions.
 */
export const EMOJI_TEMPLATES = {
  '^_^':   { mood:'happy',      eyes:['^','^'],  mouth:'_', micro:['blink','breath'] },
  '-_-':   { mood:'neutral',    eyes:['-','-'],  mouth:'_', micro:['breath'] },
  'T_T':   { mood:'sad',        eyes:['T','T'],  mouth:'_', micro:['blink','breath'] },
  'Q_Q':   { mood:'cry',        eyes:['Q','Q'],  mouth:'_', micro:['blink','breath'] },
  'U_U':   { mood:'upset',      eyes:['U','U'],  mouth:'_', micro:['breath'] },
  '>_<':   { mood:'angry',      eyes:['>','<'],  mouth:'_', micro:['blink'] },
  '≥﹏≤':   { mood:'teary',      eyes:['≥','≤'],  mouth:'﹏', micro:['blink','breath'] },
  '¬_¬':   { mood:'suspicious', eyes:['¬','¬'],  mouth:'_', micro:['blink'] },
  '=_=':   { mood:'tired',      eyes:['=','='],  mouth:'_', micro:['breath'] },
  '⊙_⊙':   { mood:'shocked',    eyes:['⊙','⊙'],  mouth:'_', micro:['blink'] },
  '^o^':   { mood:'excited',    eyes:['^','^'],  mouth:'o', micro:['blink','mouthWiggle'] },
  '^.^':   { mood:'shy',        eyes:['^','^'],  mouth:'.', micro:['blink','breath'] },
  '≥▽≤':   { mood:'bigSmile',   eyes:['≥','≤'],  mouth:'▽', micro:['blink','mouthWiggle'] },
  '(^_^)/':{ mood:'wave',       eyes:['^','^'],  mouth:'_', micro:['blink','breath'] },
};

/**
 * Non-emoji shape type identifiers.
 */
export const SHAPE_TYPES = {
  MEGACHAR: 'megachar',
  CURVE_ROSE: 'curve_rose',
  CURVE_HEART: 'curve_heart',
  CURVE_PINWHEEL: 'curve_pinwheel',
  CLOCK: 'clock',
};


/* ================================================================
 *  SHAPE SYSTEM
 * ================================================================ */

export class ShapeSystem {
  constructor() {
    /** @type {string|null} */
    this.currentShape = null;
    /** @type {Array<{x:number, y:number}>} */
    this.currentMask = [];
    /** @type {'strict'|'moderate'|'loose'} */
    this.constraintType = 'loose';
  }

  /* ----------------------------------------------------------
   *  颜文字 SAMPLING
   * ---------------------------------------------------------- */

  /**
   * Sample a颜文字 expression into a grid mask.
   * @param {string} emojiKey — key from {@link EMOJI_TEMPLATES} (e.g. '^_^')
   * @param {number} gridCols
   * @param {number} gridRows
   * @param {number} [maxChars=80]
   * @returns {{ mask: Array<{x:number,y:number}>, constraint: 'strict' }}
   */
  sampleEmoji(emojiKey, gridCols, gridRows, maxChars = 80) {
    const text = EMOJI_TEMPLATES[emojiKey] ? emojiKey : '^_^';
    const solid = this._rasterToCells(gridCols, gridRows, 0.10, (ctx, W, H) => {
      // 颜文字 are wide and short — fit mostly by width, keep a short band.
      const fs = this._fitFont(ctx, text, W * 0.94, H * 0.6);
      ctx.font = `${fs}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, W / 2, H / 2);
    });
    const paths = this._glyphToPaths(solid, gridCols, gridRows);
    this.currentShape = emojiKey;
    this.constraintType = 'flow';
    // 每条笔画 = 骨架中心线(line) + 加宽带(cells)；里字沿笔画流动并在带内横向随机。
    return { paths, constraint: 'flow' };
  }

  /* ----------------------------------------------------------
   *  巨字 SAMPLING (giant Chinese character)
   * ---------------------------------------------------------- */

  /**
   * Sample a 巨字 (single giant Chinese character) into a grid mask.
   * @param {string} char
   * @param {number} gridCols
   * @param {number} gridRows
   * @param {number} [maxChars=100]
   * @param {'horizontal'|'vertical'} [direction='horizontal'] — reserved for
   *   multi-char 巨字 stacking; a single char always renders upright.
   * @returns {{ mask: Array<{x:number,y:number}>, constraint: 'strict' }}
   */
  sampleMegachar(char, gridCols, gridRows, maxChars = 100, direction = 'horizontal') {
    const solid = this._rasterToCells(gridCols, gridRows, 0.14, (ctx, W, H) => {
      const fs = this._fitFont(ctx, char, W * 0.9, H * 0.9);
      ctx.font = `${fs}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(char, W / 2, H / 2);
    });
    const paths = this._glyphToPaths(solid, gridCols, gridRows);
    this.currentShape = char;
    this.constraintType = 'flow';
    return { paths, constraint: 'flow' };
  }

  /* ----------------------------------------------------------
   *  PARAMETRIC CURVE SAMPLING
   * ---------------------------------------------------------- */

  /**
   * Sample a mathematical curve shape into a grid mask.
   * Supported: 'rose' (r=cos2θ), 'heart'; anything else → circle.
   * @param {string} type
   * @param {number} gridCols
   * @param {number} gridRows
   * @param {number} [maxChars=60]
   * @returns {{ mask: Array<{x:number,y:number}>, constraint: 'loose' }}
   */
  sampleCurve(type, gridCols, gridRows, maxChars = 60) {
    const mask = this._rasterToMask(gridCols, gridRows, maxChars, 0.06, (ctx, W, H) => {
      const cx = W / 2;
      const cy = H / 2;
      const scale = Math.min(W, H) * 0.42;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = SS * 1.3; // ≈ one grid cell wide after downsample
      ctx.lineJoin = 'round';
      ctx.beginPath();

      switch (type) {
        case 'rose':
          for (let t = 0; t <= Math.PI * 2 + 0.02; t += 0.01) {
            const r = Math.cos(2 * t) * scale;
            const x = cx + r * Math.cos(t);
            const y = cy + r * Math.sin(t);
            if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          break;
        case 'heart':
          for (let t = 0; t <= Math.PI * 2 + 0.02; t += 0.01) {
            const x = cx + 16 * Math.pow(Math.sin(t), 3) * (scale / 18);
            const y = cy - (13 * Math.cos(t) - 5 * Math.cos(2 * t)
                            - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * (scale / 18);
            if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          break;
        default:
          ctx.arc(cx, cy, scale, 0, Math.PI * 2);
          break;
      }
      ctx.stroke();
    });

    this.currentMask = mask;
    this.currentShape = type;
    this.constraintType = 'loose';
    return { mask, constraint: 'loose' };
  }

  /**
   * Sample a parametric curve into an **ordered** chain of grid cells (walking
   * the curve by parameter t), evenly thinned to ~`count`. Unlike
   * {@link sampleCurve} (which rasterises into an unordered mask), the order
   * lets the motion engine stream里字 single-file along the outline (flow),
   * so thin shapes like心形 keep moving without breaking辨识度.
   *
   * Pure math (no canvas) → usable in tests too.
   * @returns {{ mask: Array<{x:number,y:number}>, constraint:'flow', ordered:true }}
   */
  sampleCurveOrdered(type, gridCols, gridRows, count = 60) {
    const cx = gridCols / 2, cy = gridRows / 2;
    const scale = Math.min(gridCols, gridRows) * 0.40;
    const pts = [];
    // Push a cell, inserting an orthogonal bridge when the step is diagonal so
    // the path stays 4-connected (rook moves). 里字只走上下左右，4连通才能让
    // 流动 target 永远是相邻格 → 单列顺畅、不脱离轮廓。
    const pushCell = (fx, fy) => {
      const gx = Math.round(fx), gy = Math.round(fy);
      if (gx < 0 || gy < 0 || gx >= gridCols || gy >= gridRows) return;
      const last = pts[pts.length - 1];
      if (last && last.x === gx && last.y === gy) return;
      if (last) {
        const ddx = gx - last.x, ddy = gy - last.y;
        if (Math.abs(ddx) === 1 && Math.abs(ddy) === 1) {
          pts.push({ x: last.x + ddx, y: last.y }); // orthogonal bridge
        }
      }
      pts.push({ x: gx, y: gy });
    };
    for (let t = 0; t <= Math.PI * 2 + 1e-6; t += 0.005) {
      let x, y;
      if (type === 'heart') {
        x = cx + 16 * Math.pow(Math.sin(t), 3) * (scale / 18);
        y = cy - (13 * Math.cos(t) - 5 * Math.cos(2 * t)
                  - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * (scale / 18);
      } else if (type === 'rose') {
        const r = Math.cos(2 * t) * scale;
        x = cx + r * Math.cos(t);
        y = cy + r * Math.sin(t);
      } else {
        x = cx + scale * Math.cos(t);
        y = cy + scale * Math.sin(t);
      }
      pushCell(x, y);
    }
    // Drop ALL duplicates, preserving first-seen order. For a non-self-touching
    // loop this keeps consecutive cells 4-adjacent and uniquely ordered.
    const used = new Set();
    const mask = [];
    for (const p of pts) {
      const k = p.y * gridCols + p.x;
      if (used.has(k)) continue;
      used.add(k);
      mask.push(p);
    }
    this.currentMask = mask;
    this.currentShape = type;
    this.constraintType = 'flow';
    // 曲线/数学曲线 → 单条闭环路径（line=cells，1 宽），里字首尾相连绕圈流动。
    return { paths: [{ line: mask, cells: mask, loop: true }], constraint: 'flow', ordered: true };
  }

  /* ----------------------------------------------------------
   *  GLYPH → STROKE PATHS（骨架细化 + 追踪 + 加宽带）
   * ---------------------------------------------------------- */

  /**
   * 把实心字形拆成"笔画路径"：Zhang-Suen 细化出 1 像素骨架 → 追踪成中心线折线
   * → 每条线加宽成一条带。里字沿中心线流动、在带内横向随机（不单调）。纯函数。
   * @param {Array<{x,y}>} solid 实心字形格子
   * @param {number} cols @param {number} rows
   * @returns {Array<{line:Array<{x,y}>, cells:Array<{x,y}>, loop:boolean}>}
   */
  _glyphToPaths(solid, cols, rows) {
    if (!solid || solid.length === 0) return [];
    const skel = this._thinZS(solid, cols, rows);
    let lines = this._traceSkeleton(skel, cols, rows);
    // 极少数情形骨架追踪为空 → 回退到整体最近邻链。
    if (lines.length === 0) lines = [{ line: this._nnChain(solid), loop: false }];
    const solidSet = new Set(solid.map(c => c.y * cols + c.x));
    return lines
      .filter(l => l.line.length >= 1)
      .map(l => ({ line: l.line, loop: l.loop, cells: this._dilateBand(l.line, cols, rows, solidSet) }));
  }

  /** Zhang-Suen thinning → Set of skeleton cell keys (y*cols+x). @private */
  _thinZS(solid, cols, rows) {
    const on = new Set(solid.map(c => c.y * cols + c.x));
    const at = (x, y) => (x >= 0 && y >= 0 && x < cols && y < rows && on.has(y * cols + x)) ? 1 : 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        const rem = [];
        for (const k of on) {
          const x = k % cols, y = (k - x) / cols;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1),
                p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) { if (p2 && p4 && p6) continue; if (p4 && p6 && p8) continue; }
          else { if (p2 && p4 && p8) continue; if (p2 && p6 && p8) continue; }
          rem.push(k);
        }
        if (rem.length) { changed = true; for (const k of rem) on.delete(k); }
      }
    }
    return on;
  }

  /**
   * Trace a 1-px skeleton into polylines: walk edges between nodes (degree≠2);
   * leftover degree-2 rings become closed loops. @private
   * @returns {Array<{line:Array<{x,y}>, loop:boolean}>}
   */
  _traceSkeleton(on, cols, rows) {
    const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const nbrs = (k) => {
      const x = k % cols, y = (k - x) / cols;
      const r = [];
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && on.has(ny * cols + nx)) r.push(ny * cols + nx);
      }
      return r;
    };
    const deg = (k) => nbrs(k).length;
    const toXY = (k) => ({ x: k % cols, y: (k - (k % cols)) / cols });
    const eKey = (a, b) => a < b ? a + '_' + b : b + '_' + a;
    const usedEdge = new Set();
    const paths = [];

    const walk = (start, first) => {
      const line = [toXY(start)];
      let prev = start, cur = first;
      usedEdge.add(eKey(start, first));
      while (true) {
        line.push(toXY(cur));
        if (deg(cur) !== 2) break;
        const next = nbrs(cur).find(n => n !== prev && !usedEdge.has(eKey(cur, n)));
        if (next === undefined) break;
        usedEdge.add(eKey(cur, next));
        prev = cur; cur = next;
      }
      return line;
    };

    // edges from nodes (endpoints / junctions)
    for (const k of on) {
      if (deg(k) === 2) continue;
      for (const n of nbrs(k)) {
        if (usedEdge.has(eKey(k, n))) continue;
        paths.push({ line: walk(k, n), loop: false });
      }
    }
    // leftover pure rings (all degree 2)
    for (const k of on) {
      if (deg(k) !== 2) continue;
      const n = nbrs(k).find(nn => !usedEdge.has(eKey(k, nn)));
      if (n === undefined) continue;
      paths.push({ line: walk(k, n), loop: true });
    }
    // isolated cells (degree 0 — e.g. a small blob thinned to one dot)
    for (const k of on) {
      if (deg(k) === 0) paths.push({ line: [toXY(k)], loop: false });
    }
    return paths;
  }

  /**
   * Widen a centre line into a band by dilating 1 cell (8-conn) — slightly
   * spilling past the glyph edge ("边缘放宽")，里字在带内做横向随机更不单调。
   * @private
   */
  _dilateBand(line, cols, rows, _solidSet) {
    const seen = new Set();
    const band = [];
    const add = (x, y) => {
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;
      const k = y * cols + x;
      if (seen.has(k)) return;
      seen.add(k);
      band.push({ x, y });
    };
    for (const c of line) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) add(c.x + dx, c.y + dy);
    }
    return band;
  }

  /**
   * Order a component's cells into a single chain by greedy nearest-neighbour
   * (start at the top-left), so流动 can slosh里字 back and forth along it.
   * @private
   */
  _nnChain(comp) {
    if (comp.length <= 2) return comp.slice();
    const left = comp.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const start = left[0];
    const pool = new Set(comp);
    pool.delete(start);
    const chain = [start];
    let cur = start;
    while (pool.size) {
      let best = null, bestD = Infinity;
      for (const c of pool) {
        const d = Math.abs(c.x - cur.x) + Math.abs(c.y - cur.y);
        if (d < bestD) { bestD = d; best = c; }
      }
      chain.push(best);
      pool.delete(best);
      cur = best;
    }
    return chain;
  }

  /* ----------------------------------------------------------
   *  MASK QUERIES
   * ---------------------------------------------------------- */

  getCurrentMask() {
    return this.currentMask;
  }

  isInShape(x, y) {
    return this.currentMask.some(p => p.x === x && p.y === y);
  }

  /* ----------------------------------------------------------
   *  INTERNAL HELPERS
   * ---------------------------------------------------------- */

  /**
   * Choose a font size (px) that fits `text` inside (maxW × maxH).
   * @private
   */
  _fitFont(ctx, text, maxW, maxH) {
    let fs = maxH;
    ctx.font = `${fs}px ${FONT_STACK}`;
    const w = ctx.measureText(text).width || 1;
    if (w > maxW) fs *= maxW / w;
    return Math.max(4, Math.floor(fs));
  }

  /**
   * Render `drawFn` onto a supersampled canvas, then downsample to a grid mask.
   * A grid cell is "on" when its SS×SS pixel block is covered past `threshold`.
   * @private
   * @param {number} cols
   * @param {number} rows
   * @param {number} maxChars
   * @param {number} threshold — 0..1 coverage needed to light a cell
   * @param {(ctx:OffscreenCanvasRenderingContext2D, W:number, H:number)=>void} drawFn
   * @returns {Array<{x:number,y:number}>}
   */
  _rasterToMask(cols, rows, maxChars, threshold, drawFn) {
    return this._sparsify(this._rasterToCells(cols, rows, threshold, drawFn), maxChars);
  }

  /**
   * Rasterise `drawFn` and return ALL lit grid cells (solid, no sparsify) —
   * the basis for skeletonisation.
   * @private
   * @returns {Array<{x:number,y:number}>}
   */
  _rasterToCells(cols, rows, threshold, drawFn) {
    const W = cols * SS;
    const H = rows * SS;
    const off = new OffscreenCanvas(W, H);
    const ctx = off.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, W, H);
    drawFn(ctx, W, H);

    const data = ctx.getImageData(0, 0, W, H).data;
    const need = Math.max(1, Math.round((SS * SS) * threshold));
    const cells = [];
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        let on = 0;
        const baseX = gx * SS;
        const baseY = gy * SS;
        for (let py = 0; py < SS; py++) {
          const rowOff = (baseY + py) * W;
          for (let px = 0; px < SS; px++) {
            if (data[((rowOff + baseX + px) << 2) + 3] > 100) {
              if (++on >= need) { py = SS; break; } // early-out once lit
            }
          }
        }
        if (on >= need) cells.push({ x: gx, y: gy });
      }
    }
    return cells;
  }

  /**
   * Thin `cells` down to at most `maxChars` with **spatially uniform** spread
   * using farthest-point sampling (FPS).
   *
   * 旧实现按一维 row-major 序等距抽取，二维上疏密不均 —— 颜文字"眼睛"像素多
   * 的区域会分到过多采样点、"嘴"等细笔画几乎被抽空，导致难以辨形。FPS 每次
   * 选离已选集合最远的点，能让采样点均匀覆盖整个字形（细笔画也保有代表点），
   * 显著改善辨形。结果是确定性的（以最接近质心的点为种子）。
   * @private
   */
  _sparsify(cells, maxChars) {
    if (cells.length <= maxChars) return cells;
    const n = cells.length;

    // Seed: the cell closest to the centroid (deterministic).
    let cx = 0, cy = 0;
    for (const c of cells) { cx += c.x; cy += c.y; }
    cx /= n; cy /= n;
    let seed = 0, seedD = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = cells[i].x - cx, dy = cells[i].y - cy;
      const d = dx * dx + dy * dy;
      if (d < seedD) { seedD = d; seed = i; }
    }

    const chosen = new Uint8Array(n);
    chosen[seed] = 1;
    const out = [cells[seed]];
    // minD[i] = squared distance from cell i to the nearest chosen cell.
    const minD = new Float64Array(n).fill(Infinity);
    let last = seed;

    for (let k = 1; k < maxChars; k++) {
      const lx = cells[last].x, ly = cells[last].y;
      let far = -1, farD = -1;
      for (let i = 0; i < n; i++) {
        if (chosen[i]) continue;
        const dx = cells[i].x - lx, dy = cells[i].y - ly;
        const d = dx * dx + dy * dy;
        if (d < minD[i]) minD[i] = d;
        if (minD[i] > farD) { farD = minD[i]; far = i; }
      }
      if (far === -1) break;
      chosen[far] = 1;
      out.push(cells[far]);
      last = far;
    }
    return out;
  }
}
