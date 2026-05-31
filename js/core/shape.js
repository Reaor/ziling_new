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

const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Heiti SC", "Noto Sans CJK SC", sans-serif';
const BOLD_FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Heiti SC", sans-serif';
const SS = 8; // supersample factor per grid cell（提采样分辨率→边缘更干净、辨形更好）

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
  sampleEmoji(emojiKey, gridCols, gridRows, maxChars = 120) {
    const text = EMOJI_TEMPLATES[emojiKey] ? emojiKey : '^_^';
    // 颜文字 = 实心定形：眼/嘴笔画有 ≥2 格宽身段（配合较高网格分辨率）→ 里字在笔画内
    // "转大圈"循环流动（满填循环 flowfill），既动态又辨形稳、眼嘴粗细协调成脸。
    const cells = this._rasterToCells(gridCols, gridRows, 0.36, (ctx, W, H) => {
      const fs = this._fitFont(ctx, text, W * 0.86, H * 0.46);
      this._drawTextMask(ctx, text, W / 2, H / 2, fs, {
        weight: 500,
        strokeWidth: Math.max(SS * 0.3, fs * 0.02),
      });
    });
    const mask = this._sparsify(cells, maxChars);
    this.currentMask = mask;
    this.currentShape = emojiKey;
    this.constraintType = 'strict';
    return { mask, constraint: 'strict' };
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
  sampleMegachar(char, gridCols, gridRows, maxChars = 320, direction = 'horizontal') {
    // 巨字 = 实心定形 + 自适应笔画粗细：先探测笔画密度（ink density = 字身格数 / 外接框面积），
    // 据此选"加粗 / 常规 / 变细"——简单字(密度低)加粗 → 笔画≈3 排里字、厚实不单薄；复杂字
    // (密度高)变细 → 笔画≈2 排里字、笔画分得开不糊成团；但都实心填满 → 无笔画缺漏。里字在
    // 字身内收紧循环流动（满填循环 flowfill），既动态又辨形稳。对任意汉字稳健（只需栅格化）。
    const probe = this._rasterToCells(gridCols, gridRows, 0.40, (ctx, W, H) => {
      const fs = this._fitFont(ctx, char, W * 0.73, H * 0.73);
      this._drawTextMask(ctx, char, W / 2, H / 2, fs, { weight: 500, strokeWidth: SS * 0.15 });
    });
    const density = this._cellsDensity(probe);
    let p;
    if (density < 0.34)      p = { weight: 700, sw: SS * 0.40, thr: 0.34, fit: 0.70, fill: 0.95 }; // 简单字：加粗、厚实、填满更密(内部不松散)
    else if (density < 0.46) p = { weight: 600, sw: SS * 0.15, thr: 0.42, fit: 0.73, fill: 0.90 }; // 常规
    else                     p = { weight: 300, sw: 0,         thr: 0.50, fit: 0.78, fill: 0.85 }; // 复杂字：变细、笔画分得开

    const cells = this._rasterToCells(gridCols, gridRows, p.thr, (ctx, W, H) => {
      const fs = this._fitFont(ctx, char, W * p.fit, H * p.fit);
      this._drawTextMask(ctx, char, W / 2, H / 2, fs, { weight: p.weight, strokeWidth: p.sw });
    });
    const mask = this._sparsify(cells, maxChars);
    this.currentMask = mask;
    this.currentShape = char;
    this.constraintType = 'strict';
    return { mask, constraint: 'strict', fill: p.fill };
  }

  /** 字身格的"墨密度" = 格数 / 外接框面积（0..1）。高 → 笔画密集复杂；低 → 简单稀疏。@private */
  _cellsDensity(cells) {
    if (!cells || cells.length === 0) return 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of cells) {
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
    }
    const area = (maxX - minX + 1) * (maxY - minY + 1);
    return area > 0 ? cells.length / area : 0;
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
      } else if (type === 'lemniscate') {
        // ∞ 双纽线（Lemniscate of Bernoulli 的参数形式）
        const d = 1 + Math.sin(t) * Math.sin(t);
        x = cx + (scale * 1.35) * Math.cos(t) / d;
        y = cy + (scale * 1.35) * Math.sin(t) * Math.cos(t) / d;
      } else if (type === 'star') {
        // 五角星（半径随 cos(5θ) 起伏）
        const r = scale * (0.62 + 0.38 * Math.cos(5 * t));
        x = cx + r * Math.cos(t - Math.PI / 2);
        y = cy + r * Math.sin(t - Math.PI / 2);
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
    // 曲线/数学曲线 → 单条闭环路径，里字首尾相连绕圈流动。
    return { mask, paths: [{ cells: mask, loop: true }], constraint: 'flow', ordered: true };
  }

  /* ----------------------------------------------------------
   *  MASK → STROKE PATHS（连通分量 + 最近邻链）
   * ---------------------------------------------------------- */

  /**
   * 把一组掩码格子拆成"笔画路径"：先按 4-连通分出各笔画，再用最近邻链把每条
   * 笔画的格子排成一条有序路径（往返流动用）。纯函数，可测。
   * @param {Array<{x,y}>} cells
   * @param {number} cols
   * @returns {Array<{cells:Array<{x,y}>, loop:boolean}>}
   */
  _maskToPaths(cells, cols) {
    if (!cells || cells.length === 0) return [];
    const key = (x, y) => y * cols + x;
    const remaining = new Map();
    for (const c of cells) remaining.set(key(c.x, c.y), c);

    // 4-connected components via flood fill.
    const components = [];
    const seen = new Set();
    for (const c of cells) {
      const k0 = key(c.x, c.y);
      if (seen.has(k0)) continue;
      const comp = [];
      const stack = [c];
      seen.add(k0);
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nk = key(cur.x + dx, cur.y + dy);
          if (remaining.has(nk) && !seen.has(nk)) {
            seen.add(nk);
            stack.push(remaining.get(nk));
          }
        }
      }
      components.push(comp);
    }

    return components.map(comp => ({ cells: this._nnChain(comp), loop: false }));
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
   *  字形 → 骨架细笔画路径（细化 + 追踪 + 4连通桥接）
   * ---------------------------------------------------------- */

  /**
   * 把实心字形细化成 1 格宽的骨架中心线，追踪成若干有序笔画路径（开放/闭环），
   * 每条笔画 = 一排里字沿线流动。里字少、笔画清晰、不挤、协调流动。纯函数可测。
   * @param {Array<{x,y}>} solid @param {number} cols @param {number} rows
   * @returns {Array<{cells:Array<{x,y}>, loop:boolean}>}
   */
  _glyphToPaths(solid, cols, rows, bridge = true) {
    if (!solid || solid.length === 0) return [];
    const skel = this._thinZS(solid, cols, rows);
    let lines = this._traceSkeleton(skel, cols, rows);
    if (lines.length === 0) lines = [{ line: this._nnChain(solid), loop: false }];
    // bridge=false：保留 1 格宽中心线（含对角步）→ 配合 flow 的 8 邻域对角移动，里字沿斜
    // 笔画逐格流动、笔画维持单薄细线（清爽、易辨形，像心形曲线那样运动）。
    if (!bridge) {
      return lines.map(l => ({ cells: l.line, loop: l.loop })).filter(l => l.cells.length >= 1);
    }
    // 中心线含对角步（撇/捺/尖角）。里字只走上下左右(4连通)，对角目标的正交桥接格
    // 若不在掩码内 → 里字到不了下一格 → 流动卡死；而卡住的里字停在淡入/淡出区
    // (flowFade→0) 会隐形，于是整条斜笔画"缺失/静止/看不到流动"。故在每个对角步间
    // 补一个正交桥接格，令路径 4 连通：里字逐格顺畅流动、淡入淡出正常、笔画完整可见。
    return lines
      .map(l => ({ cells: this._bridgeDiagonals(l.line, l.loop), loop: l.loop }))
      .filter(l => l.cells.length >= 1);
  }

  /**
   * 让一条有序路径 4 连通：相邻两格若是对角关系，在它们之间插入一个正交桥接格
   * （横向先行）。闭环路径还会检查首尾衔接处。这样每对相邻格都只差一步上下左右，
   * 里字流动时总能逐格走到，永不因对角而卡死/隐形。纯函数可测。@private
   */
  _bridgeDiagonals(line, loop = false) {
    if (!line || line.length === 0) return line || [];
    const out = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const a = out[out.length - 1], b = line[i];
      if (a.x === b.x && a.y === b.y) continue;
      if (Math.abs(b.x - a.x) === 1 && Math.abs(b.y - a.y) === 1) {
        out.push({ x: b.x, y: a.y }); // 横向先行的正交桥接格
      }
      out.push(b);
    }
    if (loop && out.length > 2) {
      const a = out[out.length - 1], b = out[0];
      if (Math.abs(b.x - a.x) === 1 && Math.abs(b.y - a.y) === 1) {
        out.push({ x: b.x, y: a.y }); // 闭环首尾衔接的桥接格
      }
    }
    return out;
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
   * leftover degree-2 rings become closed loops; isolated dots become 1-cell paths.
   * @private @returns {Array<{line:Array<{x,y}>, loop:boolean}>}
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
    const dirOf = (a, b) => [Math.sign((b % cols) - (a % cols)), Math.sign(((b - b % cols) / cols) - ((a - a % cols) / cols))];
    const usedEdge = new Set();
    const paths = [];

    // 直通追踪：走到节点（含交叉点 degree>2）时不断开，而是挑"最顺直"（与当前方向夹角
    // 最小）的未用边继续走 → 把在交叉处相接的笔段并成一条长路径。汉字交叉点多，若每个
    // 交叉都断开会碎成几十条 1~2 格的小段（里字无处流动→静止），直通合并后是少数长笔画，
    // 里字成排连贯流动（清爽单薄、像曲线那样运动）。
    const walk = (start, first) => {
      const line = [toXY(start)];
      let prev = start, cur = first, pd = dirOf(start, first);
      usedEdge.add(eKey(start, first));
      while (true) {
        line.push(toXY(cur));
        const cand = nbrs(cur).filter(n => n !== prev && !usedEdge.has(eKey(cur, n)));
        if (cand.length === 0) break;
        let best = cand[0], bestDot = -9;
        for (const n of cand) {
          const d = dirOf(cur, n);
          const dot = d[0] * pd[0] + d[1] * pd[1]; // 越接近同向 dot 越大 → 最顺直
          if (dot > bestDot) { bestDot = dot; best = n; }
        }
        usedEdge.add(eKey(cur, best));
        pd = dirOf(cur, best); prev = cur; cur = best;
      }
      return line;
    };

    // 先从端点(度1)起笔 → 笔画从笔尖开始；再处理交叉点(度>2)的剩余边；再是纯环(度2)。
    for (const k of on) {
      if (deg(k) !== 1) continue;
      for (const n of nbrs(k)) {
        if (usedEdge.has(eKey(k, n))) continue;
        paths.push({ line: walk(k, n), loop: false });
      }
    }
    for (const k of on) {
      if (deg(k) <= 2) continue;
      for (const n of nbrs(k)) {
        if (usedEdge.has(eKey(k, n))) continue;
        paths.push({ line: walk(k, n), loop: false });
      }
    }
    for (const k of on) {
      if (deg(k) !== 2) continue;
      const n = nbrs(k).find(nn => !usedEdge.has(eKey(k, nn)));
      if (n === undefined) continue;
      paths.push({ line: walk(k, n), loop: true });
    }
    for (const k of on) {
      if (deg(k) === 0) paths.push({ line: [toXY(k)], loop: false });
    }
    return paths;
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
   * Draw text for mask extraction with explicit bold weight + stroke. The visual
   * layer still renders normal 里字; this only thickens the invisible sampling
   * stencil so small features (mouth "_", thin strokes) survive cell downsampling
   * (辨形 + 嘴更厚). @private
   */
  _drawTextMask(ctx, text, x, y, fs, { weight = 700, strokeWidth = SS * 0.5 } = {}) {
    ctx.font = `${weight} ${fs}px ${BOLD_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = strokeWidth;
    if (strokeWidth > 0) ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
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
   * Rasterise `drawFn` and return ALL lit grid cells (solid glyph, no sparsify).
   * Used for strict 密集定形 (颜文字/巨字) where里字 should fill the glyph cleanly.
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
