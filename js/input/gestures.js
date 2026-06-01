/**
 * Gesture Recognizer — tap / double-tap / long-press / drag
 *
 * Works with both touch and mouse events. Converts pixel positions to
 * grid coordinates using the provided cellSize.
 *
 * @module gestures
 */

// Timing thresholds
const TAP_TIMEOUT = 300;       // ms — max duration for a tap
const DOUBLE_TAP_WINDOW = 400; // ms — 两次点击的最大间隔（移动端手指较慢，放宽到 400ms）
const DOUBLE_TAP_DIST = 44;    // px — 两次点击的最大位移（移动端手指会偏移一两格，按像素容差而非"同一格"）
const LONG_PRESS_TIME = 650;   // ms — 长按回归原态的判定时长（更长一点→拖着玩不易误触）
const DRAG_THRESHOLD = 8;      // px — 超过即转为拖动并取消长按（任意拖动都能即时打断长按）

// Gesture states
const STATE = {
  IDLE: 'idle',
  MAYBE_TAP: 'maybe_tap',       // finger down, waiting to see what happens
  TAP_PENDING: 'tap_pending',   // finger up, waiting to confirm single vs double
  DRAGGING: 'dragging',
  LONG_PRESS: 'long_press',
};

export class GestureRecognizer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} cellSize — px per grid cell (for coordinate conversion)
   * @param {Object} callbacks
   * @param {Function} callbacks.onTap — (col:number, row:number) => void
   * @param {Function} callbacks.onDoubleTap — (col:number, row:number) => void
   * @param {Function} callbacks.onLongPress — (col:number, row:number) => void
   * @param {Function} callbacks.onDragStart — (col:number, row:number) => void
   * @param {Function} callbacks.onDragMove — (col:number, row:number, dx:number, dy:number) => void
   * @param {Function} callbacks.onDragEnd — () => void
   */
  constructor(canvas, cellSize, callbacks) {
    this.canvas = canvas;
    this.cellSize = cellSize;
    this.cb = callbacks;

    this._state = STATE.IDLE;
    this._startPos = { x: 0, y: 0 };
    this._lastTapTime = 0;
    this._lastTapPx = { x: -1e4, y: -1e4 }; // 上一次点击的**像素**位置（双击按像素容差判定）
    this._longPressTimer = null;
    this._tapTimer = null;

    this._bindEvents();
  }

  /**
   * Convert a pixel position (relative to canvas) to grid coordinates.
   */
  toGrid(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (px - rect.left) * (this.canvas.width / rect.width / devicePixelRatio);
    const y = (py - rect.top) * (this.canvas.height / rect.height / devicePixelRatio);
    return {
      col: Math.floor(x / this.cellSize),
      row: Math.floor(y / this.cellSize),
      px: x,
      py: y,
    };
  }

  _bindEvents() {
    const el = this.canvas;

    // Touch events
    el.addEventListener('touchstart', e => {
      e.preventDefault();
      const t = e.touches[0];
      this._onDown(t.clientX, t.clientY);
    }, { passive: false });

    el.addEventListener('touchmove', e => {
      e.preventDefault();
      const t = e.touches[0];
      this._onMove(t.clientX, t.clientY);
    }, { passive: false });

    el.addEventListener('touchend', e => {
      e.preventDefault();
      this._onUp();
    }, { passive: false });

    // Mouse events (for desktop dev)
    el.addEventListener('mousedown', e => {
      this._onDown(e.clientX, e.clientY);
    });

    el.addEventListener('mousemove', e => {
      if (this._state === STATE.MAYBE_TAP || this._state === STATE.DRAGGING) {
        this._onMove(e.clientX, e.clientY);
      }
    });

    el.addEventListener('mouseup', () => {
      this._onUp();
    });

    // Cancel on mouse leave
    el.addEventListener('mouseleave', () => {
      if (this._state === STATE.MAYBE_TAP) {
        this._reset();
      }
      if (this._state === STATE.DRAGGING) {
        this.cb.onDragEnd?.();
        this._reset();
      }
    });
  }

  _onDown(px, py) {
    const pos = this.toGrid(px, py);
    this._startPos = { x: px, y: py };
    this._state = STATE.MAYBE_TAP;

    // Start long-press timer
    this._longPressTimer = setTimeout(() => {
      if (this._state === STATE.MAYBE_TAP) {
        this._state = STATE.LONG_PRESS;
        this.cb.onLongPress?.(pos.col, pos.row);
      }
    }, LONG_PRESS_TIME);
  }

  _onMove(px, py) {
    if (this._state !== STATE.MAYBE_TAP && this._state !== STATE.DRAGGING) return;

    const dx = px - this._startPos.x;
    const dy = py - this._startPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > DRAG_THRESHOLD) {
      clearTimeout(this._longPressTimer);

      if (this._state === STATE.MAYBE_TAP) {
        this._state = STATE.DRAGGING;
        const pos = this.toGrid(this._startPos.x, this._startPos.y);
        this.cb.onDragStart?.(pos.col, pos.row, pos.px, pos.py);
      }

      if (this._state === STATE.DRAGGING) {
        const pos = this.toGrid(px, py);
        this.cb.onDragMove?.(pos.col, pos.row, pos.px, pos.py);
      }
    }
  }

  _onUp() {
    clearTimeout(this._longPressTimer);

    if (this._state === STATE.MAYBE_TAP) {
      const now = Date.now();
      const pos = this.toGrid(this._startPos.x, this._startPos.y);
      // 双击判定：时间窗内 + 两次点击**像素距离**在容差内（不要求落在同一格 → 移动端手指
      // 微偏移也能识别为双击）。位移用屏幕像素（this._startPos 是 clientX/Y）。
      const ddx = this._startPos.x - this._lastTapPx.x, ddy = this._startPos.y - this._lastTapPx.y;
      const isDouble =
        now - this._lastTapTime < DOUBLE_TAP_WINDOW &&
        (ddx * ddx + ddy * ddy) <= DOUBLE_TAP_DIST * DOUBLE_TAP_DIST;

      this._state = STATE.IDLE;
      if (isDouble) {
        // 第二下：只触发双击（首下已即时触发过 tap）。
        this._lastTapTime = 0;
        this._lastTapPx = { x: -1e4, y: -1e4 };
        this.cb.onDoubleTap?.(pos.col, pos.row);
      } else {
        // 即时响应：抬手立刻触发 tap，不再等双击窗口（消除点击延迟感）。
        this._lastTapTime = now;
        this._lastTapPx = { x: this._startPos.x, y: this._startPos.y };
        this.cb.onTap?.(pos.col, pos.row);
      }
    }

    if (this._state === STATE.DRAGGING) {
      this.cb.onDragEnd?.();
      this._reset();
    }
  }

  _reset() {
    this._state = STATE.IDLE;
    clearTimeout(this._longPressTimer);
    clearTimeout(this._tapTimer);
  }

  destroy() {
    // TODO: remove event listeners if needed
  }
}
