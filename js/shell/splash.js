/**
 * 开屏动画：散落的千字文小字（与字灵的里字同源）从四方漂入，
 * 汇聚拼出「字灵」二字 → 朱砂小印「日程」落印 → 副题浮现 → 整体淡出进入 App。
 * 轻触可跳过；prefers-reduced-motion 时直接呈现静帧后快速结束。
 */

const POOL = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜'.split('');

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;

export function playSplash({ onDone }) {
  const wrap = document.getElementById('splash');
  const canvas = document.getElementById('splash-canvas');
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const css = getComputedStyle(document.documentElement);
  const COL = {
    paper: css.getPropertyValue('--paper').trim() || '#f6f2e9',
    ink: css.getPropertyValue('--ink').trim() || '#2b2722',
    ink3: css.getPropertyValue('--ink-3').trim() || '#a39a87',
    seal: css.getPropertyValue('--seal').trim() || '#b03a2e',
  };

  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = wrap.clientWidth, H = wrap.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  // ── 离屏采样「字灵」二字的落点 ──────────────────────────────
  const wordSize = Math.min(W * 0.42, 170);
  const off = document.createElement('canvas');
  const sW = Math.ceil(wordSize * 1.3), sH = Math.ceil(wordSize * 2.6);
  off.width = sW; off.height = sH;
  const octx = off.getContext('2d');
  octx.fillStyle = '#000';
  octx.font = `${wordSize}px "Kaiti SC","STKaiti","KaiTi","Noto Serif SC",serif`;
  octx.textAlign = 'center'; octx.textBaseline = 'middle';
  octx.fillText('字', sW / 2, sH * 0.27);
  octx.fillText('灵', sW / 2, sH * 0.73);
  const img = octx.getImageData(0, 0, sW, sH).data;

  const step = Math.max(4, Math.round(wordSize / 30));   // 采样密度随字号自适应
  const cx = W / 2, cy = H * 0.42;
  const targets = [];
  for (let y = 0; y < sH; y += step) {
    for (let x = 0; x < sW; x += step) {
      if (img[(y * sW + x) * 4 + 3] > 140) {
        targets.push({ x: cx + (x - sW / 2), y: cy + (y - sH / 2) });
      }
    }
  }

  // ── 粒子：每个落点一枚小字，从画面外环漂入 ────────────────────
  const parts = targets.map((t, i) => {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.max(W, H) * (0.55 + Math.random() * 0.35);
    return {
      tx: t.x, ty: t.y,
      sx: cx + Math.cos(ang) * r, sy: cy * 1.1 + Math.sin(ang) * r,
      ch: POOL[i % POOL.length],
      delay: Math.random() * 0.55,                       // 错峰起飞，像墨随水散
      rot: (Math.random() - 0.5) * 2.4,
      size: step * (0.82 + Math.random() * 0.24),
    };
  });

  // 时间轴（秒）
  const T_GATHER = 1.7;     // 聚字
  const T_SEAL = 2.05;      // 落印
  const T_SUB = 2.35;       // 副题
  const T_END = reduced ? 0.6 : 3.4;

  const sealSize = Math.max(40, wordSize * 0.34);
  const sealX = cx + wordSize * 0.62, sealY = cy + wordSize * 1.18;

  let t0 = null, rafId = 0, finished = false;

  function frame(now) {
    if (t0 === null) t0 = now;
    const t = reduced ? T_END : (now - t0) / 1000;

    ctx.clearRect(0, 0, W, H);

    // 聚字
    for (const p of parts) {
      const k = Math.min(1, Math.max(0, (t - p.delay) / (T_GATHER - p.delay)));
      const e = easeOut(k);
      const x = p.sx + (p.tx - p.sx) * e;
      const y = p.sy + (p.ty - p.sy) * e;
      const alpha = 0.12 + 0.88 * e;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.rot * (1 - e));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = e > 0.92 ? COL.ink : COL.ink3;
      ctx.font = `${p.size}px "Kaiti SC","STKaiti","KaiTi",serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.ch, 0, 0);
      ctx.restore();
    }

    // 落印：朱砂方印「日程」，盖章式由大及小压下
    if (t > T_SEAL || reduced) {
      const k = reduced ? 1 : Math.min(1, (t - T_SEAL) / 0.32);
      const s = 1.8 - 0.8 * easeIn(k);
      ctx.save();
      ctx.translate(sealX, sealY);
      ctx.rotate(-0.06 * (1 - k));
      ctx.scale(s, s);
      ctx.globalAlpha = k;
      ctx.fillStyle = COL.seal;
      const r = sealSize / 2;
      ctx.beginPath();
      // 手工圆角矩形（兼容无 roundRect 的旧 WebView）
      const rr = sealSize * 0.16;
      ctx.moveTo(-r + rr, -r);
      ctx.arcTo(r, -r, r, r, rr); ctx.arcTo(r, r, -r, r, rr);
      ctx.arcTo(-r, r, -r, -r, rr); ctx.arcTo(-r, -r, r, -r, rr);
      ctx.fill();
      ctx.fillStyle = COL.paper;
      ctx.font = `${sealSize * 0.34}px "Kaiti SC","STKaiti","KaiTi",serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('日', 0, -sealSize * 0.2);
      ctx.fillText('程', 0, sealSize * 0.21);
      ctx.restore();
    }

    // 副题
    if (t > T_SUB || reduced) {
      const k = reduced ? 1 : Math.min(1, (t - T_SUB) / 0.5);
      ctx.save();
      ctx.globalAlpha = 0.85 * easeOut(k);
      ctx.fillStyle = COL.ink3;
      ctx.font = `12.5px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      const text = '一 笔 一 画 ， 把 日 子 过 成 诗';
      ctx.fillText(text, cx, cy + wordSize * 1.85 + (1 - easeOut(k)) * 8);
      ctx.restore();
    }

    if (t >= T_END) { end(); return; }
    rafId = requestAnimationFrame(frame);
  }

  function end() {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(rafId);
    wrap.classList.add('fade');
    wrap.removeEventListener('pointerdown', end);
    setTimeout(() => { wrap.remove(); onDone && onDone(); }, 720);
  }

  wrap.addEventListener('pointerdown', end);
  rafId = requestAnimationFrame(frame);
}
