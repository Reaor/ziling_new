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
  sampleEmoji(emojiKey, gridCols, gridRows, maxChars = 84) {
    const text = EMOJI_TEMPLATES[emojiKey] ? emojiKey : '^_^';
    // 颜文字重在辨形：眼/嘴要分明、笔画要**细**（之前加粗+描边导致糊成一团）。
    // 用正常字重、不描边、阈值偏高 → 只点亮笔画核心，眼嘴清爽可辨。
    const mask = this._rasterToMask(gridCols, gridRows, maxChars, 0.18, (ctx, W, H) => {
      const fs = this._fitFont(ctx, text, W * 0.90, H * 0.52);
      ctx.font = `${fs}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, W / 2, H / 2);
    });

    this.currentMask = mask;
    this.currentShape = emojiKey;
    this.constraintType = 'flow';
    // 拆成每条笔画的有序路径（往返流动），让全体里字实心填满字形并持续运动。
    return { mask, paths: this._maskToPaths(mask, gridCols), constraint: 'flow' };
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
  sampleMegachar(char, gridCols, gridRows, maxChars = 140, direction = 'horizontal') {
    const mask = this._rasterToMask(gridCols, gridRows, maxChars, 0.09, (ctx, W, H) => {
      // 加粗 + 描边取样，让笔画更连贯、更易辨形（视觉层仍渲染普通里字）。
      const fs = this._fitFont(ctx, char, W * 0.92, H * 0.92);
      this._drawTextMask(ctx, char, W / 2, H / 2, fs, {
        weight: 800,
        strokeWidth: Math.max(SS * 0.65, fs * 0.03),
      });
    });

    this.currentMask = mask;
    this.currentShape = char;
    this.constraintType = 'flow';
    return { mask, paths: this._maskToPaths(mask, gridCols), constraint: 'flow' };
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
    return this._sparsify(cells, maxChars);
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
