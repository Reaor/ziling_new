/**
 * ZiLing main entry point — 互动态拖拽手感 demo (Plan A).
 *
 * Mobile WebView target: 390x700, 16px grid, PIBT cell-by-cell motion.
 *
 * 本入口当前聚焦「拖拽手感」的打磨：
 *   - 匀速：同一时刻所有里字速度一致；拖动期整体切到更快的固定 tick 跟手，
 *           但不随拖拽瞬时速度变速（收束 L23）。
 *   - 跟手：形状区域跟着手指整体平移（壳心跟手），里字快速沿格子追上。
 *   - 翻涌：里字以正常随机游走的方式不断涌入移动中的区域。
 *   - 动量：松手后偏置衰减、tick 平滑回落常速，swarm 自然晃荡、沉淀。
 *
 * 交互：
 *   拖拽   → 形状跟手 + 内部自由翻涌
 *   双击   → 切换形状（^_^ / 春 / 爱心 / 四叶花）
 *   单击   → 点击处里字散开，2.5 秒后归位
 *   长按   → 解除形状约束，全体自由漫游
 */

import { Renderer } from './render/renderer.js';
import { Grid } from './core/grid.js';
import { CharacterPool } from './core/character.js';
import { MotionEngine } from './core/motion.js';
import { ShapeSystem } from './core/shape.js';
import { GestureRecognizer } from './input/gestures.js';

const CELL_SIZE = 16;
const FONT_SIZE = 13;
const TICK_MS = 200;           // 常速 tick —— 匀速铁律（拖动期由引擎自行提速跟手）
const SCATTER_RESTORE_MS = 2500;
const FADE_MS = 600;           // 里字自适应增减时的淡入/淡出时长
const INITIAL_CHARS = 56;      // 首屏播种数（之后随形状自适应增减）
const MIN_CHARS = 28;
const MAX_CHARS = 156;
// 流动呈现：里字沿路径流动，约填满路径总格数的 FLOW_FILL，余下为流动所需空位。
// 空位越多越灵动（字更明显地动）、越少越实心。偏低取值优先"全员在动"（用户反馈
// 不要静止），靠加粗描边采样保证辨形。所有动态形状里字持续运动、速率一致。
const FLOW_FILL = 0.74;
// 微动：点击时随点击反应触发的一次性"轻摆"脉冲（全体一起做、随后衰减），
// 不常驻（常驻会很乱）。MICRO_AMP=幅度(px)，MICRO_DECAY_MS=衰减时长。
const MICRO_AMP = 3.0;
const MICRO_DECAY_MS = 520;
const BREAK_PROB = 0.3;        // 点击概率打破轮廓（里字散成自由云团再归位）
const BREAK_RESTORE_MS = 1600;
const CHAR_POOL = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜'.split('');

document.addEventListener('DOMContentLoaded', () => {
  const renderer = new Renderer('main-canvas');
  const { cssWidth, cssHeight } = renderer.init();

  const gridCols = Math.floor(cssWidth / CELL_SIZE);
  const gridRows = Math.floor(cssHeight / CELL_SIZE);
  const grid = new Grid(gridCols, gridRows);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, CELL_SIZE, 0);
  motion.tickDuration = TICK_MS;
  const shapes = new ShapeSystem();

  // ── Seed characters in a loose central block ──────────────
  let glyphSeq = 0;
  const nextGlyph = () => CHAR_POOL[(glyphSeq++) % CHAR_POOL.length];
  for (let i = 0; i < INITIAL_CHARS; i++) {
    const col = 2 + (i % 18);
    const row = 2 + Math.floor(i / 18);
    const c = pool.acquire(nextGlyph(), col, row);
    motion.registerCharacter(c);
  }
  console.log(`PIBT ready — Grid ${gridCols}x${gridRows}, ${INITIAL_CHARS} characters`);

  // ── Shape catalogue (cycled by double-tap) ────────────────
  // 统一为"流动呈现"：每个形状 make() 返回一组有序路径（paths）。
  //   - 颜文字/巨字：每条笔画一条开放路径 → 里字实心填满并往返流动（收束 L34/L23）。
  //   - 曲线/数学曲线：单条闭环路径 → 里字首尾相连绕圈流动。
  // `cells` 控制采样分辨率（越大越清晰、字越多，收束 L33）。里字数随路径总格数自适应。
  const SHAPES = [
    { name: '^_^',  cells: 96,  make: n => shapes.sampleEmoji('^_^', gridCols, gridRows, n) },
    { name: '>_<',  cells: 96,  make: n => shapes.sampleEmoji('>_<', gridCols, gridRows, n) },
    { name: '心',   cells: 132, make: n => shapes.sampleMegachar('心', gridCols, gridRows, n) },
    { name: '春',   cells: 156, make: n => shapes.sampleMegachar('春', gridCols, gridRows, n) },
    { name: '爱心', cells: 80,  make: n => shapes.sampleCurveOrdered('heart', gridCols, gridRows, n) },
    { name: '四叶花', cells: 96, make: n => shapes.sampleCurveOrdered('rose', gridCols, gridRows, n) },
  ];
  let shapeIndex = 0;
  let shapeActive = false;
  let currentPaths = null; // 当前形状的路径（散开/打断/松手后据此归位）

  // ── 里字自适应（增生/减少以适应形状大小，收束 L4）──────────
  // fadeTarget===0 的里字正在淡出回收，不计入"在册"里字。
  const aliveChars = () => pool.getAll().filter(c => c.fadeTarget !== 0);
  const aliveIds = () => aliveChars().map(c => c.id);

  // 让新里字在**当前字形内部/轮廓附近**就地淡入浮现（更丝滑），而不是从画布两侧
  // 排队走进来。优先字形内空格，其次轮廓外一格的"气泡层"，再兜底随机空格。
  function spawnEmergentChar(mask = []) {
    const candidates = [];
    const seen = new Set();
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= gridCols || y >= gridRows) return;
      const key = grid.getCellKey(x, y);
      if (seen.has(key) || grid.isOccupied(x, y)) return;
      seen.add(key);
      candidates.push([x, y]);
    };
    for (const c of mask) push(c.x, c.y);
    for (const c of mask) {
      push(c.x + 1, c.y); push(c.x - 1, c.y);
      push(c.x, c.y + 1); push(c.x, c.y - 1);
    }
    if (candidates.length === 0) {
      for (let a = 0; a < 80; a++) push((Math.random() * gridCols) | 0, (Math.random() * gridRows) | 0);
    }
    if (candidates.length === 0) return null;
    const cell = candidates[(Math.random() * candidates.length) | 0];
    const c = pool.acquire(nextGlyph(), cell[0], cell[1]);
    c.alpha = 0;       // 原地淡入：alpha 0→1，由 stepFades 推进
    c.fadeTarget = 1;
    motion.registerCharacter(c);
    return c;
  }

  // 里字淡出时给它一个最近边缘的目标，让它漂出画布再回收。
  function edgeTargetFor(c) {
    const left = c.gridX, right = gridCols - 1 - c.gridX;
    const top = c.gridY, bottom = gridRows - 1 - c.gridY;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return [0, c.gridY];
    if (m === right) return [gridCols - 1, c.gridY];
    if (m === top) return [c.gridX, 0];
    return [c.gridX, gridRows - 1];
  }

  // 调整在册里字数到 target：不足则边缘淡入，过多则淡出离场（挑离形状中心最远者）。
  function adaptCharCount(target, mask) {
    target = Math.max(MIN_CHARS, Math.min(MAX_CHARS, target));
    const alive = aliveChars();
    const diff = target - alive.length;
    if (diff > 0) {
      for (let k = 0; k < diff; k++) spawnEmergentChar(mask);
    } else if (diff < 0) {
      let cx = 0, cy = 0;
      for (const cell of mask) { cx += cell.x; cy += cell.y; }
      cx /= mask.length; cy /= mask.length;
      const victims = alive
        .map(c => ({ c, d: (c.gridX - cx) ** 2 + (c.gridY - cy) ** 2 }))
        .sort((a, b) => b.d - a.d)
        .slice(0, -diff)
        .map(o => o.c);
      for (const c of victims) {
        c.fadeTarget = 0;
        motion.freeFromShape(c.id);
        const [tx, ty] = edgeTargetFor(c);
        motion.setTarget(c.id, tx, ty);
      }
    }
  }

  // 推进淡入/淡出；淡出至 0 的里字回收。每帧调用。
  function stepFades(dtMs) {
    const rate = dtMs / FADE_MS;
    for (const c of pool.getAll()) {
      if (c.alpha < c.fadeTarget) {
        c.alpha = Math.min(c.fadeTarget, c.alpha + rate);
      } else if (c.alpha > c.fadeTarget) {
        c.alpha = Math.max(c.fadeTarget, c.alpha - rate);
        if (c.fadeTarget === 0 && c.alpha <= 0.02) {
          motion.unregisterCharacter(c.id);
          pool.release(c.id);
        }
      }
    }
  }

  const pathsCellCount = paths => paths.reduce((s, p) => s + p.cells.length, 0);

  // 用当前形状的路径把在册里字约束成"流动呈现"。散开/打断/松手后归位都用它。
  function formCurrent() {
    if (!currentPaths) return;
    motion.releaseShape();
    motion.setFlowPaths(currentPaths, aliveIds());
  }

  function applyShape(index) {
    shapeIndex = ((index % SHAPES.length) + SHAPES.length) % SHAPES.length;
    const def = SHAPES[shapeIndex];
    const sampled = def.make(def.cells);
    const paths = sampled.paths;
    if (!paths || paths.length === 0) return;
    currentPaths = paths;
    shapeActive = true;
    // 里字数随形状路径总格数自适应：约填满 FLOW_FILL，余下为流动所需空位（收束 L33）。
    const total = pathsCellCount(paths);
    const target = Math.max(MIN_CHARS, Math.min(MAX_CHARS, Math.round(total * FLOW_FILL)));
    adaptCharCount(target, paths.flatMap(p => p.cells));
    formCurrent();
    console.log(`Shape → ${def.name} (${paths.length} paths, ${total} cells, ${aliveIds().length}里字)`);
  }

  function releaseShape() {
    shapeActive = false;
    currentPaths = null;
    motion.releaseShape();
    console.log('Shape released → free wander');
  }

  // Reconstrain里字 to the current shape (used after scatter / break restore).
  function reformShape() {
    if (!shapeActive || !currentPaths) return;
    formCurrent();
  }

  // 松手后在落点处还原形状：把所有路径整体平移到 (cx,cy) 附近再成形。
  function reformAt(cx, cy) {
    if (!shapeActive || !currentPaths) return;
    const all = currentPaths.flatMap(p => p.cells);
    let ax = 0, ay = 0;
    for (const c of all) { ax += c.x; ay += c.y; }
    ax = Math.round(ax / all.length); ay = Math.round(ay / all.length);
    let sx = cx - ax, sy = cy - ay;
    const xs = all.map(c => c.x), ys = all.map(c => c.y);
    sx = Math.max(-Math.min(...xs), Math.min(gridCols - 1 - Math.max(...xs), sx));
    sy = Math.max(-Math.min(...ys), Math.min(gridRows - 1 - Math.max(...ys), sy));
    currentPaths = currentPaths.map(p => ({
      loop: p.loop,
      cells: p.cells.map(c => ({ x: c.x + sx, y: c.y + sy })),
    }));
    formCurrent();
  }

  // Form the first shape shortly after load.
  setTimeout(() => applyShape(0), 800);

  // ── Drag state ────────────────────────────────────────────
  let dragging = false;
  let dragEnd = null;        // last finger cell (reform spot on release)
  let orbitFinger = { x: 0, y: 0 }; // finger pixel pos driving the orbit
  let scatterTimer = null;
  let microEnv = 0;          // 微动脉冲包络（点击触发→衰减）

  const triggerMicro = () => { microEnv = 1; }; // 点击反应：全体来一次轻摆

  const gestures = new GestureRecognizer(renderer.canvas, CELL_SIZE, {
    onTap(col, row) {
      if (!shapeActive) return;
      clearTimeout(scatterTimer);
      triggerMicro(); // 点击伴随的微动反应（全体一起轻摆一下）
      if (Math.random() < BREAK_PROB) {
        // 概率打破轮廓（收束 L32）：里字暂时散成自由云团（不按轮廓），稍后归位。
        motion.releaseShape();
        scatterTimer = setTimeout(reformShape, BREAK_RESTORE_MS);
      } else {
        // 局部、小幅、美观的散开（收束 L31）：仅点击附近的里字轻轻外推。
        for (const char of aliveChars()) {
          const dist = Math.abs(char.gridX - col) + Math.abs(char.gridY - row);
          if (dist <= 3) motion.scatter(char.id, col, row, 3);
        }
        scatterTimer = setTimeout(reformShape, SCATTER_RESTORE_MS);
      }
    },

    onDoubleTap() {
      triggerMicro();
      applyShape(shapeIndex + 1);
    },

    onLongPress() {
      releaseShape();
    },

    // 拖动（收束 L30）：里字聚成方形，按同心方环逐层旋转、越拖越快；中心=手指、
    // 整块跟手平移；松手在落点还原之前的形状。由显示层驱动（见渲染循环）。
    onDragStart(col, row, px, py) {
      if (!shapeActive) return;
      dragging = true;
      dragEnd = { col, row };
      orbitFinger = { x: px, y: py };
      clearTimeout(scatterTimer);
      motion.startOrbit(aliveIds(), px, py);
    },

    onDragMove(col, row, px, py) {
      if (!dragging) return;
      dragEnd = { col, row };
      orbitFinger = { x: px, y: py };
    },

    onDragEnd() {
      if (!dragging) return;
      dragging = false;
      motion.endOrbit();
      if (dragEnd) reformAt(dragEnd.col, dragEnd.row); // 落点还原形状
    },
  });

  // ── Render loop ───────────────────────────────────────────
  const DEBUG = new URLSearchParams(window.location.search).get('debug') === '1';
  let running = true;
  let lastTime = performance.now();
  const frameTimes = [];
  let lastFpsLog = performance.now();
  let lastCheckSecond = -1;
  let collisionOk = true;

  function loop(now) {
    if (!running) { requestAnimationFrame(loop); return; }

    const dtMs = now - lastTime;
    lastTime = now;

    frameTimes.push(now);
    if (frameTimes.length > 60) frameTimes.shift();
    if (now - lastFpsLog >= 5000) {
      const elapsed = frameTimes[frameTimes.length - 1] - frameTimes[0];
      const avgFps = elapsed > 0 ? ((frameTimes.length - 1) / (elapsed / 1000)).toFixed(1) : '-';
      console.log(`[FPS] avg ${avgFps} over ${frameTimes.length} frames`);
      lastFpsLog = now;
    }

    renderer.clear();
    if (motion.isOrbiting()) {
      // 拖动环绕：显示层直接驱动（连续旋转 + 整块跟手平移），绕开 PIBT。
      motion.updateOrbitDisplay(dtMs, orbitFinger.x, orbitFinger.y);
    } else {
      motion.update(dtMs);
      motion.updateDisplayPositions(motion.tickProgress);
    }
    stepFades(dtMs);
    if (microEnv > 0) microEnv = Math.max(0, microEnv - dtMs / MICRO_DECAY_MS);

    if (DEBUG) {
      const checkSec = Math.floor(now / 5000);
      if (checkSec !== lastCheckSecond) {
        lastCheckSecond = checkSec;
        collisionOk = verifyNoCollisions(pool, grid);
      }
    }

    const ctx = renderer.getContext();
    ctx.font = `${FONT_SIZE}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e0e0e0';
    // 微动：点击触发的一次性"轻摆"脉冲（microEnv 由 1 衰减到 0），全体里字一起
    // 抖一下作为点击反应；平时为 0（不常驻，避免画面乱）。拖动时不叠加。
    const tSec = now / 1000;
    const amp = motion.isOrbiting() ? 0 : microEnv * MICRO_AMP;
    for (const char of pool.getAll()) {
      if (char.alpha > 0.01) {
        const mx = amp ? Math.sin(tSec * 9 + char.id * 1.3) * amp : 0;
        const my = amp ? Math.cos(tSec * 9 + char.id * 2.1) * amp : 0;
        ctx.globalAlpha = char.alpha;
        ctx.fillText(char.char,
          char.displayX + CELL_SIZE / 2 + mx,
          char.displayY + CELL_SIZE / 2 + my);
      }
    }
    ctx.globalAlpha = 1;

    if (DEBUG) {
      const instantFps = dtMs > 0 ? (1000 / dtMs).toFixed(0) : '-';
      const avgFt = frameTimes.length > 1
        ? (frameTimes[frameTimes.length - 1] - frameTimes[0]) / (frameTimes.length - 1)
        : 0;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `FPS:${instantFps} FT:${avgFt.toFixed(1)}ms CH:${pool.count()} ${SHAPES[shapeIndex].name} ${collisionOk ? 'OK' : '!!'}`,
        4, 4);
      ctx.restore();
    }

    requestAnimationFrame(loop);
  }

  function verifyNoCollisions(pool, grid) {
    const occupied = new Map();
    for (const char of pool.getAll()) {
      const key = grid.getCellKey(char.gridX, char.gridY);
      if (!occupied.has(key)) occupied.set(key, []);
      occupied.get(key).push(char.id);
    }
    for (const [key, ids] of occupied) {
      if (ids.length > 1) {
        console.warn(`COLLISION at key=${key}: chars ${ids.join(',')}`);
        return false;
      }
    }
    return true;
  }

  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) lastTime = performance.now();
  });

  document.fonts.ready.then(() => requestAnimationFrame(loop));
});
