import assert from 'node:assert/strict';

import { Grid } from '../js/core/grid.js';
import { CharacterPool } from '../js/core/character.js';
import { MotionEngine } from '../js/core/motion.js';
import { GestureRecognizer } from '../js/input/gestures.js';
import { ShapeSystem } from '../js/core/shape.js';

class FakeCanvas {
  constructor() {
    this.width = 390;
    this.height = 700;
    this.listeners = new Map();
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 390, height: 700 };
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  fire(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function testDoubleTapUsesGridCoordinates() {
  globalThis.devicePixelRatio = 1;

  const canvas = new FakeCanvas();
  const events = [];
  new GestureRecognizer(canvas, 16, {
    onTap: (col, row) => events.push(['tap', col, row]),
    onDoubleTap: (col, row) => events.push(['double', col, row]),
  });

  canvas.fire('mousedown', { clientX: 32, clientY: 32 });
  canvas.fire('mouseup');
  await wait(100);
  canvas.fire('mousedown', { clientX: 32, clientY: 32 });
  canvas.fire('mouseup');
  await wait(350);

  // 即时点击：首下抬手立刻触发 tap；第二下触发 double（不再重复 tap）。
  assert.deepEqual(events, [['tap', 2, 2], ['double', 2, 2]]);
}

async function testSingleTapFiresImmediately() {
  globalThis.devicePixelRatio = 1;
  const canvas = new FakeCanvas();
  const events = [];
  new GestureRecognizer(canvas, 16, {
    onTap: (col, row) => events.push(['tap', col, row]),
    onDoubleTap: () => events.push(['double']),
  });

  canvas.fire('mousedown', { clientX: 32, clientY: 48 });
  canvas.fire('mouseup');
  // No wait — tap should already have fired synchronously on mouseup.
  assert.deepEqual(events, [['tap', 2, 3]]);
}

function createMotionWithOneChar(x = 10, y = 10) {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(4);
  const motion = new MotionEngine(grid, 16, 0);
  const char = pool.acquire('字', x, y);
  motion.registerCharacter(char);
  return { grid, pool, motion, char };
}

function testScatterDoesNotTeleportGridPosition() {
  const { motion, char } = createMotionWithOneChar();
  const startX = char.gridX;
  const startY = char.gridY;

  motion.scatter(char.id, startX, startY);

  assert.equal(char.gridX, startX);
  assert.equal(char.gridY, startY);
}

function testShapeDragPreservesAndOffsetsMask() {
  const { motion, char } = createMotionWithOneChar(5, 5);
  const mask = [
    { x: 5, y: 5 },
    { x: 6, y: 5 },
    { x: 7, y: 5 },
  ];

  assert.equal(typeof motion.beginShapeDrag, 'function');
  assert.equal(typeof motion.previewShapeDrag, 'function');

  motion.setShapeMask(mask, [char.id]);
  motion.beginShapeDrag();
  motion.previewShapeDrag(2, 1);

  assert.deepEqual(motion.shapeMask, [
    { x: 7, y: 6 },
    { x: 8, y: 6 },
    { x: 9, y: 6 },
  ]);
}

function testBiasedPickHandlesSmallCandidateSets() {
  const { motion, char } = createMotionWithOneChar(5, 5);
  motion.dragBias = { dx: 1, dy: 0, strength: 1 };

  const pick = motion._pickBiased([{ x: 6, y: 5 }], char);

  assert.deepEqual(pick, { x: 6, y: 5 });
}

function testShapeConstrainedCharCanEnterMaskFromOutside() {
  const { motion, char } = createMotionWithOneChar(1, 1);
  const mask = [
    { x: 5, y: 1 },
    { x: 6, y: 1 },
  ];

  motion.setShapeMask(mask, [char.id]);
  motion.setTarget(char.id, 5, 1);
  motion.update(200);

  assert.equal(char.gridX, 2);
  assert.equal(char.gridY, 1);
}

function testSetShapeMaskAssignsAllShapeParticipants() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(4);
  const motion = new MotionEngine(grid, 16, 0);
  const chars = [
    pool.acquire('一', 1, 1),
    pool.acquire('二', 1, 2),
    pool.acquire('三', 1, 3),
  ];
  for (const char of chars) motion.registerCharacter(char);
  motion._wanderTargets.clear();

  motion.setShapeMask([
    { x: 5, y: 5 },
    { x: 6, y: 5 },
    { x: 7, y: 5 },
    { x: 8, y: 5 },
  ], chars.map(char => char.id));

  assert.equal(motion._shapeChars.size, 3);
  for (const char of chars) {
    const target = motion._wanderTargets.get(char.id);
    assert.equal(typeof target?.tx, 'number');
    assert.equal(typeof target?.ty, 'number');
  }
}

function testShapeWanderTargetPrefersBroadMovement() {
  const { motion, char } = createMotionWithOneChar(10, 10);
  const mask = [];
  for (let y = 8; y < 15; y++) {
    for (let x = 5; x < 19; x++) {
      mask.push({ x, y });
    }
  }

  motion.setShapeMask(mask, [char.id]);
  motion._wanderTargets.delete(char.id);
  motion._assignWanderTarget(char);

  const target = motion._wanderTargets.get(char.id);
  const dist = Math.abs(target.tx - char.gridX) + Math.abs(target.ty - char.gridY);
  assert.ok(dist >= 5, `expected broad movement target, got distance ${dist}`);
}

function testShapeTargetRefreshesBeforeLocalBounce() {
  const { motion, char } = createMotionWithOneChar(10, 10);
  const mask = [];
  for (let y = 7; y < 17; y++) {
    for (let x = 3; x < 21; x++) {
      mask.push({ x, y });
    }
  }

  motion.setShapeMask(mask, [char.id]);
  motion.setTarget(char.id, 11, 10);
  motion.update(200);

  const target = motion._wanderTargets.get(char.id);
  const dist = Math.abs(target.tx - char.gridX) + Math.abs(target.ty - char.gridY);
  assert.ok(dist >= 5, `expected refreshed broad target, got distance ${dist}`);
}

function testPibtCanPushOccupiedNeighborForward() {
  const grid = new Grid(8, 4);
  const pool = new CharacterPool(4);
  const motion = new MotionEngine(grid, 16, 0);
  const a = pool.acquire('甲', 1, 1);
  const b = pool.acquire('乙', 2, 1);
  motion.registerCharacter(a);
  motion.registerCharacter(b);
  motion.setTarget(a.id, 3, 1);
  motion.setTarget(b.id, 3, 1);

  motion.update(200);

  assert.deepEqual(
    new Set([`${a.gridX},${a.gridY}`, `${b.gridX},${b.gridY}`]),
    new Set(['2,1', '3,1'])
  );
}

function testShapeMotionAllowsSafeConvoyThroughVacatedCells() {
  const grid = new Grid(8, 4);
  const pool = new CharacterPool(4);
  const motion = new MotionEngine(grid, 16, 0);
  const a = pool.acquire('甲', 1, 1);
  const b = pool.acquire('乙', 2, 1);
  motion.registerCharacter(a);
  motion.registerCharacter(b);
  motion.setShapeMask([
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 4, y: 1 },
  ], [a.id, b.id]);
  motion.setTarget(a.id, 4, 1);
  motion.setTarget(b.id, 4, 1);

  motion.update(200);

  assert.deepEqual(
    new Set([`${a.gridX},${a.gridY}`, `${b.gridX},${b.gridY}`]),
    new Set(['2,1', '3,1'])
  );
}

function testDisplayRigidBodySeparatesPerpendicularPassThrough() {
  const grid = new Grid(8, 4);
  const pool = new CharacterPool(4);
  const motion = new MotionEngine(grid, 16, 0);
  const a = pool.acquire('甲', 1, 1);
  const b = pool.acquire('乙', 2, 1);
  motion.registerCharacter(a);
  motion.registerCharacter(b);
  motion.setShapeMask([
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
  ], [a.id, b.id]);
  motion.setTarget(a.id, 2, 1);
  motion.setTarget(b.id, 2, 2);

  motion.update(200);
  motion.updateDisplayPositions(0.5);

  const ax = a.displayX + 8;
  const ay = a.displayY + 8;
  const bx = b.displayX + 8;
  const by = b.displayY + 8;
  assert.ok(Math.hypot(ax - bx, ay - by) >= 14.3);
}

function testNarrowShapeMotionStaysFluidWithoutConflicts() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  const chars = [];
  for (let i = 0; i < 60; i++) {
    const char = pool.acquire('字', 2 + (i % 20), 2 + Math.floor(i / 20));
    chars.push(char);
    motion.registerCharacter(char);
  }

  const mask = [];
  for (let y = 8; y < 15; y++) {
    for (let x = 5; x < 19; x++) mask.push({ x, y });
  }
  motion.setShapeMask(mask, chars.map(char => char.id));

  const moves = new Map(chars.map(char => [char.id, 0]));
  for (let tick = 0; tick < 300; tick++) {
    const before = new Map(chars.map(char => [char.id, `${char.gridX},${char.gridY}`]));
    motion.update(200);

    const occupied = new Set();
    const edges = new Set();
    for (const char of chars) {
      const from = before.get(char.id);
      const to = `${char.gridX},${char.gridY}`;
      assert.equal(occupied.has(to), false, `duplicate cell ${to} at tick ${tick}`);
      occupied.add(to);
      assert.equal(grid.getCharId(char.gridX, char.gridY), char.id, `grid desync for char ${char.id} at tick ${tick}`);

      if (from !== to) {
        moves.set(char.id, moves.get(char.id) + 1);
        const edge = [from, to].sort().join('<->');
        assert.equal(edges.has(edge), false, `edge conflict ${edge} at tick ${tick}`);
        edges.add(edge);
      }
    }
  }

  const vals = [...moves.values()].sort((a, b) => a - b);
  assert.ok(vals[0] >= 220, `expected narrow shape to stay fluid, min moves ${vals[0]}`);
}

function testDisplayInterpolationUsesTickProgress() {
  const { motion, char } = createMotionWithOneChar(5, 5);

  motion.setTarget(char.id, 6, 5);
  motion.update(200);
  motion.updateDisplayPositions(0.5);

  assert.equal(char.displayX, 5.5 * 16);
  assert.equal(char.displayY, 5 * 16);
}

function testStationaryCharactersRenderFromCurrentCell() {
  const grid = new Grid(1, 1);
  const pool = new CharacterPool(1);
  const motion = new MotionEngine(grid, 16, 0);
  const char = pool.acquire('字', 0, 0);
  motion.registerCharacter(char);

  char.prevGridX = 1;
  char.prevGridY = 0;
  motion.update(200);
  motion.updateDisplayPositions(0);

  assert.equal(char.displayX, 0);
  assert.equal(char.displayY, 0);
}

function testShapeDragClampsShiftWithoutCollapsingMask() {
  const { motion, char } = createMotionWithOneChar(5, 5);
  const mask = [
    { x: 20, y: 5 },
    { x: 21, y: 5 },
    { x: 22, y: 5 },
    { x: 23, y: 5 },
  ];

  motion.setShapeMask(mask, [char.id]);
  motion.beginShapeDrag();
  motion.previewShapeDrag(10, 0);

  assert.deepEqual(motion.shapeMask, mask);
}

function testShapeDragUsesBroadTargetsInsteadOfNearestLock() {
  const { motion, char } = createMotionWithOneChar(10, 10);
  const mask = [];
  for (let y = 8; y < 15; y++) {
    for (let x = 5; x < 19; x++) mask.push({ x, y });
  }

  motion.setShapeMask(mask, [char.id]);
  motion.beginShapeDrag();
  motion.previewShapeDrag(2, 0);
  const target = motion._wanderTargets.get(char.id);
  const dist = Math.abs(target.tx - char.gridX) + Math.abs(target.ty - char.gridY);

  assert.ok(dist >= 5, `expected broad drag target, got distance ${dist}`);
}

function testShapeMotionNeverDuplicatesGridCellsOrDesyncsGrid() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  const chars = [];
  for (let i = 0; i < 60; i++) {
    const char = pool.acquire('字', 2 + (i % 20), 2 + Math.floor(i / 20));
    chars.push(char);
    motion.registerCharacter(char);
  }

  const mask = [];
  for (let y = 8; y < 15; y++) {
    for (let x = 5; x < 19; x++) mask.push({ x, y });
  }
  motion.setShapeMask(mask, chars.map(char => char.id));

  for (let tick = 0; tick < 300; tick++) {
    motion.update(200);
    const seen = new Set();
    for (const char of chars) {
      const key = `${char.gridX},${char.gridY}`;
      assert.equal(seen.has(key), false, `duplicate cell ${key} at tick ${tick}`);
      seen.add(key);
      assert.equal(grid.getCharId(char.gridX, char.gridY), char.id, `grid desync for char ${char.id} at tick ${tick}`);
    }
  }
}

function testDragRefreshesSomeShapeTargetsDuringMotion() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  const chars = [];
  for (let i = 0; i < 60; i++) {
    const char = pool.acquire('字', 2 + (i % 20), 2 + Math.floor(i / 20));
    chars.push(char);
    motion.registerCharacter(char);
  }

  const mask = [];
  for (let y = 8; y < 15; y++) {
    for (let x = 5; x < 19; x++) mask.push({ x, y });
  }
  motion.setShapeMask(mask, chars.map(char => char.id));
  for (let tick = 0; tick < 50; tick++) motion.update(200);

  motion.beginShapeDrag();
  motion.dragBias = { dx: 1, dy: 0, strength: 1 };
  motion.previewShapeDrag(3, 0);
  const before = new Map(chars.map(char => {
    const target = motion._wanderTargets.get(char.id);
    return [char.id, `${target?.tx},${target?.ty}`];
  }));

  for (let tick = 0; tick < 20; tick++) motion.update(200);

  let changed = 0;
  for (const char of chars) {
    const target = motion._wanderTargets.get(char.id);
    if (before.get(char.id) !== `${target?.tx},${target?.ty}`) changed++;
  }
  assert.ok(changed >= 8, `expected drag to refresh internal targets, got ${changed}`);
}

function buildStrictShapeWithSlack(charCount = 60) {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  const chars = [];
  for (let i = 0; i < charCount; i++) {
    const char = pool.acquire('字', 2 + (i % 20), 2 + Math.floor(i / 20));
    chars.push(char);
    motion.registerCharacter(char);
  }
  // 80-cell mask for 60 chars → 20 empty cells of华容道 slack.
  const mask = [];
  for (let y = 10; y < 18; y++) {
    for (let x = 6; x < 16; x++) mask.push({ x, y });
  }
  motion.setShapeMask(mask, chars.map(c => c.id), 'strict');
  return { grid, pool, motion, chars, mask };
}

// Regression: strict (颜文字/巨字) 是动态呈现 —— 轮廓与字数固定，但里字在掩码内
// 持续华容道滑动（绝不静止），且始终留在掩码内、不重叠。
function testStrictShapeKeepsMovingAndHoldsForm() {
  const { motion, chars, mask } = buildStrictShapeWithSlack(); // 60 chars in 80-cell mask
  const maskSet = new Set(mask.map(m => `${m.x},${m.y}`));
  const moves = new Map(chars.map(c => [c.id, 0]));
  let leaked = 0;

  for (let tick = 0; tick < 300; tick++) {
    const before = new Map(chars.map(c => [c.id, `${c.gridX},${c.gridY}`]));
    motion.update(200);
    for (const c of chars) {
      if (before.get(c.id) !== `${c.gridX},${c.gridY}`) moves.set(c.id, moves.get(c.id) + 1);
      if (tick > 60 && !maskSet.has(`${c.gridX},${c.gridY}`)) leaked++;
    }
  }

  const vals = [...moves.values()].sort((a, b) => a - b);
  assert.ok(vals[0] >= 120, `strict里字 should keep sliding (dynamic), min moves ${vals[0]}`);
  assert.equal(leaked, 0, `strict里字 should stay within the shape outline, leaked ${leaked}`);
}

// Regression: dragging must feel responsive — the engine runs a faster (but
// still constant) tick while a drag is active, then eases back to idle speed
// as the post-release momentum decays.
function testDragRunsFasterTickThenEasesBack() {
  const { motion } = buildStrictShapeWithSlack();

  const idleTick = motion._effectiveTick();
  motion.beginShapeDrag();
  const dragTick = motion._effectiveTick();
  assert.ok(dragTick < idleTick, `drag tick (${dragTick}) should be faster than idle (${idleTick})`);

  motion.dragBias = { dx: 1, dy: 0, strength: 1 };
  motion.endShapeDrag();
  // Fully-charged momentum → still near drag speed, well below idle.
  const justReleased = motion._effectiveTick();
  assert.ok(justReleased < idleTick, `post-release tick (${justReleased}) should still be fast`);
  // Momentum spent → back to idle speed.
  motion.dragBias.strength = 0;
  assert.equal(motion._effectiveTick(), idleTick);
}

// Regression: a tap must actually scatter里字 — even inside a strict shape the
// tapped里字 should slide away (previously they froze in formation and clicks
// appeared dead).
function testScatterMovesCharacterOutOfStrictFormation() {
  const { motion, chars } = buildStrictShapeWithSlack();
  for (let tick = 0; tick < 40; tick++) motion.update(200); // let it form & settle

  const victim = chars[0];
  const startKey = `${victim.gridX},${victim.gridY}`;
  motion.scatter(victim.id, victim.gridX, victim.gridY);
  for (let tick = 0; tick < 12; tick++) motion.update(200);

  assert.notEqual(`${victim.gridX},${victim.gridY}`, startKey,
    'scattered里字 should slide away from its formation cell');
}

// Regression: 拖动时里字应沿各自路径翻涌（彼此相对运动），而非整体刚性平移。
function testDragProducesRelativeMotionNotRigidTranslation() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  const chars = [];
  for (let i = 0; i < 50; i++) {
    const c = pool.acquire('字', 2 + (i % 18), 2 + Math.floor(i / 18));
    chars.push(c);
    motion.registerCharacter(c);
  }
  const mask = [];
  for (let y = 10; y < 18; y++) for (let x = 6; x < 16; x++) mask.push({ x, y });
  motion.setShapeMask(mask, chars.map(c => c.id), 'loose');
  for (let t = 0; t < 40; t++) motion.update(200); // settle into shape

  const a = chars[0], b = chars[1];
  motion.beginShapeDrag();
  let relChanges = 0;
  let prevRel = `${a.gridX - b.gridX},${a.gridY - b.gridY}`;
  for (let t = 0; t < 30; t++) {
    motion.dragBias = { dx: 1, dy: 0, strength: 1 };
    motion.previewShapeDrag(Math.min(8, t), 0);
    motion.update(85);
    const rel = `${a.gridX - b.gridX},${a.gridY - b.gridY}`;
    if (rel !== prevRel) { relChanges++; prevRel = rel; }
  }
  assert.ok(relChanges >= 5,
    `drag should give里字 individual paths (relative motion), changes=${relChanges}`);
}

// Regression: 字数自适应 —— 运行中增删里字后，PIBT 仍保持无重叠、网格不脱同步。
function testDynamicCharacterCountStaysCollisionFreeAndInSync() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  for (let i = 0; i < 56; i++) {
    const c = pool.acquire('字', 2 + (i % 18), 2 + Math.floor(i / 18));
    motion.registerCharacter(c);
  }
  const assertConsistent = label => {
    const seen = new Set();
    for (const c of pool.getAll()) {
      const k = `${c.gridX},${c.gridY}`;
      assert.equal(seen.has(k), false, `duplicate cell ${k} (${label})`);
      seen.add(k);
      assert.equal(grid.getCharId(c.gridX, c.gridY), c.id, `grid desync ${c.id} (${label})`);
    }
  };

  const spawnEdge = () => {
    for (let x = 0; x < grid.cols; x++) {
      for (const y of [0, grid.rows - 1]) {
        if (!grid.isOccupied(x, y)) {
          const c = pool.acquire('新', x, y);
          motion.registerCharacter(c);
          return c;
        }
      }
    }
    return null;
  };

  for (let t = 0; t < 20; t++) motion.update(200);
  assertConsistent('settle');
  for (let k = 0; k < 12; k++) spawnEdge();
  for (let t = 0; t < 20; t++) motion.update(200);
  assert.equal(pool.count(), 68);
  assertConsistent('after grow');
  for (const c of pool.getAll().slice(0, 12)) {
    motion.unregisterCharacter(c.id);
    pool.release(c.id);
  }
  for (let t = 0; t < 20; t++) motion.update(200);
  assert.equal(pool.count(), 56);
  assertConsistent('after shrink');
}

// Regression: FPS 均匀采样要均匀覆盖字形，且保留"嘴"这类孤立细笔画（辨形），
// 旧的一维等距抽稀会几乎把这类稀疏特征抽空。
function testUniformSamplingKeepsSparseFeaturesAndSpread() {
  const shapes = new ShapeSystem();
  const cells = [];
  for (let y = 0; y < 14; y++) for (let x = 0; x < 30; x++) cells.push({ x, y }); // 眼/脸大块
  for (let x = 8; x < 22; x++) cells.push({ x, y: 22 });                          // 孤立"嘴"带
  const K = 60;
  const out = shapes._sparsify(cells, K);

  assert.equal(out.length, K, 'should thin to exactly K cells');
  const keys = new Set(out.map(c => `${c.x},${c.y}`));
  assert.equal(keys.size, K, 'no duplicate cells');
  const inputKeys = new Set(cells.map(c => `${c.x},${c.y}`));
  for (const c of out) assert.ok(inputKeys.has(`${c.x},${c.y}`), 'samples come from input');

  const mouth = out.filter(c => c.y === 22).length;
  assert.ok(mouth >= 3, `uniform sampling must keep the isolated mouth band, got ${mouth}`);

  // Average nearest-neighbour distance should beat naive 1-D equidistant thinning.
  const avgNN = pts => {
    let total = 0;
    for (const p of pts) {
      let best = Infinity;
      for (const q of pts) {
        if (p === q) continue;
        const d = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
        if (d < best) best = d;
      }
      total += best;
    }
    return total / pts.length;
  };
  const step = cells.length / K, naive = [];
  for (let i = 0; i < K; i++) naive.push(cells[Math.floor(i * step)]);
  assert.ok(avgNN(out) > avgNN(naive),
    `FPS spread (${avgNN(out).toFixed(2)}) should exceed 1-D (${avgNN(naive).toFixed(2)})`);
}

// Ordered 4-connected rectangle ring (clockwise) — a clean flow loop for tests.
function orderedRectRing(x0, y0, w, h) {
  const cells = [];
  for (let x = x0; x < x0 + w; x++) cells.push({ x, y: y0 });
  for (let y = y0 + 1; y < y0 + h; y++) cells.push({ x: x0 + w - 1, y });
  for (let x = x0 + w - 2; x >= x0; x--) cells.push({ x, y: y0 + h - 1 });
  for (let y = y0 + h - 2; y >= y0 + 1; y--) cells.push({ x: x0, y });
  return cells;
}

// Regression: flow（细轮廓/环绕）—— 里字沿有序环路流动，全员持续运动、几乎不
// 脱离轨道、无重叠脱同步。
function testFlowStreamsAlongPathStayingOnTrack() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  const ring = orderedRectRing(5, 8, 12, 10); // perimeter = 2*(12+10)-4 = 40 cells
  const chars = [];
  for (let i = 0; i < 30; i++) { // 30 chars on a 40-cell loop → 10 gaps to flow
    const c = pool.acquire('字', 2 + (i % 18), 2 + Math.floor(i / 18));
    chars.push(c);
    motion.registerCharacter(c);
  }
  motion.setFlowPath(ring, chars.map(c => c.id), true);
  const pathSet = new Set(ring.map(c => `${c.x},${c.y}`));
  const moves = new Map(chars.map(c => [c.id, 0]));
  let onPath = 0, samples = 0;

  for (let t = 0; t < 200; t++) {
    const before = new Map(chars.map(c => [c.id, `${c.gridX},${c.gridY}`]));
    motion.update(150);
    const seen = new Set();
    for (const c of chars) {
      const k = `${c.gridX},${c.gridY}`;
      assert.equal(seen.has(k), false, `flow duplicate ${k} at ${t}`);
      seen.add(k);
      assert.equal(grid.getCharId(c.gridX, c.gridY), c.id, `flow desync ${c.id} at ${t}`);
      if (before.get(c.id) !== k) moves.set(c.id, moves.get(c.id) + 1);
      if (t > 40) { samples++; if (pathSet.has(k)) onPath++; }
    }
  }
  const mv = [...moves.values()].sort((a, b) => a - b);
  assert.ok(mv[0] >= 20, `every里字 should keep flowing, min moves ${mv[0]}`);
  assert.ok(onPath / samples >= 0.95, `flow should stay on the outline, onPath ${(onPath / samples).toFixed(2)}`);
}

// Regression: 拖动环绕 —— beginOrbit 把里字收拢到手指周围环绕流动，moveOrbit
// 跟随手指；全员持续运动、无重叠脱同步。
function testOrbitClustersAroundFingerAndFollows() {
  const grid = new Grid(24, 43);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, 16, 0);
  const chars = [];
  for (let i = 0; i < 45; i++) {
    const c = pool.acquire('字', 2 + (i % 18), 2 + Math.floor(i / 18));
    chars.push(c);
    motion.registerCharacter(c);
  }
  // Pretend a shape is active so orbit uses these as its participants.
  motion.setShapeMask([{ x: 10, y: 10 }], chars.map(c => c.id), 'strict');

  let fx = 12, fy = 20;
  motion.beginOrbit(fx, fy);
  const moves = new Map(chars.map(c => [c.id, 0]));
  let near = 0, samples = 0;
  for (let t = 0; t < 120; t++) {
    if (t > 0 && t % 20 === 0) { fx = Math.min(20, fx + 2); motion.moveOrbit(fx, fy); }
    const before = new Map(chars.map(c => [c.id, `${c.gridX},${c.gridY}`]));
    motion.update(85);
    const seen = new Set();
    for (const c of chars) {
      const k = `${c.gridX},${c.gridY}`;
      assert.equal(seen.has(k), false, `orbit duplicate ${k} at ${t}`);
      seen.add(k);
      assert.equal(grid.getCharId(c.gridX, c.gridY), c.id, `orbit desync ${c.id} at ${t}`);
      if (before.get(c.id) !== k) moves.set(c.id, moves.get(c.id) + 1);
      if (t > 40) {
        samples++;
        const cheb = Math.max(Math.abs(c.gridX - fx), Math.abs(c.gridY - fy));
        if (cheb <= 6) near++;
      }
    }
  }
  const mv = [...moves.values()].sort((a, b) => a - b);
  assert.ok(mv[0] >= 30, `orbit should keep every里字 circulating, min moves ${mv[0]}`);
  assert.ok(near / samples >= 0.9, `orbit should keep里字 around the finger, near ${(near / samples).toFixed(2)}`);
}

await testDoubleTapUsesGridCoordinates();
await testSingleTapFiresImmediately();
testFlowStreamsAlongPathStayingOnTrack();
testOrbitClustersAroundFingerAndFollows();
testDragProducesRelativeMotionNotRigidTranslation();
testDynamicCharacterCountStaysCollisionFreeAndInSync();
testUniformSamplingKeepsSparseFeaturesAndSpread();
testStrictShapeKeepsMovingAndHoldsForm();
testDragRunsFasterTickThenEasesBack();
testScatterMovesCharacterOutOfStrictFormation();
testScatterDoesNotTeleportGridPosition();
testShapeDragPreservesAndOffsetsMask();
testBiasedPickHandlesSmallCandidateSets();
testShapeConstrainedCharCanEnterMaskFromOutside();
testSetShapeMaskAssignsAllShapeParticipants();
testShapeWanderTargetPrefersBroadMovement();
testShapeTargetRefreshesBeforeLocalBounce();
testPibtCanPushOccupiedNeighborForward();
testShapeMotionAllowsSafeConvoyThroughVacatedCells();
testDisplayRigidBodySeparatesPerpendicularPassThrough();
testNarrowShapeMotionStaysFluidWithoutConflicts();
testDisplayInterpolationUsesTickProgress();
testStationaryCharactersRenderFromCurrentCell();
testShapeDragClampsShiftWithoutCollapsingMask();
testShapeDragUsesBroadTargetsInsteadOfNearestLock();
testShapeMotionNeverDuplicatesGridCellsOrDesyncsGrid();
testDragRefreshesSomeShapeTargetsDuringMotion();

console.log('engine behavior tests passed');
