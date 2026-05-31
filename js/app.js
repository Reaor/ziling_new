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
import { ShapeSystem, EMOJI_TEMPLATES } from './core/shape.js';
import { GestureRecognizer } from './input/gestures.js';

const CELL_SIZE = 11;          // 网格分辨率：实心多排里字定形；格子适中→笔画有 2~3 排里字、复杂字也分得开
const FONT_SIZE = 10;          // 里字字号：必须 ≤ CELL_SIZE(11) 才不溢出格子；留 1px 余白→相邻里字不糊、清爽不重叠
const TICK_MS = 200;           // 常速 tick —— 匀速铁律（拖动期由引擎自行提速跟手）
const SCATTER_RESTORE_MS = 2500;
// 里字自适应 = 螺旋淡入/淡出（沿几条螺旋臂一个接一个，向内淡入/向外淡出）。
const SPIRAL_ARMS = 4;         // 几条螺旋臂（均匀分布的几个方向）
const SPIRAL_MS = 950;         // 单个里字飞入/飞出时长
const SPIRAL_STAGGER_MS = 70;  // 同臂相邻里字的出发间隔（形成"一个接一个"队列）
const SPIRAL_TURNS = 0.7;      // 螺旋缠绕圈数
const INITIAL_CHARS = 56;      // 首屏播种数（之后随形状自适应增减）
const MIN_CHARS = 28;
const MAX_CHARS = 340;   // 高分辨率 + 粗笔画填满字身需要较多里字（复杂字如"爱"≈300+）
// 流动呈现：里字沿路径流动，按形态分别控制填充率。
//  - 闭环曲线(心形/花)：近乎全覆盖，线条才连续不断（用户反馈"曲线没被全覆盖"）。
//  - 开放笔画(颜文字/巨字)：留更多空位 → 传送带推得动、更灵动（不要静止）。
const FLOW_FILL_LOOP = 0.95;
// 骨架细笔画（巨字）是 1 格宽中心线：开放笔画走"单向传送带+尾端淡出/首端淡入"，需留出
// 约 4 成空位传送带才推得动、人人都流动（实测填到 0.78 会把细线挤满→卡死几乎不动；0.62
// 时心/永/水等几乎全员流动、静止极少）。闭环（曲线/眼睛 o）另用更满的 LOOP。
const FLOW_FILL_STROKE = 0.62;
// strict（颜文字/巨字）= 满填循环流动 flowfill：里字填满字身约 85%（留约 15% 缝隙→笔画
// 内有空格可循环流动、不卡死）。被牢牢约束在轮廓内（绝不漏出）；掩码外/被堵的里字朝最近
// 空掩码格走（入场收束 + 填缝隙）→ 收束紧、分布均匀、少静止。配合较小页面 + 收束的字形
// （字更小更细→掩码更小可填满、密集区更少），底部覆盖好、几乎无静止。
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
  const pool = new CharacterPool(460);
  const motion = new MotionEngine(grid, CELL_SIZE, 0);
  motion.tickDuration = TICK_MS;
  const shapes = new ShapeSystem();

  // ── 字形位图缓存（性能：把每个里字预渲染成小位图，渲染时 drawImage 而非 fillText）──
  // 数百里字时 fillText 是每帧主要开销（卡顿源）；drawImage 走 GPU、快 5~10×。
  const DPR = window.devicePixelRatio || 1;
  const glyphCache = new Map();
  function getGlyph(ch) {
    let g = glyphCache.get(ch);
    if (g) return g;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(CELL_SIZE * DPR);
    cv.height = Math.ceil(CELL_SIZE * DPR);
    const c = cv.getContext('2d');
    c.scale(DPR, DPR);
    c.font = `${FONT_SIZE}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#e0e0e0';
    c.fillText(ch, CELL_SIZE / 2, CELL_SIZE / 2);
    glyphCache.set(ch, cv);
    return cv;
  }

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

  // 形状目录（双击切换）。
  //   - 颜文字/巨字：实心定形 mask → strict（里字填满字身、小幅华容道滑动，易辨形不发乱）。
  //   - 曲线/数学曲线：单条闭环路径 → flow（里字首尾相连绕圈流动）。
  // `cells` 是该形状里字数上限的提示（越大越密、越清晰）。里字数随掩码格数自适应增减。
  const SHAPES = [
    { name: '^_^',  cells: 150, make: n => shapes.sampleEmoji('^_^', gridCols, gridRows, n) },
    { name: '>_<',  cells: 150, make: n => shapes.sampleEmoji('>_<', gridCols, gridRows, n) },
    { name: '心',   cells: 340, make: n => shapes.sampleMegachar('心', gridCols, gridRows, n) },
    { name: '春',   cells: 340, make: n => shapes.sampleMegachar('春', gridCols, gridRows, n) },
    { name: '福',   cells: 340, make: n => shapes.sampleMegachar('福', gridCols, gridRows, n) },
    { name: '龙',   cells: 340, make: n => shapes.sampleMegachar('龙', gridCols, gridRows, n) },
    { name: '爱心', cells: 80,  make: n => shapes.sampleCurveOrdered('heart', gridCols, gridRows, n) },
    { name: '四叶花', cells: 96, make: n => shapes.sampleCurveOrdered('rose', gridCols, gridRows, n) },
    { name: '五角星', cells: 96, make: n => shapes.sampleCurveOrdered('star', gridCols, gridRows, n) },
    { name: '无穷',  cells: 96, make: n => shapes.sampleCurveOrdered('lemniscate', gridCols, gridRows, n) },
    { name: '风车',  cells: 110, make: n => shapes.sampleCurveOrdered('pinwheel', gridCols, gridRows, n) },
    { name: '北京时间', clock: true },   // 即时时分秒：每秒重采样 HH/MM/SS 竖排 → 数字滚动
    // 进阶·动态曲线（里字匀速走格 + 形状自身周期性变化叠加）：
    { name: '正弦波', make: () => ({ mask: buildWaveCells(),   anim: 'wave' }) },
    { name: '水波',   make: () => ({ mask: buildRippleCells(), anim: 'ripple' }) },
    { name: 'DNA双螺旋', make: () => ({ mask: buildDnaCells(), anim: 'dna' }) },
    { name: '涟漪',   make: () => ({ mask: buildDiskCells(),   anim: 'pulse' }) },
    { name: '旋涡',   make: () => ({ mask: buildDiskCells(),   anim: 'vortex' }) },
    { name: '绸缎',   make: () => ({ mask: buildBlockCells(),  anim: 'cloth' }) },
    { name: '脉动花', make: () => ({ mask: buildRoseCells(),   anim: 'bloom' }) },
  ];
  let shapeIndex = 0;
  let shapeActive = false;
  let inOrigin = false;         // 原态（文本行）态：长按进入；点/双击/拖动回到动态形状
  let currentAnim = null;       // 动态曲线的"形状自身动态"函数 (char,t)=>void（显示层）；无则 null
  let clockTimer = null;        // 北京时间：每秒重采样的定时器
  let lastOriginText = null;    // 最近一次原态文本（长按回归原态时按此内容/顺序还原）
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
    if (transit.length === 0 && reformPending) {
      reformPending = false;
      if (inOrigin) layoutOrigin(true); else reformShape();   // 原态：批次结束后含新字重排文本行
    }
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

  // 把在册里字约束成当前形状：strict（颜文字/巨字）= 满填循环流动（笔画内转大圈）；
  // flow（曲线）= 沿闭环流动。散开/打断/松手归位、螺旋增减后并入都用它。
  function formCurrent() {
    motion.releaseShape();
    if (currentConstraint === 'strict') {
      motion.setFlowFill(currentCells, aliveIds());
    } else if (currentConstraint === 'anchored') {
      formAnchored(currentCells);
    } else if (currentConstraint === 'origin') {
      layoutOrigin(true);
    } else if (currentPaths) {
      motion.setFlowPaths(currentPaths, aliveIds());
    }
  }

  // 动态曲线：把在册里字钉到底形格上（按阅读序就近配对，1:1）。不流动 → 无颤动/重叠；
  // 形状自身动态由 currentAnim 在显示层平滑叠加。
  function formAnchored(cells) {
    const alive = aliveChars();
    if (alive.length === 0) return;
    const S = alive.slice().sort((a, b) => (a.gridY - b.gridY) || (a.gridX - b.gridX));
    const C = cells.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    motion.setTextLine(C, S.map(c => c.id), 'anchored');
  }

  // 把一份采样结果（mask 或 paths）成形。供双击循环、调试面板任意字/颜文字/曲线共用。
  function formSampled(sampled, label = 'shape') {
    stopClock();                 // 切到任何普通形状都停掉时钟定时器
    shapeActive = true;
    inOrigin = false;
    currentAnim = sampled.anim ? ANIMS[sampled.anim] : null; // 动态曲线开启形状自身动态
    let target = 0;
    if (sampled.paths && sampled.paths.length > 0) {
      // 曲线/数学曲线 → flow 沿线流动。闭环近乎全覆盖、开放笔画留空位供流动。
      currentConstraint = 'flow';
      currentPaths = sampled.paths;
      currentCells = sampled.paths.flatMap(p => p.cells);
      let capacity = 0;
      for (const p of sampled.paths) {
        target += Math.round(p.cells.length * (p.loop ? FLOW_FILL_LOOP : FLOW_FILL_STROKE));
        capacity += Math.max(0, p.cells.length - 1);
      }
      target = Math.min(Math.max(MIN_CHARS, target), capacity);
    } else if (sampled.mask && sampled.mask.length > 0) {
      // 颜文字/巨字 → 满填循环流动：里字数 ≈ 掩码格数 × 0.88（留约 12% 缝隙供笔画内
      // 循环流动）。不强行抬到 MIN_CHARS（否则小字形会多出无处安放的里字乱游）。
      // 动态曲线(anim)→钉位 anchored（不流动，避免颤动/重叠，形状动态由 currentAnim 叠加），
      // 一字一格(填满 cells)；其余颜文字/巨字→strict 满填循环流动。
      currentConstraint = sampled.anim ? 'anchored' : 'strict';
      currentPaths = null;
      currentCells = sampled.mask;
      const fillv = sampled.anim ? 1.0 : (sampled.fill != null ? sampled.fill : STRICT_FILL);
      target = Math.round(sampled.mask.length * fillv);
    } else {
      return;
    }
    target = Math.min(MAX_CHARS, target);
    adaptCharCount(target, currentCells);
    formCurrent();
    console.log(`Shape → ${label} (${currentConstraint}, ${currentCells.length} cells, ${aliveIds().length}里字)`);
  }

  function applyShape(index) {
    shapeIndex = ((index % SHAPES.length) + SHAPES.length) % SHAPES.length;
    const def = SHAPES[shapeIndex];
    if (def.clock) { applyClock(); return; }
    formSampled(def.make(def.cells), def.name);
  }

  // ── 北京时间（即时时分秒）──────────────────────────────────────────────
  // 每秒把 "HH:MM:SS" 当作横排巨字串重采样成掩码并满填流动；数字变化→里字滚动呈现。
  // 仅当掩码格数变化较大时才走螺旋增减，避免每秒抖动。
  function beijingTimeString() {
    const now = new Date();
    const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000); // UTC+8
    const p = x => String(x).padStart(2, '0');
    return `${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}`;
  }
  function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }
  function applyClock() {
    stopClock();
    shapeActive = true; inOrigin = false; currentAnim = null;
    let inited = false;
    const tick = () => {
      const [hh, mm, ss] = beijingTimeString().split(':');
      // 竖排 HH / MM / SS 三行大号数字（窄竖屏也清晰）；每秒重采样→秒数那行里字滚动重排。
      const sampled = shapes.sampleVerticalText([hh, mm, ss], gridCols, gridRows, MAX_CHARS);
      currentConstraint = 'strict'; currentPaths = null; currentCells = sampled.mask;
      if (!inited) { // 仅首次按目标增减里字（螺旋出入场）；之后只换掩码→数字平滑滚动、不每秒抖动
        adaptCharCount(Math.round(sampled.mask.length * sampled.fill), currentCells);
        inited = true;
      }
      motion.setFlowFill(currentCells, aliveIds());
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  // ── 动态曲线：底形（mask）+ 形状自身动态（ANIMS 显示层位移）──────────────────
  // 里字在底形里匀速走格（里字动态），叠加 ANIMS 的周期位移（形状自身动态）→ 优美变化曲线。
  const CC = () => CELL_SIZE;
  // 正弦波：中间横带（里字满填），整带按 gridX 相位大幅正弦起伏（波峰波谷大、视觉冲击）。
  function buildWaveCells() {
    const cells = [], midY = Math.floor(gridRows / 2), m = 2;
    for (let x = m; x < gridCols - m; x++) for (let dy = -1; dy <= 1; dy++) cells.push({ x, y: midY + dy });
    return cells;
  }
  // 水波：多条横线（行距 5）满宽，每行相位错开 → 一片行进的波纹。
  function buildRippleCells() {
    const cells = [], m = 2;
    for (let y = 5; y < gridRows - 4; y += 5) for (let x = m; x < gridCols - m; x++) cells.push({ x, y });
    return cells;
  }
  // DNA：中央竖带（3 列满高），里字按奇偶分两股、左右反相摆动 → 竖向双螺旋交织摇摆。
  function buildDnaCells() {
    const cells = [], cx = Math.floor(gridCols / 2), m = 3;
    for (let y = m; y < gridRows - m; y++) for (let dx = -1; dx <= 1; dx++) cells.push({ x: cx + dx, y });
    return cells;
  }
  // 涟漪：实心圆盘，按到圆心的半径做向外扩散的正弦脉动 → 一圈圈水波涟漪。
  function buildDiskCells() {
    const cells = [], cx = (gridCols - 1) / 2, cy = (gridRows - 1) / 2, R = Math.min(gridCols, gridRows) * 0.32;
    const rin = 2.2; // 中心留小孔：旋涡/脉动在圆心处会把里字挤到一起，挖空圆心 → 不重叠
    for (let y = 0; y < gridRows; y++) for (let x = 0; x < gridCols; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= R * R && d2 >= rin * rin) cells.push({ x, y });
    }
    return cells;
  }

  // 绸缎：居中实心方块（一片"布"），整片做二维行波起伏。
  function buildBlockCells() {
    const cells = [], w = Math.min(gridCols - 6, 16), h = Math.min(gridRows - 14, 18);
    const x0 = Math.floor((gridCols - w) / 2), y0 = Math.floor((gridRows - h) / 2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push({ x: x0 + x, y: y0 + y });
    return cells;
  }
  // 脉动花：四叶玫瑰细轮廓（旋转 + 缩放绽放）。
  function buildRoseCells() {
    const cells = [], seen = new Set();
    const cx = (gridCols - 1) / 2, cy = (gridRows - 1) / 2, scale = Math.min(gridCols, gridRows) * 0.44;
    for (let th = 0; th < Math.PI * 2; th += 0.008) {
      const r = Math.cos(2 * th) * scale;
      const x = Math.round(cx + r * Math.cos(th)), y = Math.round(cy + r * Math.sin(th));
      if (x < 0 || y < 0 || x >= gridCols || y >= gridRows) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 < 3 * 3) continue; // 四瓣在圆心交汇 → 挖空中心避免拥挤
      const k = y * gridCols + x; if (seen.has(k)) continue; seen.add(k); cells.push({ x, y });
    }
    return cells;
  }

  // 形状自身动态：直接改 displayX/Y（在 motion 设好显示位之后叠加）。t = 秒。
  const cen = () => ({ cx: (gridCols - 1) / 2 * CC(), cy: (gridRows - 1) / 2 * CC() });
  const ANIMS = {
    wave:   (c, t) => { c.displayY += Math.sin(c.gridX * 0.36 + t * 1.9) * CC() * 4.2; },
    ripple: (c, t) => { c.displayY += Math.sin(c.gridX * 0.5 - t * 2.3 + c.gridY * 0.55) * CC() * 1.7; },
    dna:    (c, t) => {
      const cx = Math.floor(gridCols / 2) * CC();
      const strand = (c.id % 2) ? Math.PI : 0;
      c.displayX = cx + Math.sin(c.gridY * 0.5 + t * 1.9 + strand) * CC() * 6.0
                 + Math.sin(t * 0.6) * CC() * 1.2; // 整体轻微摇摆
    },
    pulse:  (c, t) => {
      const { cx, cy } = cen();
      const bx = c.gridX * CC() - cx, by = c.gridY * CC() - cy;
      const rad = Math.hypot(bx, by) || 1;
      const off = Math.sin(rad * 0.10 - t * 3.0) * CC() * 1.9; // 向外扩散的脉动
      c.displayX += (bx / rad) * off; c.displayY += (by / rad) * off;
    },
    // 旋涡：绕中心差速旋转（内圈快、外圈慢）→ 漩涡卷动。
    vortex: (c, t) => {
      const { cx, cy } = cen();
      const bx = c.gridX * CC() - cx, by = c.gridY * CC() - cy;
      const rad = Math.hypot(bx, by);
      const a = Math.atan2(by, bx) + t * 1.0 + (60 - rad) * 0.012;
      c.displayX = cx + rad * Math.cos(a); c.displayY = cy + rad * Math.sin(a);
    },
    // 绸缎：二维行波（横纵两个正弦叠加）→ 像一片随风起伏的布。
    cloth: (c, t) => {
      c.displayY += Math.sin(c.gridX * 0.5 + t * 2.0) * CC() * 1.7
                  + Math.cos(c.gridY * 0.45 + t * 1.5) * CC() * 1.3;
    },
    // 脉动花：整朵旋转 + 半径周期缩放 → 一开一合的绽放。
    bloom: (c, t) => {
      const { cx, cy } = cen();
      const bx = c.gridX * CC() - cx, by = c.gridY * CC() - cy;
      const rad = Math.hypot(bx, by);
      const s = 1 + 0.24 * Math.sin(t * 1.8), a = Math.atan2(by, bx) + t * 0.5;
      c.displayX = cx + rad * s * Math.cos(a); c.displayY = cy + rad * s * Math.sin(a);
    },
  };

  // 调试入口：即时呈现任意巨字(串)/指定颜文字/指定曲线（接入云端 AI 后即用这些）。
  function applyMegachar(text) {
    if (!text) return;
    formSampled(shapes.sampleMegachar(text, gridCols, gridRows, MAX_CHARS), '巨字 ' + text);
  }
  function applyEmojiKey(key) {
    formSampled(shapes.sampleEmoji(key, gridCols, gridRows, 150), key);
  }
  function applyCurve(type) {
    formSampled(shapes.sampleCurveOrdered(type, gridCols, gridRows, 110), type);
  }

  function releaseShape() {
    shapeActive = false;
    inOrigin = false;
    currentAnim = null;
    stopClock();
    currentPaths = null;
    currentCells = [];
    motion.releaseShape();
    console.log('Shape released → free wander');
  }

  // ── 原态（文本行）↔ 动态（形状）────────────────────────────────────────
  // 原态 = 把现有里字按"正常文本行"居中排版钉住静止（带极轻微浮动增加生命感，收束 L28）。
  // 里字内容不变（动态里的里字本就来自原态文本）；动态↔原态都靠 PIBT 沿格子滑动，匀速美观
  // （华容道式，收束 L4/L29）。长按动态→原态；原态里点/双击/拖动→回到动态形状。

  // 为 n 个里字生成居中文本行格子（每行居中、行距 2 格→像段落；过高则压缩行距/加宽）。
  function buildTextLineCells(n) {
    const maxCols = Math.max(6, gridCols - 2);
    let perRow = Math.min(maxCols, Math.max(8, Math.round(Math.sqrt(n) * 1.7)));
    let rowsN = Math.ceil(n / perRow);
    let lineGap = 2;
    while (rowsN * lineGap > gridRows - 2 && lineGap > 1) lineGap = 1;
    while (rowsN * lineGap > gridRows - 2 && perRow < maxCols) { perRow++; rowsN = Math.ceil(n / perRow); }
    const blockH = (rowsN - 1) * lineGap + 1;
    const startRow = Math.max(1, Math.floor((gridRows - blockH) / 2));
    const cells = [];
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / perRow);
      const rowCount = (r === rowsN - 1) ? (n - r * perRow) : perRow; // 该行字数（末行可能不满）
      const rowStart = Math.max(0, Math.floor((gridCols - rowCount) / 2));
      const c = i - r * perRow;
      cells.push({ x: rowStart + c, y: startRow + r * lineGap });
    }
    return cells;
  }

  // 把在册里字钉成居中文本行：按阅读序(y,x)就近配对 → 整体平移/交叉最少（华容道滑入）。
  // setContent=true 时按 lastOriginText 的字序给每个里字赋内容 → 文本按"原本顺序"呈现。
  function layoutOrigin(setContent) {
    const alive = aliveChars();
    if (alive.length === 0) return;
    const cells = buildTextLineCells(alive.length);  // 阅读序：左→右、上→下
    currentConstraint = 'origin'; currentPaths = null; currentCells = cells;
    const S = alive.slice().sort((a, b) => (a.gridY - b.gridY) || (a.gridX - b.gridX)); // 空间序
    const content = (setContent && lastOriginText)
      ? [...String(lastOriginText)].filter(ch => ch.trim().length > 0) : null;
    // S[k] ↔ cells[k]（两者都是同序的第 k 个）→ 滑动最短；内容按阅读序 content[k] 落到 cells[k]。
    if (content) for (let k = 0; k < S.length; k++) S[k].char = content[k % content.length];
    motion.setTextLine(cells, S.map(c => c.id));
  }

  // 动态 → 原态：回归文本行。若设过原态文本，按其"原本内容/长度"还原 —— 即去掉动态自适应
  // 多出来的里字（螺旋淡出）、补回缺的，呈现原本那段话，而不是把多出的字也塞进文本行。
  function enterOrigin() {
    if (inOrigin) return;
    if (aliveIds().length === 0) return;
    if (lastOriginText) { formOriginText(lastOriginText); return; }
    stopClock(); currentAnim = null;
    clearTimeout(scatterTimer);
    if (motion.isOrbiting()) motion.endOrbit();
    inOrigin = true; shapeActive = false;
    layoutOrigin(false);
    console.log(`→ 原态文本行 (${aliveIds().length} 里字)`);
  }

  // 原态字数自适应（不抬到 MIN_CHARS）：用螺旋出入场增减里字，finalize 进文本格。
  function adaptOriginCount(target, cells) {
    target = Math.min(MAX_CHARS, Math.max(1, target));
    const diff = target - aliveChars().length;
    if (diff > 0) spawnSpiralIn(diff, cells);
    else if (diff < 0) despawnSpiralOut(-diff, cells);
  }

  // 原态内容/长度自适应（后续由 AI 回答驱动）：里字数按 text 字数螺旋增/减（出入场如螺旋线、
  // 不瞬变），内容/顺序按 text 还原，钉成居中文本行。螺旋批次结束后再 reapply 一次含新字。
  function formOriginText(text) {
    const content = [...String(text)].filter(ch => ch.trim().length > 0);
    const n = content.length;
    if (n === 0) return;
    lastOriginText = text;
    stopClock(); currentAnim = null;
    clearTimeout(scatterTimer);
    if (motion.isOrbiting()) motion.endOrbit();
    inOrigin = true; shapeActive = false;
    const cells = buildTextLineCells(n);
    currentConstraint = 'origin'; currentPaths = null; currentCells = cells;
    adaptOriginCount(n, cells);   // 螺旋增减到 n（出入场动画）
    layoutOrigin(true);           // 现有里字即刻按内容/顺序滑向文本位；新字落位后由 reform 再排
    reformPending = true;
    console.log(`→ 原态文本「${text}」(${n} 字)`);
  }

  // 原态 → 动态：回到形状（advance=true 则切下一个）。里字从文本行沿格子滑进字形。
  function enterShape(advance) {
    inOrigin = false;
    applyShape(advance ? shapeIndex + 1 : shapeIndex);
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

  // 初次进入先呈现原态文本行（收束 L5；内容/长度自适应，后续由 AI 回答驱动）。
  setTimeout(() => formOriginText('今天已完成三件事还有两项待办慢慢来继续加油'), 800);

  // ── 调试面板（网页快捷查验：任意巨字 / 全部颜文字 / 曲线）─────────────────
  // 接入云端 AI 后即用 applyMegachar/applyEmojiKey 这些入口即时呈现任意字。
  buildDebugPanel();
  function buildDebugPanel() {
    const overlay = document.getElementById('ui-overlay');
    if (!overlay) return;
    const stop = e => e.stopPropagation();
    const mkBtn = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:5px 8px;background:#22304d;color:#eaeaea;border:1px solid #3c4f76;'
        + 'border-radius:6px;font-size:13px;line-height:1;cursor:pointer;';
      b.addEventListener('pointerdown', stop);
      b.addEventListener('click', e => { stop(e); fn(); });
      return b;
    };
    const row = () => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;';
      return r;
    };

    const body = document.createElement('div');
    body.style.cssText = 'position:absolute;left:6px;right:6px;bottom:6px;display:none;'
      + 'flex-direction:column;gap:5px;padding:7px;background:rgba(8,10,16,0.72);'
      + 'border-radius:10px;max-height:48%;overflow:auto;backdrop-filter:blur(2px);';
    body.addEventListener('pointerdown', stop);

    // 任意巨字
    const r1 = row();
    const input = document.createElement('input');
    input.type = 'text'; input.value = '永'; input.maxLength = 6;
    input.style.cssText = 'width:84px;padding:5px;border-radius:6px;border:1px solid #3c4f76;'
      + 'background:#0d1320;color:#fff;font-size:14px;';
    input.addEventListener('pointerdown', stop);
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') applyMegachar(input.value.trim()); });
    r1.append(makeLabel('巨字'), input, mkBtn('呈现', () => applyMegachar(input.value.trim())));
    for (const ch of ['春', '心', '爱', '福', '龙']) r1.append(mkBtn(ch, () => applyMegachar(ch)));

    // 全部颜文字
    const r2 = row(); r2.append(makeLabel('颜文字'));
    for (const key of Object.keys(EMOJI_TEMPLATES)) r2.append(mkBtn(key, () => applyEmojiKey(key)));

    // 曲线
    const r3 = row(); r3.append(makeLabel('曲线'));
    const curves = [['心', 'heart'], ['四叶花', 'rose'], ['圆', 'circle'], ['无穷', 'lemniscate'], ['五角星', 'star'], ['风车', 'pinwheel']];
    for (const [label, type] of curves) r3.append(mkBtn(label, () => applyCurve(type)));

    // 动态曲线（形状自身动态）
    const r6 = row(); r6.append(makeLabel('动态曲线'));
    const anims = [['正弦波', 'wave', buildWaveCells], ['水波', 'ripple', buildRippleCells],
                   ['DNA双螺旋', 'dna', buildDnaCells], ['涟漪', 'pulse', buildDiskCells],
                   ['旋涡', 'vortex', buildDiskCells], ['绸缎', 'cloth', buildBlockCells],
                   ['脉动花', 'bloom', buildRoseCells]];
    for (const [label, anim, build] of anims)
      r6.append(mkBtn(label, () => formSampled({ mask: build(), anim }, label)));

    // 原态文本（内容/长度自适应，模拟 AI 回答）
    const r5 = row(); r5.append(makeLabel('原态'));
    const tin = document.createElement('input');
    tin.type = 'text'; tin.value = '今天完成得不错继续加油'; tin.maxLength = 60;
    tin.style.cssText = 'width:150px;padding:5px;border-radius:6px;border:1px solid #3c4f76;'
      + 'background:#0d1320;color:#fff;font-size:14px;';
    tin.addEventListener('pointerdown', stop);
    tin.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') formOriginText(tin.value); });
    r5.append(tin, mkBtn('呈现原态', () => formOriginText(tin.value)));

    // 杂项
    const r4 = row();
    r4.append(mkBtn('北京时间', () => applyClock()));
    r4.append(mkBtn('下一个形状', () => applyShape(shapeIndex + 1)));
    r4.append(mkBtn('回归原态', () => enterOrigin()));
    r4.append(mkBtn('自由漫游', () => releaseShape()));

    body.append(r1, r2, r3, r6, r5, r4);

    const toggle = mkBtn('调试 ⚙', () => {
      body.style.display = body.style.display === 'none' ? 'flex' : 'none';
    });
    toggle.style.position = 'absolute';
    toggle.style.right = '6px';
    toggle.style.top = '6px';
    toggle.style.opacity = '0.8';

    overlay.append(toggle, body);

    function makeLabel(t) {
      const s = document.createElement('span');
      s.textContent = t;
      s.style.cssText = 'color:#8fa8d6;font-size:12px;margin-right:2px;';
      return s;
    }
  }

  // ── Drag state ────────────────────────────────────────────
  let dragging = false;
  let dragEnd = null;        // last finger cell (reform spot on release)
  let orbitFinger = { x: 0, y: 0 }; // finger pixel pos driving the orbit
  let scatterTimer = null;
  let microEnv = 0;          // 微动脉冲包络（点击触发→衰减）

  const triggerMicro = () => { microEnv = 1; }; // 点击反应：全体来一次轻摆

  const gestures = new GestureRecognizer(renderer.canvas, CELL_SIZE, {
    onTap(col, row) {
      if (inOrigin) { triggerMicro(); enterShape(false); return; } // 原态→动态
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
      if (inOrigin) { enterShape(false); return; } // 原态→动态（回到当前形状）
      applyShape(shapeIndex + 1);                   // 动态→切下一个形状
    },

    onLongPress() {
      // 长按：动态→回归原态文本行。阈值 650ms + 任意 >8px 移动即转为拖动 → 拖着玩不会误触。
      if (inOrigin) return;
      enterOrigin();
    },

    // 拖动（收束 L30）：里字聚成方形，按同心方环逐层旋转、越拖越快；中心=手指、
    // 整块跟手平移；松手在落点还原之前的形状。由显示层驱动（见渲染循环）。
    onDragStart(col, row, px, py) {
      if (inOrigin) enterShape(false); // 原态→动态，随即跟手环绕
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
      if (inOrigin) {
        // 原态浮动用"全体同一偏移"（呼吸般整体轻摆）→ 每行里字始终对齐、不再参差不齐，
        // 又有生命感（收束 L28）。新生里字(AI 新文本)淡入。
        const t = now / 1000;
        const ox = Math.sin(t * 0.9) * 1.0;
        const oy = Math.sin(t * 0.7 + 1.2) * 1.3;
        for (const c of aliveChars()) {
          c.displayX += ox; c.displayY += oy;
          if (c.alpha < 1) c.alpha = Math.min(1, c.alpha + dtMs / 320);
        }
      }
      if (currentAnim) {
        // 进阶·形状自身动态：里字在底形里匀速走格(里字动态)，叠加周期位移(形状自身动态)。
        const t = now / 1000;
        for (const c of aliveChars()) currentAnim(c, t);
      }
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
    // 动态由满填循环流动提供（里字逐格流动 + tick 间插值），无需常驻颤动。
    // 渲染用**预渲染字形位图 + drawImage**（而非每帧数百次 fillText）→ 大幅降帧耗、消除卡顿。
    const tSec = now / 1000;
    const amp = motion.isOrbiting() ? 0 : microEnv * MICRO_AMP;
    for (const char of pool.getAll()) {
      // 流动淡入/淡出（开放笔画首端淡入、尾端淡出）与螺旋淡入淡出 alpha 相乘。
      const eff = char.alpha * (char.flowFade != null ? char.flowFade : 1);
      if (eff > 0.01) {
        const mx = amp ? Math.sin(tSec * 9 + char.id * 1.3) * amp : 0;
        const my = amp ? Math.cos(tSec * 9 + char.id * 2.1) * amp : 0;
        ctx.globalAlpha = eff;
        ctx.drawImage(getGlyph(char.char),
          char.displayX + mx, char.displayY + my, CELL_SIZE, CELL_SIZE);
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
