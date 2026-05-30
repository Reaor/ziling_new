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
// 里字自适应 = 螺旋淡入/淡出（沿几条螺旋臂一个接一个，向内淡入/向外淡出）。
const SPIRAL_ARMS = 4;         // 几条螺旋臂（均匀分布的几个方向）
const SPIRAL_MS = 950;         // 单个里字飞入/飞出时长
const SPIRAL_STAGGER_MS = 70;  // 同臂相邻里字的出发间隔（形成"一个接一个"队列）
const SPIRAL_TURNS = 0.7;      // 螺旋缠绕圈数
const INITIAL_CHARS = 56;      // 首屏播种数（之后随形状自适应增减）
const MIN_CHARS = 28;
const MAX_CHARS = 190;   // 巨字密集定形需要较多里字才能填满字形（B 方案）
// 流动呈现：里字沿路径流动，按形态分别控制填充率。
//  - 闭环曲线(心形/花)：近乎全覆盖，线条才连续不断（用户反馈"曲线没被全覆盖"）。
//  - 开放笔画(颜文字/巨字)：留更多空位 → 传送带推得动、更灵动（不要静止）。
const FLOW_FILL_LOOP = 0.95;
// 骨架细笔画（颜文字/巨字）是 1 格宽中心线：开放笔画走"单向传送带+尾端淡出/首端淡入"，
// 留约 1/4 空位让传送带顺畅流动、人人都动（细处也不静止）。闭环（曲线/眼睛 o）用 LOOP。
const FLOW_FILL_STROKE = 0.78;
// strict（颜文字/巨字）：密集定形、紧约束就近微动。填得很满 → 轮廓清爽稳定、易辨形
// （留极少空位让里字轻微错动、配合微动呼吸即有生命感，不靠大幅游走）。
const STRICT_FILL = 0.85;
// 微动：MICRO_AMP=点击反应脉冲幅度(px，点击时全体轻摆一下后衰减)；DECAY=衰减时长。
const MICRO_AMP = 5.5;
const MICRO_DECAY_MS = 700;
const BREAK_PROB = 0.3;        // 点击概率打破轮廓（里字散成自由云团再归位）
const BREAK_RESTORE_MS = 1600;
const CHAR_POOL = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜'.split('');

document.addEventListener('DOMContentLoaded', () => {
  const renderer = new Renderer('main-canvas');
  const { cssWidth, cssHeight } = renderer.init();

  const gridCols = Math.floor(cssWidth / CELL_SIZE);
  const gridRows = Math.floor(cssHeight / CELL_SIZE);
  const grid = new Grid(gridCols, gridRows);
  const pool = new CharacterPool(260);
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
  let currentPaths = null;      // flow（曲线）的有序路径；strict 时为 null
  let currentCells = [];        // 当前形状占用的格子（strict 掩码 / flow 路径格的并集）
  let currentConstraint = 'flow'; // 'strict'（颜文字/巨字）| 'flow'（曲线）

  // ── 里字自适应 = 螺旋淡入/淡出（显示层动画，绕开 PIBT，收束 L4）──────────
  // 新增/消失的里字沿 SPIRAL_ARMS 条螺旋臂"一个接一个"整齐排列：向内运动=淡入
  // （到达字形后并入流动），向外运动=淡出（到外圈后回收）。比"原地统一浮现"耐看。
  const transit = [];            // 进行中的螺旋 agent
  const transitIds = new Set();  // 正在螺旋过渡的里字 id（不计入在册 / 不参与流动）
  let reformPending = false;     // 过渡批次结束后重排一次流动（均匀覆盖）
  const ease = t => t * t * (3 - 2 * t);

  // "在册"里字 = 已成形参与流动的（排除正在螺旋过渡的）。
  const aliveChars = () => pool.getAll().filter(c => !transitIds.has(c.id));
  const aliveIds = () => aliveChars().map(c => c.id);

  function shapeCenterPx(mask) {
    let cx = 0, cy = 0;
    for (const c of mask) { cx += c.x; cy += c.y; }
    const n = mask.length || 1;
    return { x: (cx / n + 0.5) * CELL_SIZE, y: (cy / n + 0.5) * CELL_SIZE };
  }
  function shapeRadiusPx(mask, center) {
    let maxd = CELL_SIZE * 2;
    for (const c of mask) {
      const dx = (c.x + 0.5) * CELL_SIZE - center.x, dy = (c.y + 0.5) * CELL_SIZE - center.y;
      maxd = Math.max(maxd, Math.hypot(dx, dy));
    }
    return maxd;
  }
  // 离 (gx,gy) 最近的、未被占用的字形格（让飞入的字就近落位，不跳来跳去）。
  function closestFreeMaskCell(mask, gx, gy) {
    let best = null, bestD = Infinity;
    for (const c of mask) {
      if (grid.isOccupied(c.x, c.y)) continue;
      const d = (c.x - gx) ** 2 + (c.y - gy) ** 2;
      if (d < bestD) { bestD = d; best = [c.x, c.y]; }
    }
    return best;
  }

  // 增字：沿螺旋臂向内淡入。rank 让同臂里字错峰出发 → 排成"一个接一个"的队列。
  function spawnSpiralIn(count, mask) {
    const center = shapeCenterPx(mask);
    const rIn = Math.max(CELL_SIZE * 2, shapeRadiusPx(mask, center) * 0.5);
    const rOut = rIn + CELL_SIZE * 9;
    for (let k = 0; k < count; k++) {
      const arm = k % SPIRAL_ARMS, rank = Math.floor(k / SPIRAL_ARMS);
      const c = pool.acquire(nextGlyph(), 0, 0);
      c.alpha = 0;
      transitIds.add(c.id);
      transit.push({ char: c, mode: 'in', center, rIn, rOut, mask,
        base: (arm / SPIRAL_ARMS) * Math.PI * 2,
        elapsed: -rank * SPIRAL_STAGGER_MS, dur: SPIRAL_MS });
    }
  }

  // 减字：挑离中心最远的里字，沿螺旋臂向外淡出后回收。
  function despawnSpiralOut(count, mask) {
    const center = shapeCenterPx(mask);
    const rIn = Math.max(CELL_SIZE * 2, shapeRadiusPx(mask, center) * 0.5);
    const rOut = rIn + CELL_SIZE * 9;
    const victims = aliveChars()
      .map(c => ({ c, d: (c.displayX - center.x) ** 2 + (c.displayY - center.y) ** 2 }))
      .sort((a, b) => b.d - a.d).slice(0, count).map(o => o.c);
    victims.forEach((c, k) => {
      const arm = k % SPIRAL_ARMS, rank = Math.floor(k / SPIRAL_ARMS);
      transitIds.add(c.id);
      motion.unregisterCharacter(c.id); // 退出 PIBT，腾出格子
      transit.push({ char: c, mode: 'out', center, rIn, rOut, mask,
        base: (arm / SPIRAL_ARMS) * Math.PI * 2,
        elapsed: -rank * SPIRAL_STAGGER_MS, dur: SPIRAL_MS });
    });
    if (victims.length) reformPending = true;
  }

  function adaptCharCount(target, mask) {
    target = Math.max(MIN_CHARS, Math.min(MAX_CHARS, target));
    const diff = target - aliveChars().length;
    if (diff > 0) spawnSpiralIn(diff, mask);
    else if (diff < 0) despawnSpiralOut(-diff, mask);
  }

  // 每帧推进螺旋 agent：设 displayX/Y + alpha；到点则并入流动 / 回收。
  function updateSpirals(dtMs) {
    if (transit.length === 0) return;
    for (let i = transit.length - 1; i >= 0; i--) {
      const a = transit[i];
      a.elapsed += dtMs;
      const p = Math.max(0, Math.min(1, a.elapsed / a.dur));
      // 向内：r 从 rOut→rIn、alpha 0→1；向外：r 从 rIn→rOut、alpha 1→0。
      const rr = a.mode === 'in'
        ? a.rOut + (a.rIn - a.rOut) * ease(p)
        : a.rIn + (a.rOut - a.rIn) * ease(p);
      const theta = a.base + SPIRAL_TURNS * Math.PI * 2 * (1 - (rr - a.rIn) / (a.rOut - a.rIn));
      a.char.displayX = a.center.x + rr * Math.cos(theta) - CELL_SIZE / 2;
      a.char.displayY = a.center.y + rr * Math.sin(theta) - CELL_SIZE / 2;
      a.char.alpha = a.mode === 'in' ? p : (1 - p);
      if (p >= 1) {
        if (a.mode === 'in') finalizeSpiralIn(a);
        else pool.release(a.char.id);
        transitIds.delete(a.char.id);
        transit.splice(i, 1);
      }
    }
    if (transit.length === 0 && reformPending) { reformPending = false; reformShape(); }
  }

  // 螺旋飞入到点 → 落进字形最近空格、注册进引擎，待批次结束并入流动。
  function finalizeSpiralIn(a) {
    const cgx = Math.max(0, Math.min(gridCols - 1, Math.round(a.char.displayX / CELL_SIZE)));
    const cgy = Math.max(0, Math.min(gridRows - 1, Math.round(a.char.displayY / CELL_SIZE)));
    const cell = closestFreeMaskCell(a.mask, cgx, cgy) || closestFreeMaskCell(currentCells, cgx, cgy);
    const gx = cell ? cell[0] : cgx;
    const gy = cell ? cell[1] : cgy;
    a.char.gridX = gx; a.char.gridY = gy; a.char.prevGridX = gx; a.char.prevGridY = gy;
    a.char.alpha = 1;
    motion.registerCharacter(a.char);
    reformPending = true;
  }

  // 把在册里字约束成当前形状：strict（颜文字/巨字）= 密集定形紧约束；flow（曲线）=
  // 沿闭环流动。散开/打断/松手归位、螺旋增减后并入都用它。
  function formCurrent() {
    motion.releaseShape();
    if (currentConstraint === 'strict') {
      motion.setShapeMask(currentCells, aliveIds(), 'strict');
    } else if (currentPaths) {
      motion.setFlowPaths(currentPaths, aliveIds());
    }
  }

  function applyShape(index) {
    shapeIndex = ((index % SHAPES.length) + SHAPES.length) % SHAPES.length;
    const def = SHAPES[shapeIndex];
    const sampled = def.make(def.cells);
    shapeActive = true;
    let target = 0;
    if (sampled.paths && sampled.paths.length > 0) {
      // 颜文字/巨字（骨架细笔画）/ 曲线 → flow 沿线流动。闭环近乎全覆盖、开放笔画留
      // 空位供流动。每条笔画**至少留 1 个空位**（容量上限），否则满路径会流动死锁。
      currentConstraint = 'flow';
      currentPaths = sampled.paths;
      currentCells = sampled.paths.flatMap(p => p.cells);
      let capacity = 0;
      for (const p of sampled.paths) {
        target += Math.round(p.cells.length * (p.loop ? FLOW_FILL_LOOP : FLOW_FILL_STROKE));
        capacity += Math.max(0, p.cells.length - 1);
      }
      target = Math.min(Math.max(MIN_CHARS, target), capacity); // MIN 不得超过容量
    } else if (sampled.mask && sampled.mask.length > 0) {
      currentConstraint = 'strict';
      currentPaths = null;
      currentCells = sampled.mask;
      target = Math.max(MIN_CHARS, Math.round(sampled.mask.length * STRICT_FILL));
    } else {
      return;
    }
    target = Math.min(MAX_CHARS, target);
    // 里字数随形状自适应（螺旋淡入/淡出）。
    adaptCharCount(target, currentCells);
    formCurrent();
    console.log(`Shape → ${def.name} (${currentConstraint}, ${currentCells.length} cells, ${aliveIds().length}里字)`);
  }

  function releaseShape() {
    shapeActive = false;
    currentPaths = null;
    currentCells = [];
    motion.releaseShape();
    console.log('Shape released → free wander');
  }

  // Reconstrain里字 to the current shape (used after scatter / break restore).
  function reformShape() {
    if (!shapeActive || currentCells.length === 0) return;
    formCurrent();
  }

  // 松手后在落点处还原形状：把形状整体平移到 (cx,cy) 附近再成形。
  function reformAt(cx, cy) {
    if (!shapeActive || currentCells.length === 0) return;
    let ax = 0, ay = 0;
    for (const c of currentCells) { ax += c.x; ay += c.y; }
    ax = Math.round(ax / currentCells.length); ay = Math.round(ay / currentCells.length);
    let sx = cx - ax, sy = cy - ay;
    const xs = currentCells.map(c => c.x), ys = currentCells.map(c => c.y);
    sx = Math.max(-Math.min(...xs), Math.min(gridCols - 1 - Math.max(...xs), sx));
    sy = Math.max(-Math.min(...ys), Math.min(gridRows - 1 - Math.max(...ys), sy));
    const shift = c => ({ x: c.x + sx, y: c.y + sy });
    currentCells = currentCells.map(shift);
    if (currentPaths) currentPaths = currentPaths.map(p => ({ loop: p.loop, cells: p.cells.map(shift) }));
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
        // 点击处明显的"涟漪"散开（收束 L31）：附近里字明显向外弹开再归位。
        for (const char of aliveChars()) {
          const dist = Math.abs(char.gridX - col) + Math.abs(char.gridY - row);
          if (dist <= 5) motion.scatter(char.id, col, row, 5);
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
    updateSpirals(dtMs); // 螺旋淡入/淡出（在显示位置更新之后，覆盖过渡里字的显示）
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
    // 微动：仅保留**点击反应**的一次性"轻摆"脉冲（microEnv 由 1 衰减），平时为 0。
    // 形状的生命感来自里字本身收紧的横纵位移，不再叠加常驻颤动（那样各自乱抖、不协调）。
    const tSec = now / 1000;
    const amp = motion.isOrbiting() ? 0 : microEnv * MICRO_AMP;
    for (const char of pool.getAll()) {
      // 流动淡入/淡出（开放笔画首端淡入、尾端淡出）与螺旋淡入淡出 alpha 相乘。
      const eff = char.alpha * (char.flowFade != null ? char.flowFade : 1);
      if (eff > 0.01) {
        const mx = amp ? Math.sin(tSec * 9 + char.id * 1.3) * amp : 0;
        const my = amp ? Math.cos(tSec * 9 + char.id * 2.1) * amp : 0;
        ctx.globalAlpha = eff;
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
