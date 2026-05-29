const TAP_TIMEOUT = 300;
const DOUBLE_TAP_WINDOW = 300;
const LONG_PRESS_TIME = 500;
const DRAG_THRESHOLD = 8;

const STATE = { IDLE: 'idle', MAYBE_TAP: 'maybe_tap', TAP_PENDING: 'tap_pending', DRAGGING: 'dragging', LONG_PRESS: 'long_press' };

export class GestureRecognizer {
  constructor(canvas, cellSize, callbacks) {
    this.canvas = canvas;
    this.cellSize = cellSize;
    this.cb = callbacks;
    this._state = STATE.IDLE;
    this._startPos = { x: 0, y: 0 };
    this._lastTapTime = 0;
    this._lastTapPos = { x: -1, y: -1 };
    this._longPressTimer = null;
    this._tapTimer = null;
    this._bindEvents();
  }

  toGrid(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (px - rect.left) * (this.canvas.width / rect.width / devicePixelRatio);
    const y = (py - rect.top) * (this.canvas.height / rect.height / devicePixelRatio);
    return { col: Math.floor(x / this.cellSize), row: Math.floor(y / this.cellSize), px: x, py: y };
  }

  _bindEvents() {
    const el = this.canvas;
    el.addEventListener('touchstart', e => { e.preventDefault(); const t = e.touches[0]; this._onDown(t.clientX, t.clientY); }, { passive: false });
    el.addEventListener('touchmove', e => { e.preventDefault(); const t = e.touches[0]; this._onMove(t.clientX, t.clientY); }, { passive: false });
    el.addEventListener('touchend', e => { e.preventDefault(); this._onUp(); }, { passive: false });
    el.addEventListener('mousedown', e => { this._onDown(e.clientX, e.clientY); });
    el.addEventListener('mousemove', e => { if (this._state === STATE.MAYBE_TAP || this._state === STATE.DRAGGING) this._onMove(e.clientX, e.clientY); });
    el.addEventListener('mouseup', () => { this._onUp(); });
    el.addEventListener('mouseleave', () => {
      if (this._state === STATE.MAYBE_TAP) this._reset();
      if (this._state === STATE.DRAGGING) { this.cb.onDragEnd?.(); this._reset(); }
    });
  }

  _onDown(px, py) {
    const pos = this.toGrid(px, py); this._startPos = { x: px, y: py }; this._state = STATE.MAYBE_TAP;
    this._longPressTimer = setTimeout(() => { if (this._state === STATE.MAYBE_TAP) { this._state = STATE.LONG_PRESS; this.cb.onLongPress?.(pos.col, pos.row); } }, LONG_PRESS_TIME);
  }

  _onMove(px, py) {
    if (this._state !== STATE.MAYBE_TAP && this._state !== STATE.DRAGGING) return;
    const dx = px - this._startPos.x, dy = py - this._startPos.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > DRAG_THRESHOLD) {
      clearTimeout(this._longPressTimer);
      if (this._state === STATE.MAYBE_TAP) { this._state = STATE.DRAGGING; const pos = this.toGrid(this._startPos.x, this._startPos.y); this.cb.onDragStart?.(pos.col, pos.row); }
      if (this._state === STATE.DRAGGING) { const pos = this.toGrid(px, py); this.cb.onDragMove?.(pos.col, pos.row, dx, dy); }
    }
  }

  _onUp() {
    clearTimeout(this._longPressTimer);
    if (this._state === STATE.MAYBE_TAP) {
      const now = Date.now(); const pos = this.toGrid(this._startPos.x, this._startPos.y);
      if (now - this._lastTapTime < DOUBLE_TAP_WINDOW && pos.col === this._lastTapPos.col && pos.row === this._lastTapPos.row) {
        clearTimeout(this._tapTimer); this._state = STATE.IDLE; this._lastTapTime = 0; this.cb.onDoubleTap?.(pos.col, pos.row);
      } else {
        this._state = STATE.TAP_PENDING;
        this._tapTimer = setTimeout(() => { this._state = STATE.IDLE; this.cb.onTap?.(pos.col, pos.row); }, DOUBLE_TAP_WINDOW);
        this._lastTapTime = now; this._lastTapPos = { col: pos.col, row: pos.row };
      }
    }
    if (this._state === STATE.DRAGGING) { this.cb.onDragEnd?.(); this._reset(); }
  }

  _reset() { this._state = STATE.IDLE; clearTimeout(this._longPressTimer); clearTimeout(this._tapTimer); }
  destroy() {}
}
