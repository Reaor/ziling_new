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
const MAX_CHARS = 112;
// 形状掩码即字形本身（均匀采样）；里字只填满其中的 FILL_RATIO 比例，余下为
// "空格"。有空格里字才能像华容道一样持续滑动，而非成形即冻结。填充率越高越易
// 辨形、越低越灵动；strict（颜文字/巨字）填得更满保辨形，loose（曲线/花）更松。
// 所有动态形状都让里字持续运动：留出空位，里字在掩码内华容道式滑动（轮廓与
// 字数固定，但不静止）。strict（颜文字/巨字）填得较满保辨形，loose/flow 更松。
const FILL_RATIO = { strict: 0.8, loose: 0.72, flow: 0.80 };
const MICRO_AMP = 2.0;         // 亚像素微动幅度（px）：叠加在格子滑动之上的"呼吸"生命感
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
  // `cells` = 该形状采样后的目标掩码格数，反映其大小/复杂度；里字数随之自适应
  // （复杂形状如颜文字/笔画多的汉字配更大的格数，才能拼清晰，收束 L33）。
  // flow:true 的细轮廓用"沿轮廓流动"呈现（收束 L34）；其余用静态掩码 + 华容道游走。
  const SHAPES = [
    { name: '^_^',  constraint: 'strict', cells: 64,  make: n => shapes.sampleEmoji('^_^', gridCols, gridRows, n) },
    { name: '>_<',  constraint: 'strict', cells: 64,  make: n => shapes.sampleEmoji('>_<', gridCols, gridRows, n) },
    { name: '心',   constraint: 'strict', cells: 92,  make: n => shapes.sampleMegachar('心', gridCols, gridRows, n) },
    { name: '春',   constraint: 'strict', cells: 112, make: n => shapes.sampleMegachar('春', gridCols, gridRows, n) },
    { name: '爱心', constraint: 'flow',   flow: true, cells: 64, make: n => shapes.sampleCurveOrdered('heart', gridCols, gridRows, n) },
    { name: '四叶花', constraint: 'loose', cells: 92,  make: n => shapes.sampleCurve('rose', gridCols, gridRows, n) },
  ];
  let shapeIndex = 0;
  let shapeActive = false;
  let currentMask = null;
  let currentForm = null; // { flow, mask, constraint } —— 用于散开/打断后归位

  // ── 里字自适应（增生/减少以适应形状大小，收束 L4）──────────
  // fadeTarget===0 的里字正在淡出回收，不计入"在册"里字。
  const aliveChars = () => pool.getAll().filter(c => c.fadeTarget !== 0);
  const aliveIds = () => aliveChars().map(c => c.id);

  // 从画布边缘找一个空格让新里字淡入（首次/需要增生时）。
  function spawnEdgeChar() {
    const edge = [];
    for (let x = 0; x < gridCols; x++) { edge.push([x, 0]); edge.push([x, gridRows - 1]); }
    for (let y = 1; y < gridRows - 1; y++) { edge.push([0, y]); edge.push([gridCols - 1, y]); }
    for (let i = edge.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [edge[i], edge[j]] = [edge[j], edge[i]];
    }
    const cell = edge.find(([x, y]) => !grid.isOccupied(x, y));
    if (!cell) return null;
    const c = pool.acquire(nextGlyph(), cell[0], cell[1]);
    c.alpha = 0;
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
      for (let k = 0; k < diff; k++) spawnEdgeChar();
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

  // 用当前形态（flow 或静态掩码）把在册里字重新约束成形。散开/打断后归位也用它。
  function formCurrent() {
    if (!currentForm) return;
    motion.releaseShape();
    if (currentForm.flow) motion.setFlowPath(currentForm.mask, aliveIds());
    else motion.setShapeMask(currentForm.mask, aliveIds(), currentForm.constraint);
  }

  function applyShape(index) {
    shapeIndex = ((index % SHAPES.length) + SHAPES.length) % SHAPES.length;
    const def = SHAPES[shapeIndex];
    const sampled = def.make(def.cells);
    if (!sampled.mask || sampled.mask.length === 0) return;
    const mask = sampled.mask;                  // 字形掩码（FPS 均匀 / flow 有序）
    currentMask = mask;
    currentForm = { flow: !!def.flow, mask, constraint: def.constraint };
    shapeActive = true;
    // 里字数随形状大小/复杂度自适应：约填满掩码的 FILL_RATIO，并始终至少留 4 个
    // 空格供滑动/流动（避免满铺导致 PIBT 无空位可挪而卡死）。
    const fill = FILL_RATIO[def.constraint] || 0.75;
    const target = Math.min(Math.round(mask.length * fill), mask.length - 4);
    adaptCharCount(target, mask);
    formCurrent();
    console.log(`Shape → ${def.name} (${mask.length} cells, ${aliveIds().length}里字, ${def.constraint})`);
  }

  function releaseShape() {
    shapeActive = false;
    currentMask = null;
    currentForm = null;
    motion.releaseShape();
    console.log('Shape released → free wander');
  }

  // Reconstrain里字 to the current shape (used after scatter / break restore).
  function reformShape() {
    if (!shapeActive || !currentForm) return;
    formCurrent();
  }

  // 松手后在落点处还原形状：把当前形态整体平移到 (cx,cy) 附近再成形。
  function reformAt(cx, cy) {
    if (!shapeActive || !currentForm) return;
    const m = currentForm.mask;
    let ax = 0, ay = 0;
    for (const c of m) { ax += c.x; ay += c.y; }
    ax = Math.round(ax / m.length); ay = Math.round(ay / m.length);
    let sx = cx - ax, sy = cy - ay;
    const xs = m.map(c => c.x), ys = m.map(c => c.y);
    sx = Math.max(-Math.min(...xs), Math.min(gridCols - 1 - Math.max(...xs), sx));
    sy = Math.max(-Math.min(...ys), Math.min(gridRows - 1 - Math.max(...ys), sy));
    const moved = m.map(c => ({ x: c.x + sx, y: c.y + sy }));
    currentForm = { ...currentForm, mask: moved };
    currentMask = moved;
    formCurrent();
  }

  // Form the first shape shortly after load.
  setTimeout(() => applyShape(0), 800);

  // ── Drag state ────────────────────────────────────────────
  let dragging = false;
  let dragEnd = null;    // last finger cell during a drag (release / reform spot)
  let scatterTimer = null;

  const gestures = new GestureRecognizer(renderer.canvas, CELL_SIZE, {
    onTap(col, row) {
      if (!shapeActive) return;
      clearTimeout(scatterTimer);
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
      applyShape(shapeIndex + 1);
    },

    onLongPress() {
      releaseShape();
    },

    // 拖动 = 贪吃蛇环绕（收束 L30）：里字聚成绕手指的方环并旋转流动，跟手移动；
    // 松手在落点还原之前的形状。
    onDragStart(col, row) {
      if (!shapeActive) return;
      dragging = true;
      dragEnd = { col, row };
      clearTimeout(scatterTimer);
      motion.beginOrbit(col, row);
    },

    onDragMove(col, row) {
      if (!dragging) return;
      dragEnd = { col, row };
      motion.moveOrbit(col, row);
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
    motion.update(dtMs);
    motion.updateDisplayPositions(motion.tickProgress);
    stepFades(dtMs);

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
    // 亚像素微动：固定阵型（如颜文字/巨字满铺）靠它呈现"呼吸/轻摆"的生命感，
    // 让里字看起来全员在动而不破坏形状清晰度（位移 < 半格，绝不重叠）。
    const tSec = now / 1000;
    for (const char of pool.getAll()) {
      if (char.alpha > 0.01) {
        const mx = Math.sin(tSec * 1.7 + char.id * 1.3) * MICRO_AMP;
        const my = Math.cos(tSec * 1.4 + char.id * 2.1) * MICRO_AMP;
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
