/**
 * ZiLing main entry point — 互动态拖拽手感 demo (Plan A).
 *
 * Mobile WebView target: 390x700, 16px grid, PIBT cell-by-cell motion.
 *
 * 本入口当前聚焦「拖拽手感」的打磨：
 *   - 匀速：tick 固定，绝不随拖拽速度变速（收束 L23）。
 *   - 跟手：形状区域跟着手指整体平移（壳心跟手）。
 *   - 翻涌：里字以正常随机游走的方式不断涌入移动中的区域。
 *   - 动量：松手后偏置衰减，swarm 自然晃荡、沉淀，而非戛然而止。
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
const CHAR_COUNT = 64;         // every shape is padded to exactly this many cells
const TICK_MS = 200;           // 固定 tick —— 匀速铁律
const SCATTER_RESTORE_MS = 2500;
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
  for (let i = 0; i < CHAR_COUNT; i++) {
    const col = 2 + (i % 20);
    const row = 2 + Math.floor(i / 20);
    const c = pool.acquire(CHAR_POOL[i % CHAR_POOL.length], col, row);
    motion.registerCharacter(c);
  }
  console.log(`PIBT ready — Grid ${gridCols}x${gridRows}, ${CHAR_COUNT} characters`);

  // ── Shape catalogue (cycled by double-tap) ────────────────
  // Every shape is sampled then padded to exactly CHAR_COUNT cells, so each
  // 里字 owns one cell (bijection): zero roamers, fully-filled glyphs.
  const SHAPES = [
    { name: '^_^',  constraint: 'strict', make: () => shapes.sampleEmoji('^_^', gridCols, gridRows, CHAR_COUNT) },
    { name: '心',   constraint: 'strict', make: () => shapes.sampleMegachar('心', gridCols, gridRows, CHAR_COUNT) },
    { name: '春',   constraint: 'strict', make: () => shapes.sampleMegachar('春', gridCols, gridRows, CHAR_COUNT) },
    { name: '爱心', constraint: 'loose',  make: () => shapes.sampleCurve('heart', gridCols, gridRows, CHAR_COUNT) },
    { name: '四叶花', constraint: 'loose', make: () => shapes.sampleCurve('rose', gridCols, gridRows, CHAR_COUNT) },
  ];
  let shapeIndex = 0;
  let shapeActive = false;
  let currentMask = null;

  // Grow a sparse mask outward until it has exactly `count` cells.
  function padMask(mask, count) {
    if (mask.length >= count) return mask.slice(0, count);
    const key = (x, y) => y * gridCols + x;
    const seen = new Set(mask.map(c => key(c.x, c.y)));
    const out = mask.slice();
    const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    for (let i = 0; out.length < count && i < out.length; i++) {
      for (const [dx, dy] of ring) {
        const x = out[i].x + dx, y = out[i].y + dy;
        if (x < 0 || y < 0 || x >= gridCols || y >= gridRows) continue;
        if (seen.has(key(x, y))) continue;
        seen.add(key(x, y));
        out.push({ x, y });
        if (out.length >= count) break;
      }
    }
    return out;
  }

  function applyShape(index) {
    shapeIndex = ((index % SHAPES.length) + SHAPES.length) % SHAPES.length;
    const sampled = SHAPES[shapeIndex].make();
    if (!sampled.mask || sampled.mask.length === 0) return;
    const mask = padMask(sampled.mask, CHAR_COUNT);
    currentMask = mask;
    shapeActive = true;
    motion.releaseShape();
    motion.setShapeMask(mask, pool.getAll().map(c => c.id), SHAPES[shapeIndex].constraint);
    console.log(`Shape → ${SHAPES[shapeIndex].name} (${mask.length} cells, ${SHAPES[shapeIndex].constraint})`);
  }

  function releaseShape() {
    shapeActive = false;
    currentMask = null;
    motion.releaseShape();
    console.log('Shape released → free wander');
  }

  // Reconstrain里字 to the current shape (used after scatter restore).
  function reformShape() {
    if (!shapeActive || !currentMask) return;
    motion.setShapeMask(currentMask, pool.getAll().map(c => c.id), SHAPES[shapeIndex].constraint);
  }

  // Form the first shape shortly after load.
  setTimeout(() => applyShape(0), 800);

  // ── Drag state ────────────────────────────────────────────
  let dragging = false;
  let dragFrom = null;   // grid cell where the drag began
  let dragLast = null;   // last grid cell seen (for instantaneous velocity)
  let scatterTimer = null;

  const gestures = new GestureRecognizer(renderer.canvas, CELL_SIZE, {
    onTap(col, row) {
      // Scatter里字 near the tap, then drift them home.
      for (const char of pool.getAll()) {
        const dist = Math.abs(char.gridX - col) + Math.abs(char.gridY - row);
        if (dist <= 3) motion.scatter(char.id, col, row);
      }
      if (shapeActive) {
        clearTimeout(scatterTimer);
        scatterTimer = setTimeout(reformShape, SCATTER_RESTORE_MS);
      }
    },

    onDoubleTap() {
      applyShape(shapeIndex + 1);
    },

    onLongPress() {
      releaseShape();
    },

    onDragStart(col, row) {
      dragging = true;
      dragFrom = { col, row };
      dragLast = { col, row };
      motion.beginShapeDrag();
      motion.dragBias = { dx: 0, dy: 0, strength: 0 };
    },

    onDragMove(col, row) {
      if (!dragging) return;
      const cumDx = col - dragFrom.col;   // cumulative — drives the mask shift
      const cumDy = row - dragFrom.row;
      const insDx = col - dragLast.col;   // instantaneous — drives the surge dir
      const insDy = row - dragLast.row;
      if (cumDx === 0 && cumDy === 0 && insDx === 0 && insDy === 0) return;

      // Surge direction follows the latest finger motion; fall back to the
      // overall displacement so a slow steady drag still leans correctly.
      let bx = insDx, by = insDy;
      if (bx === 0 && by === 0) { bx = cumDx; by = cumDy; }
      const len = Math.hypot(bx, by) || 1;
      const speed = Math.hypot(insDx, insDy);
      motion.dragBias = {
        dx: bx / len,
        dy: by / len,
        strength: Math.max(0.3, Math.min(1, speed / 3)),
      };

      // Region tracks the finger (壳心跟手). Speed stays constant — a fast
      // drag simply outruns the swarm, which then streams to catch up.
      motion.previewShapeDrag(cumDx, cumDy);
      dragLast = { col, row };
    },

    onDragEnd() {
      dragging = false;
      dragFrom = null;
      dragLast = null;
      motion.endShapeDrag(); // begins momentum slosh; tick stays at TICK_MS
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
    motion.update(dtMs);
    motion.updateDisplayPositions(motion.tickProgress);

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
    for (const char of pool.getAll()) {
      if (char.alpha > 0.01) {
        ctx.globalAlpha = char.alpha;
        ctx.fillText(char.char, char.displayX + CELL_SIZE / 2, char.displayY + CELL_SIZE / 2);
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
