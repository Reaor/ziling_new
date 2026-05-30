/**
 * Character — A single Chinese character agent on the grid.
 *
 * Each Character represents one 汉字 that can move, plan paths, dissolve,
 * spawn, and carry rendering state. Designed for object pooling to minimize
 * GC pressure in a 60fps Canvas loop.
 *
 * @module character
 */

// ── State enum ──────────────────────────────────────────────────────────

/**
 * Valid states for a Character.
 * @readonly
 * @enum {string}
 */
export const CHAR_STATE = {
  /** Waiting, not moving */
  IDLE: 'idle',
  /** Path request sent, waiting for cross-frame computation */
  PLANNING: 'planning',
  /** Following a pre-computed path step by step */
  MOVING: 'moving',
  /** Alpha-fading out toward 0 */
  DISSOLVING: 'dissolving',
  /** Alpha-fading in from 0 toward 1 */
  SPAWNING: 'spawning'
};

// ── Character ───────────────────────────────────────────────────────────

/**
 * A single Chinese character agent on the grid.
 *
 * Tracks grid position, display interpolation, path, and rendering
 * properties. Designed to be recycled via {@link CharacterPool}.
 */
export class Character {
  /**
   * @param {number}   id    Unique identifier
   * @param {string}   char  The 汉字 character (single glyph)
   * @param {number}   gridX Starting grid column
   * @param {number}   gridY Starting grid row
   */
  constructor(id, char, gridX, gridY) {
    /** @type {number} Unique identifier */
    this.id = id;
    /** @type {string} The 汉字 glyph */
    this.char = char;
    /** @type {number} Current grid column */
    this.gridX = gridX;
    /** @type {number} Current grid row */
    this.gridY = gridY;
    /** @type {number} Target grid column */
    this.targetGridX = gridX;
    /** @type {number} Target grid row */
    this.targetGridY = gridY;
    /** @type {number} Smoothed display X (pixels) */
    this.displayX = 0;
    /** @type {number} Smoothed display Y (pixels) */
    this.displayY = 0;
    /** @type {number} Micro-bounce offset X (pixels) */
    this.microOffsetX = 0;
    /** @type {number} Micro-bounce offset Y (pixels) */
    this.microOffsetY = 0;
    /** @type {number} Previous grid column (for interpolation) */
    this.prevGridX = gridX;
    /** @type {number} Previous grid row (for interpolation) */
    this.prevGridY = gridY;
    /** @type {Array<{x: number, y: number}>} Planned path steps */
    this.path = [];
    /** @type {number} Time slot reserved for this path */
    this.pathTimeSlot = 0;
    /** @type {string} Fill colour (CSS hex) */
    this.color = '#e0e0e0';
    /** @type {number} Opacity 0..1 */
    this.alpha = 1.0;
    /** @type {number} Target opacity the loop eases `alpha` toward (1=in, 0=out).
     *  里字自适应增减时用于柔和淡入/淡出；淡出至 0 后由编排层回收。 */
    this.fadeTarget = 1.0;
    /** @type {number} 流动淡入/淡出因子（开放笔画首端淡入、尾端淡出；1=全亮）。
     *  渲染时与 alpha 相乘。由 MotionEngine 每帧按沿线进度设置。 */
    this.flowFade = 1.0;
    /** @type {string} Current state from {@link CHAR_STATE} */
    this.state = CHAR_STATE.IDLE;
    /** @type {string|null} Shape region label (e.g. 'outer', 'inner') */
    this.region = null;
    /** @type {number} Anchor grid X for shape-relative positioning */
    this.anchorX = gridX;
    /** @type {number} Anchor grid Y for shape-relative positioning */
    this.anchorY = gridY;
    /** @type {number} Shape-level offset X (grid units) */
    this.shapeOffsetX = 0;
    /** @type {number} Shape-level offset Y (grid units) */
    this.shapeOffsetY = 0;
  }

  /**
   * Reset all fields to fresh defaults, preserving `this.id`.
   * Used by the pool when recycling an instance.
   *
   * @param {string} char  The 汉字 glyph
   * @param {number} gridX Starting grid column
   * @param {number} gridY Starting grid row
   */
  reset(char, gridX, gridY) {
    this.char = char;
    this.gridX = gridX;
    this.gridY = gridY;
    this.targetGridX = gridX;
    this.targetGridY = gridY;
    this.displayX = 0;
    this.displayY = 0;
    this.microOffsetX = 0;
    this.microOffsetY = 0;
    this.prevGridX = gridX;
    this.prevGridY = gridY;
    this.path = [];
    this.pathTimeSlot = 0;
    this.color = '#e0e0e0';
    this.alpha = 1.0;
    this.flowFade = 1.0;
    this.fadeTarget = 1.0;
    this.state = CHAR_STATE.IDLE;
    this.region = null;
    this.anchorX = gridX;
    this.anchorY = gridY;
    this.shapeOffsetX = 0;
    this.shapeOffsetY = 0;
  }
}

// ── CharacterPool ────────────────────────────────────────────────────────

/**
 * Object pool for {@link Character} instances.
 *
 * Pre-allocates a batch of "cold" Characters on construction. Acquired
 * instances are tracked by id in an active map. Released instances are
 * reset and returned to the pool for reuse, keeping GC pressure low.
 */
export class CharacterPool {
  /**
   * @param {number} [maxSize=200] Number of pre-allocated cold instances
   */
  constructor(maxSize = 200) {
    /** @type {Character[]} Pool of inactive, reset Character instances */
    this.pool = [];
    /** @type {Map<number, Character>} Active characters keyed by id */
    this.active = new Map();
    /** @type {number} Monotonically increasing id counter */
    this.nextId = 0;
    this._preCreate(maxSize);
  }

  /**
   * Pre-allocate `size` cold Character instances.
   * These sit in the pool with dummy data (id=0, char='', gridX=0, gridY=0)
   * ready to be acquired and reset.
   *
   * @param {number} size Number of instances to create
   * @private
   */
  _preCreate(size) {
    for (let i = 0; i < size; i++) {
      this.pool.push(new Character(0, '', 0, 0));
    }
  }

  /**
   * Acquire a Character from the pool (or create one if pool is empty).
   * The returned instance is reset with the given parameters and assigned
   * a fresh unique id.
   *
   * @param {string} char  The 汉字 glyph
   * @param {number} gridX Starting grid column
   * @param {number} gridY Starting grid row
   * @returns {Character} An active, reset Character
   */
  acquire(char, gridX, gridY) {
    const id = this.nextId++;
    let character;
    if (this.pool.length > 0) {
      character = this.pool.pop();
      character.reset(char, gridX, gridY);
    } else {
      character = new Character(id, char, gridX, gridY);
    }
    character.id = id;
    this.active.set(id, character);
    return character;
  }

  /**
   * Release an active Character back to the pool.
   * The instance is reset to empty defaults and moved from `active` to `pool`.
   * If the id is not found this is a silent no-op.
   *
   * **Important:** The caller must call `grid.vacate(char.gridX, char.gridY)`
   * before releasing, otherwise the grid will retain a stale reference.
   *
   * @param {number} charId The Character's unique id
   */
  release(charId) {
    const character = this.active.get(charId);
    if (!character) return;
    character.reset('', 0, 0);
    this.active.delete(charId);
    this.pool.push(character);
  }

  /**
   * Look up an active Character by id.
   *
   * @param {number} charId Unique id
   * @returns {Character|undefined} The Character, or undefined if not active
   */
  get(charId) {
    return this.active.get(charId);
  }

  /**
   * Get all currently active Characters.
   *
   * @returns {Character[]} Snapshot of active Characters
   */
  getAll() {
    return Array.from(this.active.values());
  }

  /**
   * Number of currently active Characters.
   *
   * @returns {number}
   */
  count() {
    return this.active.size;
  }

  /**
   * Check whether a given id is currently active.
   *
   * @param {number} charId Unique id
   * @returns {boolean}
   */
  isActive(charId) {
    return this.active.has(charId);
  }
}
