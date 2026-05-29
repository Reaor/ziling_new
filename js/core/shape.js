/**
 * Shape System for ZiLing (字灵)
 *
 * Handles shape templates and sampling — converting abstract shapes
 * (emoji expressions, giant characters, parametric curves) into grid cell
 * coordinate masks for the Ziling grid engine.
 *
 * All sampling uses off-screen Canvas 2D → getImageData → grid mapping.
 *
 * Shape constraint levels:
 *   'strict'   — cells must stay on mask exactly (emoji, megachar)
 *   'moderate' — slight drift allowed (reserved for future)
 *   'loose'    — mask is a loose suggestion (curves)
 *
 * @module shape
 * @license MIT
 */

/* ================================================================
 *  SHAPE TEMPLATE DATA
 * ================================================================ */

/**
 * Emoji expression templates with anatomy regions.
 * Each entry maps an emoji key to its mood classification, eye character
 * pairs, mouth character, and supported micro-expression animations.
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
 * Used as the `type` parameter to `sampleCurve()` and for shape dispatch.
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

/**
 * Converts abstract shapes into discrete grid cell masks.
 *
 * All sampling methods follow the same pipeline:
 *   1) Create off-screen canvas sized to the grid.
 *   2) Draw the shape at large scale, centred.
 *   3) Extract non-transparent pixels via getImageData.
 *   4) Optionally sparsify to meet `maxChars` limit.
 *   5) Store mask + constraint level on the instance.
 */
export class ShapeSystem {
  constructor() {
    /** @type {string|null} Currently active shape key */
    this.currentShape = null;
    /** @type {Array<{x:number, y:number}>} Allowed grid cells */
    this.currentMask = [];
    /**
     * How strictly agents must adhere to the mask.
     * @type {'strict'|'moderate'|'loose'}
     */
    this.constraintType = 'loose';
  }

  /* ----------------------------------------------------------
   *  EMOJI SAMPLING
   * ---------------------------------------------------------- */

  /**
   * Sample an emoji expression into a grid mask.
   *
   * Renders the emoji key string onto an off-screen canvas, then maps
   * non-transparent pixels to grid coordinates.
   *
   * @param {string}  emojiKey — key from {@link EMOJI_TEMPLATES} (e.g. '^_^')
   * @param {number}  gridCols — grid width in cells
   * @param {number}  gridRows — grid height in cells
   * @param {number}  [maxChars=80] — max number of target cells
   * @returns {{ mask: Array<{x:number, y:number}>, constraint: 'strict' }}
   */
  sampleEmoji(emojiKey, gridCols, gridRows, maxChars = 80) {
    const offCanvas = new OffscreenCanvas(gridCols, gridRows);
    const ctx = offCanvas.getContext('2d');

    // Render expression string large and centered
    const fontSize = Math.floor(gridRows * 0.55);
    ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';

    const template = EMOJI_TEMPLATES[emojiKey];
    const text = template ? emojiKey : '^_^';
    ctx.fillText(text, gridCols / 2, gridRows / 2);

    const pixels = this._extractPixels(offCanvas, gridCols, gridRows, maxChars);

    this.currentMask = pixels;
    this.currentShape = emojiKey;
    this.constraintType = 'strict';
    return { mask: pixels, constraint: 'strict' };
  }

  /* ----------------------------------------------------------
   *  MEGACHAR SAMPLING (giant Chinese character)
   * ---------------------------------------------------------- */

  /**
   * Sample a giant Chinese character into a grid mask.
   *
   * Supports optional vertical orientation via Canvas rotation.
   *
   * @param {string}  char       — single Chinese character to render
   * @param {number}  gridCols   — grid width in cells
   * @param {number}  gridRows   — grid height in cells
   * @param {number}  [maxChars=100] — max number of target cells
   * @param {'horizontal'|'vertical'} [direction='horizontal'] — text orientation
   * @returns {{ mask: Array<{x:number, y:number}>, constraint: 'strict' }}
   */
  sampleMegachar(char, gridCols, gridRows, maxChars = 100, direction = 'horizontal') {
    const offCanvas = new OffscreenCanvas(gridCols, gridRows);
    const ctx = offCanvas.getContext('2d');

    const fontSize = Math.min(gridCols, gridRows) * 0.85;
    ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';

    if (direction === 'vertical') {
      ctx.translate(gridCols / 2, gridRows / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(char, 0, 0);
    } else {
      ctx.fillText(char, gridCols / 2, gridRows / 2);
    }

    const pixels = this._extractPixels(offCanvas, gridCols, gridRows, maxChars);

    this.currentMask = pixels;
    this.currentShape = char;
    this.constraintType = 'strict';
    return { mask: pixels, constraint: 'strict' };
  }

  /* ----------------------------------------------------------
   *  PARAMETRIC CURVE SAMPLING
   * ---------------------------------------------------------- */

  /**
   * Sample a mathematical curve shape into a grid mask.
   *
   * Supported types:
   *   'rose'  — r = cos(2θ) four-petal rose curve
   *   'heart' — parametric heart curve
   *   (any other value falls back to a plain circle)
   *
   * @param {string}  type      — curve type identifier
   * @param {number}  gridCols  — grid width in cells
   * @param {number}  gridRows  — grid height in cells
   * @param {number}  [maxChars=60] — max number of target cells
   * @returns {{ mask: Array<{x:number, y:number}>, constraint: 'loose' }}
   */
  sampleCurve(type, gridCols, gridRows, maxChars = 60) {
    const offCanvas = new OffscreenCanvas(gridCols, gridRows);
    const ctx = offCanvas.getContext('2d');
    const cx = gridCols / 2;
    const cy = gridRows / 2;

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const scale = Math.min(gridCols, gridRows) * 0.4;

    switch (type) {
      case 'rose':
        // Four-petal rose: r = cos(2θ)
        for (let t = 0; t < Math.PI * 2; t += 0.02) {
          const r = Math.cos(2 * t) * scale;
          const x = cx + r * Math.cos(t);
          const y = cy + r * Math.sin(t);
          if (t === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        break;

      case 'heart':
        // Parametric heart curve
        for (let t = 0; t < Math.PI * 2; t += 0.02) {
          const x = cx + 16 * Math.pow(Math.sin(t), 3) * (scale / 20);
          const y = cy - (13 * Math.cos(t) - 5 * Math.cos(2 * t)
                          - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * (scale / 20);
          if (t === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        break;

      default:
        ctx.arc(cx, cy, scale, 0, Math.PI * 2);
        break;
    }

    ctx.stroke();

    const pixels = this._extractPixels(offCanvas, gridCols, gridRows, maxChars);

    this.currentMask = pixels;
    this.currentShape = type;
    this.constraintType = 'loose';
    return { mask: pixels, constraint: 'loose' };
  }

  /* ----------------------------------------------------------
   *  MASK QUERIES
   * ---------------------------------------------------------- */

  /**
   * Return the current shape's allowed grid cell mask.
   * @returns {Array<{x:number, y:number}>}
   */
  getCurrentMask() {
    return this.currentMask;
  }

  /**
   * Check whether a grid cell coordinate lies within the current shape mask.
   * @param {number} x — grid column
   * @param {number} y — grid row
   * @returns {boolean}
   */
  isInShape(x, y) {
    return this.currentMask.some(p => p.x === x && p.y === y);
  }

  /* ----------------------------------------------------------
   *  INTERNAL HELPERS
   * ---------------------------------------------------------- */

  /**
   * Extract non-transparent pixels from an off-screen canvas and
   * optionally sparsify to a maximum count.
   *
   * @private
   * @param {OffscreenCanvas} offCanvas — pre-rendered canvas
   * @param {number}          cols      — pixel width
   * @param {number}          rows      — pixel height
   * @param {number}          maxChars  — upper bound for cells
   * @returns {Array<{x:number, y:number}>}
   */
  _extractPixels(offCanvas, cols, rows, maxChars) {
    const imageData = offCanvas.getContext('2d').getImageData(0, 0, cols, rows);
    const data = imageData.data;
    let pixels = [];

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = (y * cols + x) * 4;
        if (data[idx + 3] > 100) { // alpha > 100 → non-transparent
          pixels.push({ x, y });
        }
      }
    }

    // Sparse sampling if we have more pixels than allowed
    if (pixels.length > maxChars) {
      const step = Math.ceil(pixels.length / maxChars);
      pixels = pixels.filter((_, i) => i % step === 0);
    }

    return pixels;
  }
}
