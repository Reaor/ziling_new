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

// flow（沿线流动）额外允许 4 个对角方向：细化出的骨架斜笔画（撇/捺/尖角）含对角步，
// 若只走上下左右则到不了对角的下一格→卡死，旧方案靠"加粗桥接"补正交格但会把细线重新
// 变粗成块。允许对角移动后，里字一步即可沿斜线走到下一骨架格→笔画保持 1 格宽的单薄细线。
const DIRS_DIAG = [
  { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: 1, dy: 1 },
];
const DIRS8 = [...DIRS, ...DIRS_DIAG];

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
    this.reformTickDuration = 80;  // 形状重排提速的最快 tick（比常速 200 快约一倍半）
    this._reformBoostMs = 0;       // >0 时启用重排提速，逐帧递减
    this.reformBoostTotal = 1400;  // 提速窗口总时长（用于渐进回落比例）
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

    // Reusable id→index map for PIBT (avoids O(N) findIndex each step)
    this._idToIndex = new Map();

    // Interpolation stagger
    this._moveStartTimes = new Map();

    // Shape constraint (per-character, NOT global)
    this._shapeChars = new Set();
    this._shapeMask = null;
    // 'strict' → 颜文字/巨字 hold formation near anchors (易辨形)
    // 'loose'  → curves/flowers roam the whole mask freely
    // 'flow'   → 里字沿一组有序路径（笔画/曲线）流动：闭环绕圈、开放笔画往返
    this._shapeConstraint = 'loose';
    this._shapeMaskSet = new Set();  // 掩码格子键集合 → O(1) 成员判定（替代 .some 线性扫描）
    this._shapeDragBaseMask = null;
    this._lastShapeDragShift = { col: 0, row: 0 };

    // Flow（多路径流动）state
    this._flowPaths = null;          // Array<{cells:[{x,y}], loop:bool, dir:1|-1}>
    this._flowAllowDiag = false;     // flow 路径含对角步(骨架巨字)→允许里字走对角；曲线→false
    this._flowOf = new Map();        // charId → { p:pathIdx, i:cellIdx }
    this._originTargets = new Map(); // origin(原态文本行): charId → 被钉住的文本格 {x,y}

    // Orbit（拖动环绕）state —— 显示层驱动的同心方块旋转，跟手整体平移、逐渐加速。
    this._orbit = false;
    this._orbitOf = new Map();       // charId → { ring, k, n }
    this._orbitCenterPx = { x: 0, y: 0 };
    this._orbitMaxRing = 1;
    this._orbitElapsed = 0;          // ms since orbit began (drives 逐渐加速)
    this._orbitPhase = 0;            // accumulated rotation (rad)
    this.orbitSpinStart = 0.0016;    // rad/ms 起始转速
    this.orbitSpinEnd = 0.0085;      // rad/ms 加速到的转速
    this.orbitRampMs = 1400;

    // Drag bias state
    this.dragBias = null; // { dx, dy, strength: 0-1 } — dx/dy is a unit-ish direction
    this._dragMomentum = false; // after release, bias decays instead of dying instantly
    this.dragMomentumMs = 650;  // time for the post-release "slosh" to settle
  }

  /** Public getter/setter bridging _shapeMask for external access */
  get shapeMask() { return this._shapeMask; }
  set shapeMask(v) { this._shapeMask = v; this._rebuildMaskSet(); }

  /** 重建 O(1) 掩码键集合（任何改写 _shapeMask 后都要调用，键编码同 grid.getCellKey）。*/
  _rebuildMaskSet() {
    const set = this._shapeMaskSet;
    set.clear();
    if (this._shapeMask) for (const c of this._shapeMask) set.add(c.y * 10000 + c.x);
  }
  _inMask(x, y) { return this._shapeMaskSet.has(y * 10000 + x); }

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
    this._flowOf.delete(charId);
    this._orbitOf.delete(charId);
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
    // 切换到掩码约束时清掉 flow 残留，避免里字还按旧路径流动。
    this._flowOf.clear();
    this._flowPaths = null;
    this._shapeMask = mask;
    this._rebuildMaskSet();
    this._shapeConstraint = constraint;
    this._shapeChars = new Set(charIds);
    this._assignShapeTargets();
  }

  /**
   * 满填循环流动（颜文字/巨字的动态呈现）：里字填满字形掩码并被牢牢约束在轮廓内
   * （绝不漏出 → 字形始终保持），但**无远目标**，靠方向惯性在笔画内成排循环游走
   * —— 在 ≥2 格宽的笔画里自然形成"转大圈"的赛道式流动（像心形曲线，但是填满的带）。
   * 既动态、又辨形稳，且无需脆弱的路径生成、对任意字都稳健。
   * @param {Array<{x,y}>} mask @param {number[]} charIds
   */
  setFlowFill(mask, charIds) {
    this._flowOf.clear();
    this._flowPaths = null;
    this._shapeMask = mask;
    this._rebuildMaskSet();
    this._shapeConstraint = 'flowfill';
    this._shapeChars = new Set(charIds);

    // 关键：把**不在掩码内**的里字"领进"字形 —— 给每个分派一个最近的、尚未被认领的
    // 空掩码格作为入场目标（navigate in，不受掩码约束故能从外部走进来）。已在掩码内的
    // 里字则无目标、直接循环流动。否则切换形状时上一形状遗留在外的里字会一直游荡、收束不紧。
    const taken = new Set();
    for (const id of charIds) {
      const c = this.characters.get(id);
      if (c && this._inMask(c.gridX, c.gridY)) taken.add(c.gridY * 10000 + c.gridX);
    }
    for (const id of charIds) {
      const c = this.characters.get(id);
      if (c) c.flowFade = 1;                      // 清除上一形状(flow曲线)遗留的淡入淡出 → 满填里字全亮
      this._stuckTicks.set(id, 0);
      const d = DIRS[(Math.random() * 4) | 0];
      this._currentDirs.set(id, { dx: d.dx, dy: d.dy });
      this._directionStreaks.set(id, (Math.random() * 8) | 0);
      if (!c || this._inMask(c.gridX, c.gridY)) {
        this._wanderTargets.delete(id);          // 已在内 → 无目标循环流动
        continue;
      }
      let best = null, bestD = Infinity;          // 在外 → 认领最近空掩码格作入场目标
      for (const cell of mask) {
        const k = cell.y * 10000 + cell.x;
        if (taken.has(k)) continue;
        const dd = Math.abs(cell.x - c.gridX) + Math.abs(cell.y - c.gridY);
        if (dd < bestD) { bestD = dd; best = cell; }
      }
      if (best) {
        taken.add(best.y * 10000 + best.x);
        this._wanderTargets.set(id, { tx: best.x, ty: best.y });
      } else {
        this._wanderTargets.delete(id);
      }
    }
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
    this._rebuildMaskSet();
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
    for (const id of this._shapeChars) {           // 离开流动 → 恢复全亮
      const c = this.characters.get(id);
      if (c) c.flowFade = 1;
    }
    this._shapeChars.clear();
    this._shapeMask = null;
    this._shapeMaskSet.clear();
    this._shapeDragBaseMask = null;
    this._flowPaths = null;
    this._flowOf.clear();
    this._orbit = false;
    this._orbitOf.clear();
  }

  /**
   * 原态（文本行）：把 charIds 钉到一组文本格 `cells` 上（每字一个唯一格）。里字沿格子
   * （华容道式）滑到各自文本位置后被钉住静止 → 呈现"正常文本行排版"。无流动、无漫游。
   * 由动态切到原态、或反向，都靠"重指目标 + PIBT 沿格滑动"完成，运动美观且匀速。
   * @param {Array<{x,y}>} cells —— 文本行格子（顺序即阅读序：左→右、上→下）
   * @param {number[]} charIds
   */
  setTextLine(cells, charIds, constraint = 'origin') {
    for (const id of this._shapeChars) { const c = this.characters.get(id); if (c) c.flowFade = 1; }
    this._flowOf.clear();
    this._flowPaths = null;
    this._orbit = false;
    this._orbitOf.clear();
    this._shapeConstraint = constraint; // 'origin'(文本行) 或 'anchored'(动态曲线底形)：均钉位保持
    this._shapeChars = new Set(charIds);
    this._shapeMask = cells;
    this._rebuildMaskSet();
    this._originTargets = new Map();
    // 按给定顺序一一配对：charIds[i] → cells[i]（配对/内容/阅读序由调用方 layoutOrigin 决定，
    // 保证文本按"原本顺序"呈现，且滑动路程最短）。
    for (let i = 0; i < charIds.length; i++) {
      const c = this.characters.get(charIds[i]);
      if (!c) continue;
      const cell = cells[i] || cells[cells.length - 1];
      if (!cell) continue;
      this._originTargets.set(charIds[i], { x: cell.x, y: cell.y });
      this._wanderTargets.set(charIds[i], { tx: cell.x, ty: cell.y });
      this._stuckTicks.set(charIds[i], 0);
      const d = DIRS[(Math.random() * 4) | 0];
      this._currentDirs.set(charIds[i], { dx: d.dx, dy: d.dy });
    }
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
  /**
   * 多路径流动：paths = Array<{cells:[{x,y}], loop:bool}>。
   *   - loop=true（曲线/数学曲线）：里字沿闭环首尾相连地绕圈流动。
   *   - loop=false（颜文字/巨字的每条笔画）：里字在该笔画上往返（slosh）流动，
   *     实心填满笔画格子，全员速率一致地动。
   * 里字按各路径长度比例分配，每条路径都留出空位（流动所需缝隙）。
   */
  setFlowPaths(paths, charIds) {
    const norm = [];
    for (const p of paths || []) {
      const seen = new Set();
      const cells = [];
      for (const c of p.cells) {
        const k = this.grid.getCellKey(c.x, c.y);
        if (seen.has(k)) continue;
        seen.add(k);
        cells.push({ x: c.x, y: c.y });
      }
      if (cells.length > 0) norm.push({ cells, loop: !!p.loop, dir: 1 });
    }
    if (norm.length === 0) return;

    this._flowPaths = norm;
    this._shapeConstraint = 'flow';
    this._shapeChars = new Set(charIds);
    this._flowOf.clear();

    // 路径是否含对角步？含 → 是细化骨架(巨字)，允许里字走对角沿斜笔画流动；不含 → 是 4 连通
    // 曲线，禁用对角（防抄近道/重叠）。在 _pibtBody 里据此选 4/8 邻域。
    this._flowAllowDiag = norm.some(p => {
      for (let k = 1; k < p.cells.length; k++) {
        if (Math.abs(p.cells[k].x - p.cells[k - 1].x) === 1 &&
            Math.abs(p.cells[k].y - p.cells[k - 1].y) === 1) return true;
      }
      return false;
    });

    // union of all path cells → PIBT containment mask
    const seenM = new Set();
    const mask = [];
    for (const p of norm) for (const c of p.cells) {
      const k = this.grid.getCellKey(c.x, c.y);
      if (seenM.has(k)) continue;
      seenM.add(k);
      mask.push(c);
    }
    this._shapeMask = mask;
    this._rebuildMaskSet();

    // allocate chars across paths ∝ length, each path keeping ≥1 gap, but with a
    // per-stroke floor so short strokes (颜文字的"嘴") aren't starved vs the eyes.
    const ids = [...this._shapeChars];
    const cap = norm.map(p => Math.max(0, p.cells.length - 1));
    const totalLen = norm.reduce((s, p) => s + p.cells.length, 0) || 1;
    const floor = norm.map((p, k) => Math.min(cap[k], Math.min(4, p.cells.length)));
    const alloc = norm.map((p, k) =>
      Math.min(cap[k], Math.max(floor[k], Math.round(ids.length * p.cells.length / totalLen))));
    let assigned = alloc.reduce((a, b) => a + b, 0);
    let g = 0, guard = 0;
    while (assigned < ids.length && norm.some((p, k) => alloc[k] < cap[k]) && guard++ < 10000) {
      if (alloc[g] < cap[g]) { alloc[g]++; assigned++; }
      g = (g + 1) % norm.length;
    }
    guard = 0;
    while (assigned > ids.length && guard++ < 10000) {
      if (alloc[g] > floor[g]) { alloc[g]--; assigned--; }
      else if (alloc[g] > 0) { alloc[g]--; assigned--; }
      g = (g + 1) % norm.length;
    }

    let cursor = 0;
    for (let p = 0; p < norm.length; p++) {
      const path = norm[p];
      const L = path.cells.length;
      const n = Math.min(alloc[p], ids.length - cursor);
      const pIds = ids.slice(cursor, cursor + n);
      cursor += n;
      // seed by nearest path cell → smoother entry (fewer crossings)
      pIds.sort((a, b) => this._nearestPathIndex(path, a) - this._nearestPathIndex(path, b));
      for (let k = 0; k < n; k++) {
        const idx = Math.floor((k * L) / Math.max(n, 1)) % L;
        this._flowOf.set(pIds[k], { p, i: idx });
        this._stuckTicks.set(pIds[k], 0);
        this._setFlowTarget(pIds[k]);
      }
    }
  }

  /** Single-path convenience (curves / tests). */
  setFlowPath(orderedCells, charIds, loop = true) {
    this.setFlowPaths([{ cells: orderedCells, loop }], charIds);
  }

  _nearestPathIndex(path, charId) {
    const char = this.characters.get(charId);
    if (!char) return 0;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < path.cells.length; i++) {
      const c = path.cells[i];
      const d = Math.abs(c.x - char.gridX) + Math.abs(c.y - char.gridY);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  _setFlowTarget(charId) {
    const o = this._flowOf.get(charId);
    if (!o) return;
    const cell = this._flowPaths[o.p].cells[o.i];
    if (cell) this._wanderTargets.set(charId, { tx: cell.x, ty: cell.y });
  }

  _advanceFlowIndex(charId) {
    const o = this._flowOf.get(charId);
    if (!o) return;
    const path = this._flowPaths[o.p];
    const L = path.cells.length;
    if (path.loop) {
      o.i = (o.i + 1) % L;               // 闭环：首尾相连绕圈
    } else {
      // 开放笔画 = 单向传送带：一路推进到尾端；到尾端后停在尾端（已淡出、不可见），
      // 由 _recycleFlowConveyor 在首端有空位时把它"传送"回首端（淡入）→ 持续单向流动，
      // 尾端淡出腾出的空格向首端传播 → 即使细笔画也人人都在动、不死锁。
      o.i = Math.min(L - 1, o.i + 1);
    }
    this._setFlowTarget(charId);
  }

  /**
   * 开放笔画传送带回收：到尾端且已停在尾格的里字，若首格空出，则"传送"回首格
   * （此刻它已淡出不可见 → 无突兀跳变）。每帧网格重建后调用，故占用判定准确。
   * 同时为所有流动里字按沿线进度计算淡入/淡出因子 flowFade（首/尾几格渐隐）。
   * @private
   */
  _recycleFlowConveyor() {
    if (!this._flowPaths) return;
    for (const [id, o] of this._flowOf) {
      const path = this._flowPaths[o.p];
      if (!path) continue;
      const char = this.characters.get(id);
      if (!char) continue;
      const L = path.cells.length;

      if (!path.loop && L > 1) {
        const tail = path.cells[L - 1];
        if (o.i === L - 1 && char.gridX === tail.x && char.gridY === tail.y) {
          const head = path.cells[0];
          if (!this.grid.isOccupied(head.x, head.y)) {
            this.grid.vacate(char.gridX, char.gridY);
            char.gridX = head.x; char.gridY = head.y;
            char.prevGridX = head.x; char.prevGridY = head.y;
            this.grid.occupy(id, head.x, head.y);
            o.i = 0;
            this._setFlowTarget(id);
          }
        }
      }

      // 淡入/淡出因子：只把开放笔画"最末/最首那一格"压到 0.5（淡入淡出 + 掩盖尾→首传送带
      // 回收的瞬移），中间一律全亮。旧版首尾各 2 格渐隐 + 传送带把里字堆在尾端 → 一大簇中段
      // 里字发暗（用户反馈"夹在中间的浅色字很怪"）。端点也只压到 0.5、不至于暗到像缺一格。
      if (path.loop || L <= 2) {
        char.flowFade = 1;
      } else {
        char.flowFade = (o.i === 0 || o.i === L - 1) ? 0.5 : 1;
      }
    }
  }

  // ── Orbit（拖动环绕）—— 显示层驱动，绕开 PIBT ───────────────────
  // 里字聚成方形，按同心方环连续旋转（外层略慢 → 层层错动，不单调）；中心=手指，
  // 整块刚性平移、跟随手指速度；拖得越久转得越快。松手时把里字落到不重叠的格子。
  isOrbiting() { return this._orbit; }

  startOrbit(charIds, cxPx, cyPx) {
    this._orbit = true;
    this._dragActive = true;
    this._dragMomentum = false;
    this.dragBias = null;
    this._orbitElapsed = 0;
    this._orbitPhase = 0;
    this._orbitCenterPx = { x: cxPx, y: cyPx };
    const ids = (charIds && charIds.length) ? [...charIds] : [...this.characters.keys()];
    // fill concentric rings inner→outer, capacity ∝ perimeter (≈8r).
    this._orbitOf.clear();
    let i = 0, r = 1;
    while (i < ids.length) {
      const n = Math.min(Math.max(4, 8 * r), ids.length - i);
      for (let k = 0; k < n; k++) this._orbitOf.set(ids[i + k], { ring: r, k, n });
      i += n; r++;
    }
    this._orbitMaxRing = r - 1;
  }

  updateOrbitDisplay(dtMs, cxPx, cyPx) {
    if (!this._orbit) return;
    const cell = this.cellSize;
    const W = this.grid.cols * cell, H = this.grid.rows * cell;
    const pad = (this._orbitMaxRing + 1) * cell;
    cxPx = Math.max(Math.min(pad, W / 2), Math.min(W - pad, cxPx));
    cyPx = Math.max(Math.min(pad, H / 2), Math.min(H - pad, cyPx));
    this._orbitCenterPx = { x: cxPx, y: cyPx };

    this._orbitElapsed += dtMs;
    const t = Math.min(1, this._orbitElapsed / this.orbitRampMs);
    const spin = this.orbitSpinStart + (this.orbitSpinEnd - this.orbitSpinStart) * t; // rad/ms
    this._orbitPhase += dtMs * spin;

    for (const [id, o] of this._orbitOf) {
      const char = this.characters.get(id);
      if (!char) continue;
      const ringPhase = this._orbitPhase * (1 - 0.12 * (o.ring - 1)); // 外层略慢
      const theta = (2 * Math.PI * o.k) / o.n + ringPhase;
      const c = Math.cos(theta), s = Math.sin(theta);
      const m = Math.max(Math.abs(c), Math.abs(s)) || 1; // 圆角→方形外廓映射
      const rad = o.ring * cell;
      char.displayX = cxPx + (rad * c) / m - cell / 2;
      char.displayY = cyPx + (rad * s) / m - cell / 2;
    }
  }

  /** End the orbit; snap里字 to distinct cells so PIBT can re-form the shape. */
  endOrbit() {
    if (!this._orbit) return;
    this._orbit = false;
    this._dragActive = false;
    const cell = this.cellSize;
    const used = new Set();
    this.grid.clearAll();
    for (const id of this._orbitOf.keys()) {
      const char = this.characters.get(id);
      if (!char) continue;
      let gx = Math.max(0, Math.min(this.grid.cols - 1, Math.round(char.displayX / cell)));
      let gy = Math.max(0, Math.min(this.grid.rows - 1, Math.round(char.displayY / cell)));
      if (used.has(this.grid.getCellKey(gx, gy))) {
        const f = this._nearestFreeCell(gx, gy, used);
        gx = f.x; gy = f.y;
      }
      used.add(this.grid.getCellKey(gx, gy));
      char.gridX = gx; char.gridY = gy;
      char.prevGridX = gx; char.prevGridY = gy;
      this.grid.occupy(id, gx, gy);
    }
    this._orbitOf.clear();
  }

  _nearestFreeCell(x, y, used) {
    const maxR = Math.max(this.grid.cols, this.grid.rows);
    for (let r = 1; r < maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= this.grid.cols || ny >= this.grid.rows) continue;
          if (!used.has(this.grid.getCellKey(nx, ny))) return { x: nx, y: ny };
        }
      }
    }
    return { x, y };
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
    if (this._reformBoostMs > 0) this._reformBoostMs -= deltaTime;
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
    if (this._dragActive) return this.dragTickDuration;
    if (this._dragMomentum && this.dragBias) {
      const s = Math.max(0, Math.min(1, this.dragBias.strength));
      return this.dragTickDuration + (this.tickDuration - this.dragTickDuration) * (1 - s);
    }
    // 形状变换重排提速：用一条"钟形"曲线平滑调速 —— 切换瞬间从常速**逐步加快**到最快，
    // 大致成形后再**逐步放慢**回常速（而非瞬间变快/到点突变）。整个过程平缓自然。
    // 形状内的常态运动速率不变（boost 用尽即恒为常速）。
    if (this._reformBoostMs > 0) {
      const p = 1 - this._reformBoostMs / this.reformBoostTotal;   // 0→1 贯穿提速窗口
      const bell = Math.sin(Math.max(0, Math.min(1, p)) * Math.PI); // 0→1→0：先加速后减速
      return this.tickDuration + (this.reformTickDuration - this.tickDuration) * bell;
    }
    return this.tickDuration;
  }

  /** 触发一次形状重排提速（持续 ms 毫秒，期间 tick 由快渐进回落到常速）。 */
  boostReform(ms = 1400) { this._reformBoostMs = ms; this.reformBoostTotal = ms; }

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
      this._pibtMark = new Uint8Array(N);
    } else {
      this._nextPos.fill(-1);
      this._pibtMark.fill(0); // 0=未处理 1=处理中 2=已定 —— 保证每字每 tick 只解析一次（防环死循环）
    }

    const idx = (x, y) => y * cols + x;

    // id → 数组下标映射（替代 PIBT 里 O(N) 的 chars.findIndex → 整体由 O(N²) 降到 O(N)）。
    const idToIndex = this._idToIndex;
    idToIndex.clear();
    for (let i = 0; i < N; i++) idToIndex.set(chars[i].id, i);

    // Record current occupation
    for (let i = 0; i < N; i++) {
      this._occupiedNow[idx(chars[i].gridX, chars[i].gridY)] = chars[i].id;
    }

    // flowfill：每帧给"还在字形外"的里字一个最近空掩码格作入场目标（不必等卡住）→ 杜绝
    // 少数里字漂在字形外漫游；已在字形内的无目标、照常循环流动。
    if (this._shapeConstraint === 'flowfill') {
      for (let i = 0; i < N; i++) {
        const c = chars[i];
        if (!this._inMask(c.gridX, c.gridY) && !this._wanderTargets.has(c.id)) {
          this._assignFlowFillTarget(c);
        }
      }
    }

    // Random priority order — PIBT priority inheritance handles cascade naturally
    const order = [...Array(N).keys()];
    this._shuffle(order);

    for (const i of order) {
      if (this._nextPos[i] === -1) {
        this._funcPIBT(chars, i, cols, rows, idx, idToIndex);
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
          if (this._shapeConstraint === 'flow' && this._flowOf.has(char.id)) {
            // 到达当前路径格 → 推进一格（少量随机停顿，避免像弹簧一样单调）。
            if (Math.random() < 0.08) this._setFlowTarget(char.id); // 偶尔停顿一拍（更自然）
            else this._advanceFlowIndex(char.id);
          } else if (this._shapeConstraint === 'origin' || this._shapeConstraint === 'anchored') {
            // 原态/动态曲线底形：到位即钉住——保留目标(=自身钉位格)，stay 永远胜出 → 静止保持。
          } else {
            this._wanderTargets.delete(char.id);
            // strict（颜文字/巨字）= 收紧的就近游走：每个里字持续做小幅横纵位移
            // （运动范围小、速率相近、没有谁卡死），轮廓收束在字形内、不糊。
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
          if (this._shapeConstraint === 'flow' && this._flowOf.has(char.id)) {
            // 流动中被堵 → 跳到下一路径格绕过拥堵，保持推进不卡死。
            this._advanceFlowIndex(char.id);
          } else if (this._shapeConstraint === 'flowfill') {
            // 满填循环里卡住（无论在字形内还是外）→ 朝**最近的空掩码格**走：在外的走进
            // 字形（入场、收束），在内的去填最近的空隙（消除静止、分布更均匀更密）。
            this._assignFlowFillTarget(char);
          } else if (this._shapeConstraint === 'origin' || this._shapeConstraint === 'anchored') {
            // 原态/动态曲线底形被堵 → 重新指向自己的钉位格，继续沿格挪过去（不乱给随机目标）。
            const t = this._originTargets && this._originTargets.get(char.id);
            if (t) this._wanderTargets.set(char.id, { tx: t.x, ty: t.y });
          } else {
            // Force a new target — PIBT will naturally find a way out
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

    // 开放笔画传送带回收 + 淡入淡出因子（网格已重建 → 占用判定准确）。
    this._recycleFlowConveyor();

    // During drag, keep shape characters alive inside the shifted mask.
    // Flow self-drives via flow indices — skip the wander block.
    if (this._shapeConstraint !== 'flow' &&
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

  /**
   * PIBT 解析的终止性包裹：每个里字每 tick 只真正解析一次。
   *  - 已定(2)：直接返回是否拿到了下一步；
   *  - 处理中(1)：说明遇到了推挤环（A 推 B、B 又依赖 A）→ 视为"此刻无法让位"返回 false，
   *    打破环、保证 O(N) 终止（满填 + 全员无目标的密集场景下，旧代码会在此死循环）。
   */
  _funcPIBT(chars, i, cols, rows, idx, idToIndex) {
    if (this._pibtMark[i] === 2) return this._nextPos[i] !== -1;
    if (this._pibtMark[i] === 1) return false;
    this._pibtMark[i] = 1;
    const r = this._pibtBody(chars, i, cols, rows, idx, idToIndex);
    this._pibtMark[i] = 2;
    return r;
  }

  _pibtBody(chars, i, cols, rows, idx, idToIndex) {
    const char = chars[i];
    const grid = this.grid;
    const target = this._wanderTargets.get(char.id);
    const isShape = this._shapeChars.has(char.id);
    // origin（原态文本行）不做掩码围栏：里字靠"唯一目标格 + stay 胜出"被钉住，途中需自由
    // 穿行去各自文本格，故不限制在掩码内。其余成形模式(strict/flowfill)仍围栏在字形内。
    const isInsideShape = isShape && this._shapeConstraint !== 'origin' &&
      this._shapeConstraint !== 'anchored' &&
      this._shapeMaskSet.size > 0 && this._inMask(char.gridX, char.gridY);

    // Candidates: [stay] + [neighbors] — only unoccupied. flow 用 8 邻域（含对角），
    // 让里字能沿细化骨架的斜笔画逐格流动、不靠加粗桥接、保持单薄细线；其余模式仍 4 邻域。
    // 骨架细笔画含对角步 → 用 8 邻域让里字沿斜笔画(撇/捺)逐格流动、保持单薄细线；4 连通的
    // 曲线路径不含对角步(_flowAllowDiag=false) → 仍用 4 邻域，绝不被对角抄近道（曲线维持上
    // 一版的正交流动、不乱、不重叠）。两者由 setFlowPaths 按路径是否含对角步自动判定。
    const dirs = (this._shapeConstraint === 'flow' && this._flowAllowDiag) ? DIRS8 : DIRS;
    const cands = [{ x: char.gridX, y: char.gridY, stay: true }];
    for (const d of dirs) {
      const nx = char.gridX + d.dx;
      const ny = char.gridY + d.dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;

      // Shape constraint: only move within mask (O(1) set lookup, 不再线性扫描掩码)
      if (isInsideShape && !this._inMask(nx, ny)) continue;

      cands.push({ x: nx, y: ny, stay: false, dx: d.dx, dy: d.dy });
    }

    // Sort: repulsion priority → stuck-penalty → direction streak → target distance
    const curDir = this._currentDirs.get(char.id);
    const streak = this._directionStreaks.get(char.id) || 0;
    const stuck = this._stuckTicks.get(char.id) || 0;

    // Repulsion per candidate by scanning ONLY the local grid neighbourhood
    // (manhattan<4 diamond ≈ 25 cells) via grid.getCharId, instead of all N里字 →
    // O(1) not O(N)（去掉随字数平方增长的开销，这是卡顿主因之一）。
    for (const c of cands) {
      let rep = 0;
      for (let oy = -3; oy <= 3; oy++) {
        const ny = c.y + oy;
        if (ny < 0 || ny >= rows) continue;
        const budget = 3 - Math.abs(oy);
        for (let ox = -budget; ox <= budget; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = c.x + ox;
          if (nx < 0 || nx >= cols) continue;
          const occ = grid.getCharId(nx, ny);
          if (occ !== -1 && occ !== char.id) rep -= (4 - (Math.abs(ox) + Math.abs(oy))) * 3;
        }
      }
      c.repulsion = rep;
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
        const oj = idToIndex.get(occNow);
        if (oj !== undefined && this._nextPos[oj] === idx(char.gridX, char.gridY)) continue;
      }

      this._nextPos[i] = ci;
      this._occupiedNxt[ci] = char.id;

      if (occNow !== -1 && occNow !== char.id) {
        const oj = idToIndex.get(occNow);
        if (oj !== undefined && this._nextPos[oj] === -1) {
          if (!this._funcPIBT(chars, oj, cols, rows, idx, idToIndex)) {
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

  /**
   * flowfill 解卡/入场/填缝：给卡住的里字指派**最近的空掩码格**为目标。在字形外的里字
   * 借此走进字形（收束），在字形内被堵的里字借此移向最近空隙（消除静止、分布更均匀）。
   * 到达后目标自动清除 → 重新并入惯性循环流动。@private
   */
  _assignFlowFillTarget(char) {
    let best = null, bestD = Infinity;
    for (const cell of this._shapeMask) {
      if (cell.x === char.gridX && cell.y === char.gridY) continue;
      if (this.grid.isOccupied(cell.x, cell.y)) continue;
      const d = Math.abs(cell.x - char.gridX) + Math.abs(cell.y - char.gridY);
      if (d < bestD) { bestD = d; best = cell; }
    }
    if (best) this._wanderTargets.set(char.id, { tx: best.x, ty: best.y });
  }

  _assignWanderTarget(char) {
    // Shape-constrained: pick from mask, biased toward drag if active
    if (this._shapeChars.has(char.id) && this._shapeMaskSet.size > 0) {
      // flowfill：不设目标 → 里字靠方向惯性在轮廓内成排循环流动（满填循环）。
      if (this._shapeConstraint === 'flowfill') return;
      const dragging = this.dragBias && this.dragBias.strength > 0.2;

      // strict（颜文字/巨字）非拖动：只在**锚点的小邻域**（曼哈顿≤2）里挑空格做就近
      // 华容道滑动 → 邻域常数级扫描（不再遍历整张掩码，这是卡顿主因之一）；里字持续
      // 小幅运动、轮廓与字数稳定（既保辨形又不静止）。
      if (this._shapeConstraint === 'strict' && !dragging) {
        const ax = char.anchorX != null ? char.anchorX : char.gridX;
        const ay = char.anchorY != null ? char.anchorY : char.gridY;
        const near = [];
        for (let oy = -2; oy <= 2; oy++) {
          const budget = 2 - Math.abs(oy);
          for (let ox = -budget; ox <= budget; ox++) {
            if (ox === 0 && oy === 0) continue;
            const nx = ax + ox, ny = ay + oy;
            if (!this._inMask(nx, ny)) continue;
            if (nx === char.gridX && ny === char.gridY) continue;
            if (this.grid.isOccupied(nx, ny)) continue;
            near.push({ x: nx, y: ny });
          }
        }
        if (near.length > 0) {
          const pick = near[(Math.random() * near.length) | 0];
          this._wanderTargets.set(char.id, { tx: pick.x, ty: pick.y });
        }
        return; // 邻域暂时无空格 → 本 tick 不设目标，下 tick 再试（不破坏字形）
      }

      // loose（花等）/ 拖动：在整片掩码内挑（频率较低、拖动是临时态）。
      const candidates = [];
      for (const c of this._shapeMask) {
        if (c.x === char.gridX && c.y === char.gridY) continue;
        if (this.grid.isOccupied(c.x, c.y)) continue;
        candidates.push(c);
      }
      if (candidates.length > 0) {
        const pick = this._pickShapeTarget(candidates, char);
        if (pick) this._wanderTargets.set(char.id, { tx: pick.x, ty: pick.y });
      }
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
    // 收紧约束：里字**拴在自己的锚点格附近**（曼哈顿≤2）做小幅横纵位移 → 运动范围
    // 小、形状收束稳定、又持续在动（不是无界游走、也不是卡死）。锚点附近暂无空格时
    // 退而求其次滑向离锚点最近的空格，始终被拉回字形。
    const ax = char.anchorX != null ? char.anchorX : char.gridX;
    const ay = char.anchorY != null ? char.anchorY : char.gridY;
    const near = candidates.filter(c => Math.abs(c.x - ax) + Math.abs(c.y - ay) <= 2);
    if (near.length > 0) return near[Math.floor(Math.random() * near.length)];
    // 离锚点太远（被挤出）→ 朝最靠近锚点的空格走，收回字形。
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c.x - ax) + Math.abs(c.y - ay);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
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

    // 就近贪心分配锚点：每个里字认领离自己最近的、尚未被认领的字形格。位移最小、
    // **不会被派到够不着的分块**（颜文字眼/嘴不连通时尤其重要），空位自然落在远离
    // 所有里字的位置而均匀分散。里字已在字形内（螺旋落位）时几乎零位移、即时成形。
    const chars = [...this._shapeChars]
      .map(id => this.characters.get(id))
      .filter(Boolean)
      // 先到先挑：让位移大的里字先选，减少长距离穿插。
      .sort((a, b) => (a.gridY - b.gridY) || (a.gridX - b.gridX));
    const cells = this._shapeMask;
    const used = new Array(cells.length).fill(false);

    for (const char of chars) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < cells.length; i++) {
        if (used[i]) continue;
        const d = Math.abs(cells[i].x - char.gridX) + Math.abs(cells[i].y - char.gridY);
        if (d < bd) { bd = d; bi = i; }
      }
      if (bi < 0) break; // 格子被认领光（里字多于格）→ 余下里字保持原目标
      used[bi] = true;
      const cell = cells[bi];
      this._wanderTargets.set(char.id, { tx: cell.x, ty: cell.y });
      char.anchorX = cell.x; // formation slot — strict shapes wiggle around here
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

  /**
   * 把显示位置重叠的里字推开（密集定形时尤为重要）。用**空间哈希**把成对检测从
   * O(N²) 降到 ~O(N)：每趟把里字按 minDist 大小的桶分格，只和相邻 3×3 桶里的里字
   * 比对 → 即便 ~300+ 里字也能 60fps 流畅推开（不再随字数平方变卡）。
   */
  _resolveDisplayCollisions() {
    const chars = [...this.characters.values()].filter(char => char.alpha > 0.01);
    const n = chars.length;
    if (n < 2) return;
    const half = this.cellSize / 2;
    const minDist = this.cellSize * 0.9;
    const minDistSq = minDist * minDist;
    const maxX = (this.grid.cols - 1) * this.cellSize;
    const maxY = (this.grid.rows - 1) * this.cellSize;
    const bs = minDist; // 桶边长 = minDist → 任何相距 < minDist 的一对必在相邻桶内
    const bkey = (bx, by) => bx * 100003 + by;
    const buckets = new Map();

    for (let pass = 0; pass < 12; pass++) {
      buckets.clear();
      for (let i = 0; i < n; i++) {
        const c = chars[i];
        const k = bkey(Math.floor((c.displayX + half) / bs), Math.floor((c.displayY + half) / bs));
        const arr = buckets.get(k);
        if (arr) arr.push(i); else buckets.set(k, [i]);
      }
      for (let i = 0; i < n; i++) {
        const a = chars[i];
        const ax = a.displayX + half, ay = a.displayY + half;
        const bx = Math.floor(ax / bs), by = Math.floor(ay / bs);
        for (let ddx = -1; ddx <= 1; ddx++) {
          for (let ddy = -1; ddy <= 1; ddy++) {
            const arr = buckets.get(bkey(bx + ddx, by + ddy));
            if (!arr) continue;
            for (const j of arr) {
              if (j <= i) continue; // 每对只处理一次
              const b = chars[j];
              let dx = (b.displayX + half) - ax;
              let dy = (b.displayY + half) - ay;
              let distSq = dx * dx + dy * dy;
              if (distSq >= minDistSq) continue;
              if (distSq < 0.0001) {
                const angle = this._stableNoise(a.id + b.id, a.gridX, a.gridY) * Math.PI * 2;
                dx = Math.cos(angle); dy = Math.sin(angle); distSq = 1;
              }
              const dist = Math.sqrt(distSq);
              const push = (minDist - dist) / 2;
              const ux = dx / dist, uy = dy / dist;
              a.displayX = Math.max(0, Math.min(maxX, a.displayX - ux * push));
              a.displayY = Math.max(0, Math.min(maxY, a.displayY - uy * push));
              b.displayX = Math.max(0, Math.min(maxX, b.displayX + ux * push));
              b.displayY = Math.max(0, Math.min(maxY, b.displayY + uy * push));
            }
          }
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
