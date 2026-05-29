/**
 * Shape System for ZiLing (字灵)
 * @module shape
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
  '≥◽≤':   { mood:'bigSmile',   eyes:['≥','≤'],  mouth:'◽', micro:['blink','mouthWiggle'] },
  '(^_^)/':{ mood:'wave',       eyes:['^','^'],  mouth:'_', micro:['blink','breath'] },
};

export const SHAPE_TYPES = {
  MEGACHAR: 'megachar',
  CURVE_ROSE: 'curve_rose',
  CURVE_HEART: 'curve_heart',
  CURVE_PINWHEEL: 'curve_pinwheel',
  CLOCK: 'clock',
};

export class ShapeSystem {
  constructor() {
    this.currentShape = null;
    this.currentMask = [];
    this.constraintType = 'loose';
  }

  sampleEmoji(emojiKey, gridCols, gridRows, maxChars = 80) {
    const offCanvas = new OffscreenCanvas(gridCols, gridRows);
    const ctx = offCanvas.getContext('2d');
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

  sampleMegachar(char, gridCols, gridRows, maxChars = 100, direction = 'horizontal') {
    const offCanvas = new OffscreenCanvas(gridCols, gridRows);
    const ctx = offCanvas.getContext('2d');
    const fontSize = Math.min(gridCols, gridRows) * 0.85;
    ctx.font = `${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    if (direction === 'vertical') { ctx.translate(gridCols / 2, gridRows / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(char, 0, 0); }
    else ctx.fillText(char, gridCols / 2, gridRows / 2);
    const pixels = this._extractPixels(offCanvas, gridCols, gridRows, maxChars);
    this.currentMask = pixels;
    this.currentShape = char;
    this.constraintType = 'strict';
    return { mask: pixels, constraint: 'strict' };
  }

  sampleCurve(type, gridCols, gridRows, maxChars = 60) {
    const offCanvas = new OffscreenCanvas(gridCols, gridRows);
    const ctx = offCanvas.getContext('2d');
    const cx = gridCols / 2, cy = gridRows / 2;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath();
    const scale = Math.min(gridCols, gridRows) * 0.4;
    switch (type) {
      case 'rose':
        for (let t = 0; t < Math.PI * 2; t += 0.02) { const r = Math.cos(2 * t) * scale; const x = cx + r * Math.cos(t), y = cy + r * Math.sin(t); if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        break;
      case 'heart':
        for (let t = 0; t < Math.PI * 2; t += 0.02) { const x = cx + 16 * Math.pow(Math.sin(t), 3) * (scale / 20); const y = cy - (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) * (scale / 20); if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        break;
      default: ctx.arc(cx, cy, scale, 0, Math.PI * 2); break;
    }
    ctx.stroke();
    const pixels = this._extractPixels(offCanvas, gridCols, gridRows, maxChars);
    this.currentMask = pixels;
    this.currentShape = type;
    this.constraintType = 'loose';
    return { mask: pixels, constraint: 'loose' };
  }

  getCurrentMask() { return this.currentMask; }
  isInShape(x, y) { return this.currentMask.some(p => p.x === x && p.y === y); }

  _extractPixels(offCanvas, cols, rows, maxChars) {
    const imageData = offCanvas.getContext('2d').getImageData(0, 0, cols, rows);
    const data = imageData.data;
    let pixels = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const idx = (y * cols + x) * 4; if (data[idx + 3] > 100) pixels.push({ x, y }); }
    if (pixels.length > maxChars) { const step = Math.ceil(pixels.length / maxChars); pixels = pixels.filter((_, i) => i % step === 0); }
    return pixels;
  }
}
