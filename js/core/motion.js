/**
 * PIBT-based Motion Engine v3 — collision-free + continuous movement.
 *
 * Based on Priority Inheritance with Backtracking (Okumura et al., AIJ 2022).
 * This version addresses the "stuck character" problem by:
 *   1. Only constraining characters to shape mask when mask is active
 *   2. Characters NOT in shape constraint wander freely anywhere
 *   3. Stuck detection with target reassignment (finds far-away cells)
 *   4. When all candidates blocked, character stays — target reassigned if stuck >5 ticks
 *
 * @module motion
 * @requires ./character.js, ./grid.js
 */

const DIRS = [
  { dx:  0, dy: -1 },
  { dx:  0, dy:  1 },
  { dx: -1, dy:  0 },
  { dx:  1, dy:  0 },
];

const STUCK_LIMIT = 5; // ticks before aggressive target reassignment

export class MotionEngine {
  constructor(grid, cellSize, cellPadding = 0) {
    this.grid = grid;
    this.cellSize = cellSize;
    this.cellPadding = cellPadding;
    this.tickDuration = 200;
    // 拖动时改用更快的固定 tick（仍是匀速 —— 不随拖拽"速度"变化，只是
    // 拖动这一"模态"整体走得更快），让里字能跟手追上被拖去的位置；松手后
    // 在动量衰减期间平滑回落到常速。详见 _effectiveTick()。
    this.dragTickDuration = 85;
    this._dragActive = false;
    this.accumulatedTime = 0;
    this.tickProgress = 0;
    this.characters = new Map();
    this._stepCount = 0;

    // PIBT state
    this._occupiedNow = [];
    this._occupiedNxt = [];
    this._nextPos = [];

    // Wander targets
    this._wanderTargets = new Map();

    // Direction tracking
    this._currentDirs = new Map();
    this._directionStreaks = new Map();

    // Stuck tracking
    this._stuckTicks = new Map();

    // Interpolation stagger
    this._moveStartTimes = new Map();

    // Shape constraint (per-character, NOT global)
    this._shapeChars = new Set();
    this._shapeMask = null;
    // 'strict' → 颜文字/巨字 hold formation near anchors (易辨形)
    // 'loose'  → curves/flowers roam the whole mask freely
    // 'flow'   → 里字沿一条有序环路逐格流动（贪吃蛇/细轮廓流动）
    this._shapeConstraint = 'loose';
    this._shapeDragBaseMask = null;
    this._lastShapeDragShift = { col: 0, row: 0 };

    // Flow（流动）state —— ordered ring/path the里字 stream along single-file.
    this._flowCells = null;          // ordered Array<{x,y}> forming the path
    this._flowIndexOf = new Map();   // charId → current path index it heads to
    this._flowLoop = true;           // closed loop (ring/curve) vs open path

    // Orbit（拖动环绕）state —— 里字聚成方形，按同心方环逐层旋转，跟手整体平移。
    this._orbit = false;
    this._orbitCenter = { x: 0, y: 0 };
    this._orbitOf = new Map();       // charId → { ring, slot }
    this._ringPerimCache = new Map(); // ring radius → ordered perimeter offsets
    this._orbitDir = 1;              // rotation direction (CW)
    this._orbitElapsed = 0;          // ms since orbit began (drives 逐渐加速)
    this.orbitTickStart = 175;       // 起始较慢
    this.orbitTickEnd = 70;          // 逐渐加速到的最快 tick
    this.orbitRampMs = 1100;

    // Drag bias state
    this.dragBias = null; // { dx, dy, strength: 0-1 } — dx/dy is a unit-ish direction
    this._dragMomentum = false; // after release, bias decays instead of dying instantly
    this.dragMomentumMs = 650;  // time for the post-release "slosh" to settle
  }

  /** Public getter/setter bridging _shapeMask for external access */
  get shapeMask() { return this._shapeMask; }
  set shapeMask(v) { this._shapeMask = v; }

  // ── Public API ────────────────────────────────────────

  registerCharacter(char) {
    this.characters.set(char.id, char);
    this.grid.occupy(char.id, char.gridX, char.gridY);
    char.prevGridX = char.gridX;
    char.prevGridY = char.gridY;
    this._assignWanderTarget(char);
    // Random initial direction bias — prevents all chars moving the same way at start
    const initDir = DIRS[Math.floor(Math.random() * 4)];
    this._currentDirs.set(char.id, { dx: initDir.dx, dy: initDir.dy });
    this._directionStreaks.set(char.id, Math.floor(Math.random() * 10)); // Random initial streak
  }

  unregisterCharacter(charId) {
    const char = this.characters.get(charId);
    if (!char) return;
    this.grid.vacate(char.gridX, char.gridY);
    this.characters.delete(charId);
    this._wanderTargets.delete(charId);
    this._directionStreaks.delete(charId);
    this._currentDirs.delete(charId);
    this._stuckTicks.delete(charId);
    this._moveStartTimes.delete(charId);
    this._shapeChars.delete(charId);
  }

  /** Set a specific wander target (for shape transitions) */
  setTarget(charId, tx, ty) {
    this._wanderTargets.set(charId, { tx, ty });
  }

  /** Activate shape constraint for this character */
  constrainToShape(charId) {
    this._shapeChars.add(charId);
  }

  /** Release shape constraint */
  freeFromShape(charId) {
    this._shapeChars.delete(charId);
  }

  /**
   * Force-scatter a character a SHORT distance away from a tap point — a small,
   * tidy radial puff rather than flinging it across the screen. Keeps movement
   * cell-by-cell; the里字 drifts home (reforms) shortly after.
   * @param {number} charId
   * @param {number} fromCol — center of the puff
   * @param {number} fromRow
   * @param {number} [radius=3] — max cells to push outward
   */
  scatter(charId, fromCol, fromRow, radius = 3) {
    const char = this.characters.get(charId);
    if (!char) return;

    // Radial direction away from the tap (snapped to the grid).
    let dx = char.gridX - fromCol;
    let dy = char.gridY - fromRow;
    if (dx === 0 && dy === 0) {
      const a = Math.random() * Math.PI * 2;
      dx = Math.cos(a); dy = Math.sin(a);
    }
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;

    // Push to the farthest free cell within `radius` along the radial ray.
    let bestX = char.gridX, bestY = char.gridY;
    for (let step = radius; step >= 1; step--) {
      const nx = Math.round(char.gridX + ux * step);
      const ny = Math.round(char.gridY + uy * step);
      if (nx < 0 || ny < 0 || nx >= this.grid.cols || ny >= this.grid.rows) continue;
      if (this.grid.isOccupied(nx, ny)) continue;
      bestX = nx; bestY = ny;
      break;
    }

    this._wanderTargets.set(char.id, { tx: bestX, ty: bestY });
    this._stuckTicks.set(char.id, 0);
    this._directionStreaks.set(char.id, 0);
    this._shapeChars.delete(charId); // briefly leave formation, then reform
  }

  /**
   * Set the shape mask and constrain all assigned characters.
   * @param {Array<{x,y}>} mask
   * @param {number[]} charIds
   * @param {'strict'|'loose'} [constraint='loose'] — strict holds formation
   *   (颜文字/巨字, 易辨形); loose lets里字 roam the whole mask (curves/flowers).
   */
  setShapeMask(mask, charIds, constraint = 'loose') {
    this._shapeMask = mask;
    this._shapeConstraint = constraint;
    for (const id of charIds) {
      this._shapeChars.add(id);
    }
    this._assignShapeTargets();
  }

  /**
   * Start a drag operation without throwing away the active shape.
   * The drag preview shifts the mask target while agents still walk cell-by-cell.
   */
  beginShapeDrag() {
    this._dragMomentum = false; // a fresh grab cancels any leftover slosh
    this._dragActive = true;    // 切到快速跟手 tick
    if (!this._shapeMask || this._shapeMask.length === 0) {
      this._shapeDragBaseMask = null;
      return false;
    }
    this._shapeDragBaseMask = this._shapeMask.map(c => ({ x: c.x, y: c.y }));
    this._lastShapeDragShift = { col: 0, row: 0 };
    return true;
  }

  previewShapeDrag(shiftCol, shiftRow) {
    if (!this._shapeDragBaseMask) return false;
    const minX = Math.min(...this._shapeDragBaseMask.map(c => c.x));
    const maxX = Math.max(...this._shapeDragBaseMask.map(c => c.x));
    const minY = Math.min(...this._shapeDragBaseMask.map(c => c.y));
    const maxY = Math.max(...this._shapeDragBaseMask.map(c => c.y));
    const clampedShiftCol = Math.max(-minX, Math.min(this.grid.cols - 1 - maxX, shiftCol));
    const clampedShiftRow = Math.max(-minY, Math.min(this.grid.rows - 1 - maxY, shiftRow));

    shiftCol = clampedShiftCol;
    shiftRow = clampedShiftRow;

    if (shiftCol === this._lastShapeDragShift.col &&
        shiftRow === this._lastShapeDragShift.row) {
      return true;
    }

    const seen = new Set();
    const shifted = [];
    for (const cell of this._shapeDragBaseMask) {
      const x = cell.x + shiftCol;
      const y = cell.y + shiftRow;
      const key = this.grid.getCellKey(x, y);
      if (seen.has(key)) continue;
      seen.add(key);
      shifted.push({ x, y });
    }

    this._shapeMask = shifted;
    this._lastShapeDragShift = { col: shiftCol, row: shiftRow };

    // 不再做"全体刚性槽位重排"（那会让里字像整体平移、彼此相对静止）。
    // 只把那些目标已被甩出新掩码的里字重新指派 —— 每个里字各自（带拖动方向
    // 偏置）重新挑一个掩码内目标，于是它们沿各自路径翻涌着追向被拖去的位置，
    // 而非刚性平移。仍在路上的里字保留自己的路径，互相之间产生相对运动。
    const maskKeys = new Set(shifted.map(c => this.grid.getCellKey(c.x, c.y)));
    for (const id of this._shapeChars) {
      const t = this._wanderTargets.get(id);
      const inside = t && maskKeys.has(this.grid.getCellKey(t.tx, t.ty));
      if (!inside) {
        const char = this.characters.get(id);
        if (char) this._assignWanderTarget(char);
      }
    }
    return true;
  }

  /**
   * Release the drag. Instead of killing the bias outright (which makes the
   * swarm stop dead and looks mechanical), we let it decay over
   * `dragMomentumMs` so the里字 keep sloshing toward the last drag direction
   * and settle naturally — the "翻涌" easing out.
   */
  endShapeDrag() {
    this._shapeDragBaseMask = null;
    this._dragActive = false;   // 退出快速 tick，动量期平滑回落常速
    this._dragMomentum = this.dragBias != null && this.dragBias.strength > 0;
    // Strict shapes re-form at the dragged location once the slosh decays.
    if (this._shapeConstraint === 'strict') this._reanchorToMask();
  }

  /** Release all shape constraints */
  releaseShape() {
    this._shapeChars.clear();
    this._shapeMask = null;
    this._shapeDragBaseMask = null;
    this._flowCells = null;
    this._flowIndexOf.clear();
    this._orbit = false;
    this._orbitOf.clear();
  }

  // ── Flow（流动）—— 里字沿有序环路逐格单列流动 ────────────────

  /**
   * 让 charIds 沿 `orderedCells`（一条有序的、相邻连续的格子环路）流动。
   * 路径格子数应略多于里字数，留出空位 → 像贪吃蛇/华容道一样单列推进。
   * 同时用于：细轮廓流动（心形/曲线）与拖动时的"环绕手指"方环。
   * @param {Array<{x,y}>} orderedCells —— 顺序即流动方向
   * @param {number[]} charIds
   * @param {boolean} [loop=true] —— 闭合环路
   */
  setFlowPath(orderedCells, charIds, loop = true) {
    // 去掉重复格（保持顺序），保证 index→cell 唯一。
    const seen = new Set();
    const path = [];
    for (const c of orderedCells) {
      const k = this.grid.getCellKey(c.x, c.y);
      if (seen.has(k)) continue;
      seen.add(k);
      path.push({ x: c.x, y: c.y });
    }
    if (path.length === 0) return;

    this._flowCells = path;
    this._flowLoop = loop;
    this._shapeMask = path;            // PIBT 仍据此把里字约束在路径上
    this._shapeConstraint = 'flow';
    this._shapeChars = new Set(charIds);

    const L = path.length;
    const ids = [...this._shapeChars];
    const C = ids.length;
    // 沿路径等距铺开里字（留出的空位即流动所需的"缝隙"）。就近匹配让初始
    // 进入更顺：把里字按其当前位置在路径上的最近 index 排序后再等距落位。
    ids.sort((a, b) => this._nearestFlowIndex(a) - this._nearestFlowIndex(b));
    this._flowIndexOf.clear();
    for (let k = 0; k < C; k++) {
      const idx = Math.floor((k * L) / Math.max(C, 1)) % L;
      const id = ids[k];
      this._flowIndexOf.set(id, idx);
      const cell = path[idx];
      this._wanderTargets.set(id, { tx: cell.x, ty: cell.y });
      this._stuckTicks.set(id, 0);
    }
  }

  _nearestFlowIndex(charId) {
    const char = this.characters.get(charId);
    if (!char || !this._flowCells) return 0;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this._flowCells.length; i++) {
      const c = this._flowCells[i];
      const d = Math.abs(c.x - char.gridX) + Math.abs(c.y - char.gridY);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  _setFlowTarget(charId) {
    const i = this._flowIndexOf.get(charId);
    const cell = this._flowCells[i];
    if (cell) this._wanderTargets.set(charId, { tx: cell.x, ty: cell.y });
  }

  _advanceFlowIndex(charId) {
    const L = this._flowCells.length;
    let i = this._flowIndexOf.get(charId) || 0;
    if (this._flowLoop) i = (i + 1) % L;
    else i = Math.min(i + 1, L - 1);
    this._flowIndexOf.set(charId, i);
    this._setFlowTarget(charId);
  }

  /**
   * Begin the drag orbit (收束 L30): 里字 gather into a SQUARE centred on the
   * press point and rotate as concentric square rings (一层层环绕中心), speeding
   * up over time. While dragging, the whole square translates to follow the
   * finger (整体平移) yet keeps spinning.
   */
  beginOrbit(cx, cy) {
    this._orbit = true;
    this._dragActive = true;
    this._dragMomentum = false;
    this.dragBias = null;
    this._orbitElapsed = 0;
    this._shapeConstraint = 'orbit';
    if (this._shapeChars.size === 0) {
      this._shapeChars = new Set(this.characters.keys());
    }
    this._layoutOrbit(cx, cy);
  }

  /** Re-center the square on the moved finger; whole block translates, keeps spinning. */
  moveOrbit(cx, cy) {
    if (!this._orbit) return;
    const R = this._orbitMaxRing;
    // Clamp so the whole square stays in-bounds → no clipping while dragging.
    cx = Math.max(R, Math.min(this.grid.cols - 1 - R, cx));
    cy = Math.max(R, Math.min(this.grid.rows - 1 - R, cy));
    this._orbitCenter = { x: cx, y: cy };
    // 关键：约束区域（方块掩码）必须跟着平移，否则里字被困在旧方块里不能整体跟手。
    this._shapeMask = this._buildOrbitMask(cx, cy, R);
    for (const id of this._shapeChars) this._setOrbitTarget(id);
  }

  /** Square region (Chebyshev ≤ R, centre hole excluded) used to constrain orbit. */
  _buildOrbitMask(cx, cy, R) {
    const mask = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= this.grid.cols || y >= this.grid.rows) continue;
        mask.push({ x, y });
      }
    }
    return mask;
  }

  /** End the orbit; caller re-forms the previous shape at the release spot. */
  endOrbit() {
    this._orbit = false;
    this._dragActive = false;
    this._orbitOf.clear();
  }

  /**
   * Assign每个里字 a (ring, slot) filling concentric square rings inner→outer
   * around the centre (ring 0 / 中心格 left empty for the finger), then point
   * each at its ring cell. Also records the square region as the shape mask so
   * PIBT keeps里字 inside the block.
   */
  _layoutOrbit(cx, cy) {
    const ids = [...this._shapeChars];
    const count = ids.length;
    // Smallest R whose rings 1..R hold every里字: Σ 8r = 4R(R+1).
    let R = 1;
    while (4 * R * (R + 1) < count) R++;
    this._orbitMaxRing = R;

    R = this._orbitMaxRing;
    cx = Math.max(R, Math.min(this.grid.cols - 1 - R, cx));
    cy = Math.max(R, Math.min(this.grid.rows - 1 - R, cy));
    this._orbitCenter = { x: cx, y: cy };

    this._orbitOf.clear();
    let i = 0;
    for (let ring = 1; ring <= R && i < count; ring++) {
      const perim = this._ringPerim(ring);
      for (let s = 0; s < perim.length && i < count; s++) {
        this._orbitOf.set(ids[i++], { ring, slot: s });
      }
    }

    this._shapeMask = this._buildOrbitMask(cx, cy, R);
    for (const id of ids) this._setOrbitTarget(id);
  }

  /** Ordered (clockwise) perimeter offsets of a square ring at Chebyshev=r. */
  _ringPerim(r) {
    const cached = this._ringPerimCache.get(r);
    if (cached) return cached;
    const p = [];
    for (let x = -r; x <= r; x++) p.push({ dx: x, dy: -r });   // top L→R
    for (let y = -r + 1; y <= r; y++) p.push({ dx: r, dy: y }); // right T→B
    for (let x = r - 1; x >= -r; x--) p.push({ dx: x, dy: r });  // bottom R→L
    for (let y = r - 1; y >= -r + 1; y--) p.push({ dx: -r, dy: y }); // left B→T
    this._ringPerimCache.set(r, p);
    return p;
  }

  _setOrbitTarget(id) {
    const o = this._orbitOf.get(id);
    if (!o) return;
    const perim = this._ringPerim(o.ring);
    const off = perim[((o.slot % perim.length) + perim.length) % perim.length];
    const tx = Math.max(0, Math.min(this.grid.cols - 1, this._orbitCenter.x + off.dx));
    const ty = Math.max(0, Math.min(this.grid.rows - 1, this._orbitCenter.y + off.dy));
    this._wanderTargets.set(id, { tx, ty });
  }

  _advanceOrbitSlot(id) {
    const o = this._orbitOf.get(id);
    if (!o) return;
    const len = this._ringPerim(o.ring).length;
    o.slot = (((o.slot + this._orbitDir) % len) + len) % len;
    this._setOrbitTarget(id);
  }

  update(deltaTime) {
    // Post-release momentum: let the drag bias fade so the swarm eases out
    // instead of freezing the instant the finger lifts.
    if (this._dragMomentum && this.dragBias) {
      this.dragBias.strength -= deltaTime / this.dragMomentumMs;
      if (this.dragBias.strength <= 0.02) {
        this.dragBias = null;
        this._dragMomentum = false;
      }
    }
    if (this._orbit) this._orbitElapsed += deltaTime; // drives 逐渐加速

    const tick = this._effectiveTick();
    this.accumulatedTime += deltaTime;
    let ticks = 0;
    // 拖动/动量期 tick 更短，允许一帧内多走几步快速追手（仍上限保护）。
    const maxTicks = this._dragActive || this._dragMomentum ? 4 : 3;
    while (this.accumulatedTime >= tick && ticks < maxTicks) {
      this._advanceOneStep();
      this.accumulatedTime -= tick;
      ticks++;
    }
    if (this.accumulatedTime >= tick) this.accumulatedTime = 0;
    this.tickProgress = this.accumulatedTime / tick;
    return this.tickProgress;
  }

  /**
   * 当前生效的 tick 时长（ms）。
   *   - 拖动中：dragTickDuration（快速跟手）
   *   - 松手动量期：随 dragBias.strength 由快 tick 平滑回落到常速 tick
   *   - 其余：tickDuration（常速）
   * 注意：这里切换的是"模态"速度，不是按拖拽瞬时速度变速，故仍满足匀速铁律。
   */
  _effectiveTick() {
    if (this._orbit) {
      // 逐渐加速：旋转 tick 由 orbitTickStart 渐缩到 orbitTickEnd。
      const t = Math.min(1, this._orbitElapsed / this.orbitRampMs);
      return this.orbitTickStart + (this.orbitTickEnd - this.orbitTickStart) * t;
    }
    if (this._dragActive) return this.dragTickDuration;
    if (this._dragMomentum && this.dragBias) {
      const s = Math.max(0, Math.min(1, this.dragBias.strength));
      return this.dragTickDuration + (this.tickDuration - this.dragTickDuration) * (1 - s);
    }
    return this.tickDuration;
  }

  updateDisplayPositions(progress) {
    const cs = this.cellSize;
    const pad = this.cellPadding;
    const p = Math.max(0, Math.min(progress, 1));
    for (const char of this.characters.values()) {
      char.displayX = this._lerp(char.prevGridX * cs, char.gridX * cs, p) + pad;
      char.displayY = this._lerp(char.prevGridY * cs, char.gridY * cs, p) + pad;
    }
    this._resolveDisplayCollisions();
  }

  // ── PIBT Core ─────────────────────────────────────────

  _advanceOneStep() {
    this._stepCount++;
    const chars = [...this.characters.values()];
    const N = chars.length;
    const grid = this.grid;
    const cols = grid.cols;
    const rows = grid.rows;
    const totalCells = cols * rows;

    // Reset PIBT state. _occupiedNow/Nxt are sized to the grid (constant);
    // _nextPos is sized to N, which can change when里字 are added/removed for
    // 字数自适应 —— so resize it independently whenever the count shifts.
    if (this._occupiedNow.length !== totalCells) {
      this._occupiedNow = new Array(totalCells).fill(-1);
      this._occupiedNxt = new Array(totalCells).fill(-1);
    } else {
      this._occupiedNow.fill(-1);
      this._occupiedNxt.fill(-1);
    }
    if (this._nextPos.length !== N) {
      this._nextPos = new Array(N).fill(-1);
    } else {
      this._nextPos.fill(-1);
    }

    const idx = (x, y) => y * cols + x;

    // Record current occupation
    for (let i = 0; i < N; i++) {
      this._occupiedNow[idx(chars[i].gridX, chars[i].gridY)] = chars[i].id;
    }

    // Random priority order — PIBT priority inheritance handles cascade naturally
    const order = [...Array(N).keys()];
    this._shuffle(order);

    for (const i of order) {
      if (this._nextPos[i] === -1) {
        this._funcPIBT(chars, i, cols, rows, idx);
      }
    }

    // Apply moves
    const now = performance.now();
    for (let i = 0; i < N; i++) {
      const char = chars[i];
      const nxt = this._nextPos[i];
      if (nxt === -1) continue;

      const nx = nxt % cols;
      const ny = Math.floor(nxt / cols);
      const dx = nx - char.gridX;
      const dy = ny - char.gridY;

      if (dx !== 0 || dy !== 0) {
        // Moving
        this._stuckTicks.set(char.id, 0);
        char.prevGridX = char.gridX;
        char.prevGridY = char.gridY;
        char.gridX = nx;
        char.gridY = ny;

        this._currentDirs.set(char.id, { dx, dy });
        const streak = (this._directionStreaks.get(char.id) || 0) + 1;
        this._directionStreaks.set(char.id, streak);

        const target = this._wanderTargets.get(char.id);
        if (target && nx === target.tx && ny === target.ty) {
          if (this._shapeConstraint === 'orbit' && this._orbitOf.has(char.id)) {
            // 到达本环当前格 → 沿环推进一格（规整旋转，不随机停顿）。
            this._advanceOrbitSlot(char.id);
          } else if (this._shapeConstraint === 'flow' && this._shapeChars.has(char.id)) {
            // 到达当前路径格 → 推进到下一格（少量随机停顿，增加生命感）。
            if (Math.random() < 0.12) this._setFlowTarget(char.id); // pause one tick
            else this._advanceFlowIndex(char.id);
          } else {
            this._wanderTargets.delete(char.id);
            // Shape-constrained: pick a new mask cell to keep wandering within shape
            if (this._shapeChars.has(char.id)) {
              this._assignWanderTarget(char);
            }
          }
        }

        const moveTime = now;
        this._moveStartTimes.set(char.id, moveTime);
      } else {
        // Not moving
        char.prevGridX = char.gridX;
        char.prevGridY = char.gridY;
        const stuck = (this._stuckTicks.get(char.id) || 0) + 1;
        this._stuckTicks.set(char.id, stuck);
        this._directionStreaks.set(char.id, 0);

        if (stuck > STUCK_LIMIT) {
          if (this._shapeConstraint === 'orbit' && this._orbitOf.has(char.id)) {
            this._advanceOrbitSlot(char.id); // 旋转受阻 → 跳到下一格绕过
          } else if (this._shapeConstraint === 'flow' && this._shapeChars.has(char.id)) {
            // 流动中被堵 → 跳到下一路径格绕过拥堵，保持单列推进不卡死。
            this._advanceFlowIndex(char.id);
          } else {
            // Force a new target far away — PIBT will naturally find a way out
            this._assignWanderTarget(char);
          }
          this._stuckTicks.set(char.id, 0);
        }
      }
    }

    this.grid.clearAll();
    for (const char of chars) {
      this.grid.occupy(char.id, char.gridX, char.gridY);
    }

    // During drag, keep shape characters alive inside the shifted mask.
    // Flow/orbit self-drive via their own indices — skip the wander block.
    if (this._shapeConstraint !== 'flow' && this._shapeConstraint !== 'orbit' &&
        this.dragBias && this.dragBias.strength > 0.2) {
      for (const char of chars) {
        const stuck = this._stuckTicks.get(char.id) || 0;
        if (this._shapeChars.has(char.id) && this._shapeMask) {
          // 各里字以错相的周期独立重挑目标 → 路径各异、产生相对运动（翻涌）。
          const refresh = ((this._stepCount + char.id * 7) % 11) === 0;
          if (refresh || stuck > 2 || !this._wanderTargets.has(char.id)) {
            this._assignWanderTarget(char);
          }
          continue;
        }
        if (stuck > 3 || !this._wanderTargets.has(char.id)) {
          this._assignWanderTarget(char);
        }
      }
    }
  }

  _funcPIBT(chars, i, cols, rows, idx) {
    const char = chars[i];
    const grid = this.grid;
    const target = this._wanderTargets.get(char.id);
    const isShape = this._shapeChars.has(char.id);
    const isInsideShape = isShape && this._shapeMask &&
      this._shapeMask.some(c => c.x === char.gridX && c.y === char.gridY);

    // Candidates: [stay] + [4 neighbors] — only unoccupied
    const cands = [{ x: char.gridX, y: char.gridY, stay: true }];
    for (const d of DIRS) {
      const nx = char.gridX + d.dx;
      const ny = char.gridY + d.dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      
      // Shape constraint: only move within mask
      if (isInsideShape) {
        const inMask = this._shapeMask.some(c => c.x === nx && c.y === ny);
        if (!inMask) continue;
      }
      
      cands.push({ x: nx, y: ny, stay: false, dx: d.dx, dy: d.dy });
    }

    // Sort: repulsion priority → stuck-penalty → direction streak → target distance
    const curDir = this._currentDirs.get(char.id);
    const streak = this._directionStreaks.get(char.id) || 0;
    const stuck = this._stuckTicks.get(char.id) || 0;

    // Compute repulsion score for each candidate: avoid nearby characters
    for (const c of cands) {
      c.repulsion = 0;
      for (const other of chars) {
        if (other.id === char.id) continue;
        const dist = Math.abs(c.x - other.gridX) + Math.abs(c.y - other.gridY);
        if (dist < 4) c.repulsion -= (4 - dist) * 3; // Strong penalty for being close
      }
    }

    // Sort priority depends on whether the character is pursuing a target.
    const changeThreshold = 15 + Math.floor(Math.random() * 15);
    const forceChange = streak > changeThreshold;
    const hasTarget = target !== undefined;

    cands.sort((a, b) => {
      if (hasTarget) {
        // Distance to target leads. "stay" (dist 0 when AT target) therefore
        // wins naturally → strict里字 hold their anchor instead of drifting.
        const aD = Math.abs(a.x - target.tx) + Math.abs(a.y - target.ty);
        const bD = Math.abs(b.x - target.tx) + Math.abs(b.y - target.ty);
        if (aD !== bD) return aD - bD;
        // Equal progress → keep heading the same way (long纵横 segments, L29).
        if (curDir) {
          const aSame = !a.stay && a.dx === curDir.dx && a.dy === curDir.dy;
          const bSame = !b.stay && b.dx === curDir.dx && b.dy === curDir.dy;
          if (aSame !== bSame) return aSame ? -1 : 1;
        }
        if (a.repulsion !== b.repulsion) return b.repulsion - a.repulsion;
        return 0;
      }

      // ── Target-less wander: keep moving, persist direction for liveliness ──
      if (a.stay && !b.stay) return 1;
      if (!a.stay && b.stay) return -1;
      if (a.stay && b.stay) return 0;

      if (curDir) {
        const aSame = a.dx === curDir.dx && a.dy === curDir.dy;
        const bSame = b.dx === curDir.dx && b.dy === curDir.dy;
        const aOpposite = a.dx === -curDir.dx && a.dy === -curDir.dy;
        const bOpposite = b.dx === -curDir.dx && b.dy === -curDir.dy;

        if (!forceChange) {
          if (aSame && !bSame) return -1;
          if (!aSame && bSame) return 1;
          if (aOpposite && !bOpposite) return 1;
          if (!aOpposite && bOpposite) return -1;
        } else {
          const aPerp = !aSame && !aOpposite;
          const bPerp = !bSame && !bOpposite;
          if (aPerp && !bPerp) return -1;
          if (!aPerp && bPerp) return 1;
          if (aSame && bOpposite) return -1;
          if (bSame && aOpposite) return 1;
        }
      }

      if (a.repulsion !== b.repulsion) return b.repulsion - a.repulsion;
      return 0;
    });

    for (const c of cands) {
      const ci = idx(c.x, c.y);
      if (this._occupiedNxt[ci] !== -1) continue;

      const occNow = this._occupiedNow[ci];
      if (occNow !== -1) {
        const oj = chars.findIndex(ch => ch.id === occNow);
        if (oj !== -1 && this._nextPos[oj] === idx(char.gridX, char.gridY)) continue;
      }

      this._nextPos[i] = ci;
      this._occupiedNxt[ci] = char.id;

      if (occNow !== -1 && occNow !== char.id) {
        const oj = chars.findIndex(ch => ch.id === occNow);
        if (oj !== -1 && this._nextPos[oj] === -1) {
          if (!this._funcPIBT(chars, oj, cols, rows, idx)) {
            this._nextPos[i] = -1;
            this._occupiedNxt[ci] = -1;
            continue;
          }
        }
      }
      return true;
    }

    // Fallback: stay
    const si = idx(char.gridX, char.gridY);
    if (this._occupiedNxt[si] !== -1 && this._occupiedNxt[si] !== char.id) {
      return false;
    }
    this._nextPos[i] = si;
    this._occupiedNxt[si] = char.id;
    return false;
  }

  // ── Wander ────────────────────────────────────────────

  _assignWanderTarget(char) {
    // Shape-constrained: pick from mask, biased toward drag if active
    if (this._shapeChars.has(char.id) && this._shapeMask && this._shapeMask.length > 0) {
      const dragging = this.dragBias && this.dragBias.strength > 0.2;

      const candidates = [];
      for (const c of this._shapeMask) {
        if (c.x === char.gridX && c.y === char.gridY) continue;
        if (this.grid.isOccupied(c.x, c.y)) continue;
        candidates.push(c);
      }
      if (candidates.length > 0) {
        // strict（颜文字/巨字）：在掩码内做"就近"华容道滑动 —— 滑向附近空格，
        // 轮廓与字数固定但里字持续运动（动态呈现），既保辨形又不静止。
        // loose（花等）：在整片掩码内自由远游。拖动时一律走 surge 选择。
        const pick = (this._shapeConstraint === 'strict' && !dragging)
          ? this._pickLocalShapeTarget(candidates, char)
          : this._pickShapeTarget(candidates, char);
        if (pick) {
          this._wanderTargets.set(char.id, { tx: pick.x, ty: pick.y });
          return;
        }
      }
      // 掩码内暂时无空格可去：本 tick 不强行设目标，下一 tick 再试，
      // 避免被推到掩码外破坏形状。
      return;
    }

    // Free roaming: pick random cell, biased toward drag if active
    for (let a = 0; a < 30; a++) {
      const tx = Math.floor(Math.random() * this.grid.cols);
      const ty = Math.floor(Math.random() * this.grid.rows);
      const dist = Math.abs(tx - char.gridX) + Math.abs(ty - char.gridY);
      if (dist < 5) continue;
      if (tx === char.gridX && ty === char.gridY) continue;
      if (this.grid.isOccupied(tx, ty)) continue;

      // Bias check: if drag is active, prefer cells in drag direction
      if (this.dragBias && this.dragBias.strength > 0.2) {
        const dx = tx - char.gridX;
        const dy = ty - char.gridY;
        const align = (dx * this.dragBias.dx + dy * this.dragBias.dy) / Math.max(Math.abs(dx) + Math.abs(dy), 1);
        // Accept with probability based on alignment and strength
        if (Math.random() > 0.1 + align * 0.9 * this.dragBias.strength) continue;
      }

      this._wanderTargets.set(char.id, { tx, ty });
      return;
    }
    // Fallback: any unoccupied cell at least 3 away
    for (let a = 0; a < 20; a++) {
      const tx = Math.floor(Math.random() * this.grid.cols);
      const ty = Math.floor(Math.random() * this.grid.rows);
      if (Math.abs(tx - char.gridX) + Math.abs(ty - char.gridY) < 3) continue;
      if (this.grid.isOccupied(tx, ty)) continue;
      this._wanderTargets.set(char.id, { tx, ty });
      return;
    }
  }

  _pickBiased(candidates, char) {
    if (!this.dragBias || this.dragBias.strength < 0.1) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }
    // Score each candidate by alignment with drag direction
    const scored = candidates.map(c => {
      const dx = c.x - char.gridX;
      const dy = c.y - char.gridY;
      const dist = Math.abs(dx) + Math.abs(dy) || 1;
      const align = (dx * this.dragBias.dx + dy * this.dragBias.dy) / dist;
      return { c, score: align * this.dragBias.strength + Math.random() * 0.2 };
    });
    scored.sort((a, b) => b.score - a.score);
    // Weighted random from top candidates (adds natural variation)
    const topN = Math.min(scored.length, Math.max(1, Math.floor(scored.length * 0.2)));
    return scored[Math.floor(Math.random() * topN)].c;
  }

  // ── Helpers ───────────────────────────────────────────

  /**
   * 就近形状目标（strict 专用）：在掩码空格中优先挑离自己最近的一批随机取一。
   * 里字只做小幅滑动 —— 华容道式轻微挪动，轮廓被牢牢保持（易辨形），同时
   * 持续运动、绝不冻结。
   */
  _pickLocalShapeTarget(candidates, char) {
    const scored = candidates
      .map(c => ({ c, dist: Math.abs(c.x - char.gridX) + Math.abs(c.y - char.gridY) }))
      .sort((a, b) => a.dist - b.dist);
    const take = Math.max(3, Math.ceil(scored.length * 0.4));
    const pool = scored.slice(0, Math.min(take, scored.length));
    return pool[Math.floor(Math.random() * pool.length)].c;
  }

  _pickShapeTarget(candidates, char) {
    if (this.dragBias && this.dragBias.strength >= 0.1) {
      return this._pickDragShapeTarget(candidates, char);
    }

    const scored = candidates.map(c => ({
      c,
      dist: Math.abs(c.x - char.gridX) + Math.abs(c.y - char.gridY),
    })).sort((a, b) => b.dist - a.dist);

    const broadStart = Math.floor(scored.length * 0.15);
    const broadEnd = Math.max(broadStart + 1, Math.floor(scored.length * 0.55));
    const broad = scored.slice(broadStart, broadEnd);
    const pool = broad.length > 0 ? broad : scored;
    return pool[Math.floor(Math.random() * pool.length)].c;
  }

  _pickDragShapeTarget(candidates, char) {
    const scored = candidates.map(c => {
      const dx = c.x - char.gridX;
      const dy = c.y - char.gridY;
      const dist = Math.abs(dx) + Math.abs(dy) || 1;
      const align = (dx * this.dragBias.dx + dy * this.dragBias.dy) / dist;
      return {
        c,
        score: align * 1.5 + dist * 0.35 + this._stableNoise(char.id, c.x, c.y) * 1.4,
      };
    }).sort((a, b) => b.score - a.score);

    const topN = Math.min(scored.length, Math.max(1, Math.ceil(scored.length * 0.45)));
    return scored[(char.id + this._stepCount) % topN].c;
  }

  _assignShapeTargets() {
    if (!this._shapeMask || this._shapeMask.length === 0) return;

    // Sorted (row-major) assignment: matching里字 and cells in the same spatial
    // order fans the swarm out with far fewer path crossings than greedy-nearest,
    // so strict formations actually converge tight instead of jamming.
    const chars = [...this._shapeChars]
      .map(id => this.characters.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.gridY - b.gridY) || (a.gridX - b.gridX));
    const cells = this._shapeMask.slice()
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const n = Math.min(chars.length, cells.length);
    for (let i = 0; i < n; i++) {
      const char = chars[i];
      const cell = cells[i];
      this._wanderTargets.set(char.id, { tx: cell.x, ty: cell.y });
      char.anchorX = cell.x; // formation slot — strict shapes hold here
      char.anchorY = cell.y;
      this._stuckTicks.set(char.id, 0);
    }
  }

  /**
   * Re-bind each里字's anchor to the nearest cell of the CURRENT mask without
   * forcing an immediate move. Called on drag release so a strict shape settles
   * back into form at wherever the finger left it (the "翻涌" easing into shape).
   */
  _reanchorToMask() {
    if (!this._shapeMask || this._shapeMask.length === 0) return;
    const used = new Set();
    for (const id of this._shapeChars) {
      const char = this.characters.get(id);
      if (!char) continue;
      let best = null;
      let bestD = Infinity;
      for (const cell of this._shapeMask) {
        const key = this.grid.getCellKey(cell.x, cell.y);
        if (used.has(key)) continue;
        const d = Math.abs(cell.x - char.gridX) + Math.abs(cell.y - char.gridY);
        if (d < bestD) { best = cell; bestD = d; }
      }
      if (best) {
        used.add(this.grid.getCellKey(best.x, best.y));
        char.anchorX = best.x;
        char.anchorY = best.y;
      }
    }
  }

  _lerp(a, b, t) { return a + (b - a) * t; }

  _stableNoise(id, x, y) {
    const n = (id * 73856093) ^ (x * 19349663) ^ (y * 83492791);
    return ((n >>> 0) % 1000) / 1000;
  }

  _resolveDisplayCollisions() {
    const chars = [...this.characters.values()].filter(char => char.alpha > 0.01);
    const minDist = this.cellSize * 0.9;
    const minDistSq = minDist * minDist;
    const maxX = (this.grid.cols - 1) * this.cellSize;
    const maxY = (this.grid.rows - 1) * this.cellSize;

    for (let pass = 0; pass < 16; pass++) {
      for (let i = 0; i < chars.length; i++) {
        for (let j = i + 1; j < chars.length; j++) {
          const a = chars[i];
          const b = chars[j];
          let ax = a.displayX + this.cellSize / 2;
          let ay = a.displayY + this.cellSize / 2;
          let bx = b.displayX + this.cellSize / 2;
          let by = b.displayY + this.cellSize / 2;
          let dx = bx - ax;
          let dy = by - ay;
          let distSq = dx * dx + dy * dy;
          if (distSq >= minDistSq) continue;

          if (distSq < 0.0001) {
            const angle = this._stableNoise(a.id + b.id, a.gridX, a.gridY) * Math.PI * 2;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distSq = 1;
          }

          const dist = Math.sqrt(distSq);
          const push = (minDist - dist) / 2;
          const ux = dx / dist;
          const uy = dy / dist;
          a.displayX = Math.max(0, Math.min(maxX, a.displayX - ux * push));
          a.displayY = Math.max(0, Math.min(maxY, a.displayY - uy * push));
          b.displayX = Math.max(0, Math.min(maxX, b.displayX + ux * push));
          b.displayY = Math.max(0, Math.min(maxY, b.displayY + uy * push));
        }
      }
    }
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}
