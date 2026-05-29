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
    const mask = this._rasterToMask(gridCols, gridRows, maxChars, 0.10, (ctx, W, H) => {
      // 颜文字 are wide and short — fit mostly by width, keep a short band.
      const fs = this._fitFont(ctx, text, W * 0.94, H * 0.6);
      ctx.font = `${fs}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, W / 2, H / 2);
    });

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
  sampleMegachar(char, gridCols, gridRows, maxChars = 100, direction = 'horizontal') {
    const mask = this._rasterToMask(gridCols, gridRows, maxChars, 0.14, (ctx, W, H) => {
      const fs = this._fitFont(ctx, char, W * 0.9, H * 0.9);
      ctx.font = `${fs}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(char, W / 2, H / 2);
    });

    this.currentMask = mask;
    this.currentShape = char;
    this.constraintType = 'strict';
    return { mask, constraint: 'strict' };
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
