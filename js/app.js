/**
 * ZiLing main entry point.
 * Mobile WebView target: 390x700, 16px grid, PIBT cell-by-cell motion.
 */

import { Renderer } from './render/renderer.js';
import { Grid } from './core/grid.js';
import { CharacterPool } from './core/character.js';
import { MotionEngine } from './core/motion.js';
import { GestureRecognizer } from './input/gestures.js';

document.addEventListener('DOMContentLoaded', () => {
  const renderer = new Renderer('main-canvas');
  const { cssWidth, cssHeight } = renderer.init();

  const CELL_SIZE = 16;
  const FONT_SIZE = 13;
  const gridCols = Math.floor(cssWidth / CELL_SIZE);
  const gridRows = Math.floor(cssHeight / CELL_SIZE);
  const grid = new Grid(gridCols, gridRows);
  const pool = new CharacterPool(200);
  const motion = new MotionEngine(grid, CELL_SIZE, 0);

  const CHAR_POOL = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳'.split('');
  const CHAR_COUNT = 60;
  for (let i = 0; i < CHAR_COUNT; i++) {
    const col = 2 + (i % 20);
    const row = 2 + Math.floor(i / 20);
    const char = CHAR_POOL[i % CHAR_POOL.length];
    const c = pool.acquire(char, col, row);
    motion.registerCharacter(c);
  }
  console.log(`PIBT ready - Grid ${gridCols}x${gridRows}, ${CHAR_COUNT} characters`);

  // Dynamic shape test: all characters join the shape, with spare cells for motion.
  setTimeout(() => {
    const w = 14;
    const h = 7;
    const ox = 5;
    const oy = 8;
    const mask = [];
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        mask.push({ x, y });
      }
    }

    const allChars = pool.getAll();
    motion.setShapeMask(mask, allChars.map(char => char.id));
    allChars.forEach((char, i) => {
      const target = mask[Math.floor(i * mask.length / allChars.length)];
      motion.setTarget(char.id, target.x, target.y);
    });
    console.log(`Shape: ${w}x${h} rect, ${mask.length} cells, ${allChars.length} moving characters`);
  }, 3000);

  const DEBUG = new URLSearchParams(window.location.search).get('debug') === '1';
  let running = true;
  let lastTime = performance.now();
  const frameTimes = [];
  let lastFpsLog = performance.now();
  let lastCheckSecond = -1;
  let collisionOk = true;

  const gestures = new GestureRecognizer(
    renderer.canvas,
    CELL_SIZE,
    {
      onTap(col, row) {
        console.log(`Tap at (${col},${row})`);
        for (const char of pool.getAll()) {
          const dist = Math.abs(char.gridX - col) + Math.abs(char.gridY - row);
          if (dist <= 3) motion.scatter(char.id, col, row);
        }
      },
      onDoubleTap(col, row) {
        console.log(`Double-tap at (${col},${row})`);
      },
      onLongPress(col, row) {
        console.log(`Long-press at (${col},${row})`);
      },
      onDragStart(col, row) {
        gestures._dragging = true;
        gestures._dragFrom = { col, row };
        gestures._lastX = col;
        gestures._lastY = row;
        motion.beginShapeDrag();
        motion.dragBias = { dx: 0, dy: 0, strength: 0 };
      },
      onDragMove(col, row) {
        if (!gestures._dragging) return;
        const from = gestures._dragFrom;
        const ddx = col - from.col;
        const ddy = row - from.row;
        if (ddx === 0 && ddy === 0) return;

        const adx = Math.abs(ddx);
        const ady = Math.abs(ddy);
        motion.dragBias = {
          dx: adx >= ady ? Math.sign(ddx) : 0,
          dy: ady > adx ? Math.sign(ddy) : 0,
          strength: Math.min(1, Math.sqrt(ddx * ddx + ddy * ddy) / 4),
        };
        motion.previewShapeDrag(ddx, ddy);
        motion.tickDuration = Math.max(90, Math.min(200, Math.round(180 / Math.max(adx + ady, 1))));

        gestures._lastX = col;
        gestures._lastY = row;
      },
      onDragEnd() {
        motion.dragBias = null;
        motion.tickDuration = 200;
        motion.endShapeDrag();
        gestures._dragging = false;
        gestures._dragFrom = null;
      },
    }
  );

  function loop(now) {
    if (!running) {
      requestAnimationFrame(loop);
      return;
    }

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
      ctx.fillText(`FPS:${instantFps} FT:${avgFt.toFixed(1)}ms CH:${pool.count()} ${collisionOk ? 'OK' : '!!'}`, 4, 4);
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
    console.log('Collision check: OK');
    return true;
  }

  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) lastTime = performance.now();
  });

  document.fonts.ready.then(() => {
    requestAnimationFrame(loop);
  });
});
