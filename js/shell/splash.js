/**
 * 开屏动画（双风格）：
 * · 水墨（默认）：千字文小字从四方漂入聚成「字灵」二字（背后晕开一层淡墨），
 *   青瓷小印「日程」带回弹落印，副题浮现 → 整体淡出进入 App。
 * · 现代（data-ui="modern"）：极简——细线自中心展开，字标「字灵日程」浮起，
 *   强调色圆点收束，干净利落。
 * 轻触可跳过；prefers-reduced-motion 时直接呈现静帧后快速结束。
 */

const POOL = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜'.split('');

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;

export function playSplash({ onDone }) {
  const wrap = document.getElementById('splash');
  const canvas = document.getElementById('splash-canvas');
  if (!wrap || !canvas) { onDone && onDone(); return; }
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const modern = document.documentElement.dataset.ui === 'modern';

  const css = getComputedStyle(document.documentElement);
  const v = (name, d) => (css.getPropertyValue(name).trim() || d);
  const COL = {
    paper: v('--paper', '#f6f2e9'),
    ink: v('--ink', '#2b2722'),
    ink2: v('--ink-2', '#6f6757'),
    ink3: v('--ink-3', '#a39a87'),
    seal: v('--seal', '#87C8B4'),
    onAccent: v('--on-accent', '#14332a'),
  };

  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = wrap.clientWidth, H = wrap.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  let t0 = null, rafId = 0, finished = false;

  function end() {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(rafId);
    wrap.classList.add('fade');
    wrap.removeEventListener('pointerdown', end);
    setTimeout(() => { wrap.remove(); onDone && onDone(); }, 700);
  }
  wrap.addEventListener('pointerdown', end);

  /** 品牌 logo（双山形眉眼 + 圆环），以 120 单位坐标系绘制。 */
  function drawLogo(x, y, size, alpha) {
    const u = size / 120;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = COL.seal;
    ctx.lineWidth = 11 * u;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.translate(x - 60 * u, y - 60 * u);
    ctx.beginPath(); ctx.moveTo(20 * u, 57 * u); ctx.lineTo(37 * u, 31 * u); ctx.lineTo(54 * u, 57 * u); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(66 * u, 57 * u); ctx.lineTo(83 * u, 31 * u); ctx.lineTo(100 * u, 57 * u); ctx.stroke();
    ctx.beginPath(); ctx.arc(60 * u, 80 * u, 14 * u, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /* ════════════ 现代风：logo + 极简线与字标 ════════════ */
  if (modern) {
    const T_END = reduced ? 0.4 : 2.2;
    const cx = W / 2, cy = H * 0.46;
    const frame = (now) => {
      if (t0 === null) t0 = now;
      const t = reduced ? T_END : (now - t0) / 1000;
      ctx.clearRect(0, 0, W, H);
      // 0) 品牌 logo 浮起
      const k0 = Math.min(1, t / 0.5);
      drawLogo(cx, cy - 64 + (1 - easeOut(k0)) * 10, 88, easeOut(k0));
      // 1) 细线自中心向两侧展开
      const k1 = Math.min(1, t / 0.55);
      const lineW = 132 * easeOut(k1);
      ctx.strokeStyle = COL.ink3; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx - lineW / 2, cy + 26); ctx.lineTo(cx + lineW / 2, cy + 26); ctx.stroke();
      // 2) 字标浮起
      const k2 = Math.min(1, Math.max(0, (t - 0.25) / 0.6));
      ctx.save();
      ctx.globalAlpha = easeOut(k2);
      ctx.fillStyle = COL.ink;
      ctx.font = `650 30px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText('字灵日程', cx, cy + 8 - (1 - easeOut(k2)) * 14);
      ctx.restore();
      // 3) 强调色圆点沿线滑入定位 + 小字
      const k3 = Math.min(1, Math.max(0, (t - 0.7) / 0.5));
      if (k3 > 0) {
        ctx.save();
        ctx.globalAlpha = k3;
        ctx.fillStyle = COL.seal;
        ctx.beginPath(); ctx.arc(cx + lineW / 2 + 10, cy + 26, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.9 * k3;
        ctx.fillStyle = COL.ink3;
        ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
        ctx.textAlign = 'center';
        ctx.fillText('日程 · 团队 · 字灵', cx, cy + 52);
        ctx.restore();
      }
      if (t >= T_END) { end(); return; }
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);
    return;
  }

  /* ════════════ 水墨风：聚字 + 落印 ════════════ */
  // 离屏采样「字灵」二字的落点
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

  // 粒子：每个落点一枚小字，从画面外环漂入；落定后带一点点"墨方收笔"的微颤
  const parts = targets.map((t, i) => {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.max(W, H) * (0.5 + Math.random() * 0.35);
    return {
      tx: t.x, ty: t.y,
      sx: cx + Math.cos(ang) * r, sy: cy * 1.1 + Math.sin(ang) * r,
      ch: POOL[i % POOL.length],
      delay: Math.random() * 0.45,                       // 错峰起飞，像墨随水散
      rot: (Math.random() - 0.5) * 2.4,
      size: step * (0.82 + Math.random() * 0.24),
      ph: Math.random() * Math.PI * 2,                   // 落定微颤相位
    };
  });

  // 时间轴（秒）—— 比上一版更紧凑
  const T_GATHER = 1.45;    // 聚字
  const T_SEAL = 1.8;       // 落印
  const T_SUB = 2.05;       // 副题
  const T_END = reduced ? 0.5 : 3.05;

  const sealSize = Math.max(40, wordSize * 0.34);
  const sealX = cx + wordSize * 0.62, sealY = cy + wordSize * 1.18;
  const kaiFont = '"Kaiti SC","STKaiti","KaiTi",serif';

  function frame(now) {
    if (t0 === null) t0 = now;
    const t = reduced ? T_END : (now - t0) / 1000;

    ctx.clearRect(0, 0, W, H);

    // 0) 字背后的淡墨晕：随聚字进度晕开（像宣纸吃墨）
    const wash = Math.min(1, t / T_GATHER);
    if (wash > 0.15) {
      const g = ctx.createRadialGradient(cx, cy, wordSize * 0.2, cx, cy, wordSize * 1.55);
      g.addColorStop(0, COL.ink); g.addColorStop(1, 'transparent');
      ctx.save();
      ctx.globalAlpha = 0.05 * easeOut((wash - 0.15) / 0.85);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(cx, cy, wordSize * 1.5, wordSize * 1.85, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // 1) 聚字
    for (const p of parts) {
      const k = Math.min(1, Math.max(0, (t - p.delay) / (T_GATHER - p.delay)));
      const e = easeOut(k);
      // 落定后的微颤：振幅随时间衰减，让整个字"活"一瞬再定住
      const settle = k >= 1 ? Math.max(0, 1 - (t - T_GATHER) / 0.6) : 0;
      const wob = settle * 0.9 * Math.sin((t * 6) + p.ph);
      const x = p.sx + (p.tx - p.sx) * e + wob;
      const y = p.sy + (p.ty - p.sy) * e + wob * 0.6;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.rot * (1 - e));
      ctx.globalAlpha = 0.12 + 0.88 * e;
      ctx.fillStyle = e > 0.92 ? COL.ink : COL.ink3;
      ctx.font = `${p.size}px ${kaiFont}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.ch, 0, 0);
      ctx.restore();
    }

    // 2) 落印：青瓷方印「日程」，盖章式压下、轻微回弹，印泥微晕
    if (t > T_SEAL || reduced) {
      const k = reduced ? 1 : Math.min(1, (t - T_SEAL) / 0.34);
      const press = easeIn(k);
      // 压下（1.8→1.0）后，0.18s 内一个 4% 的回弹，像真盖章
      const bounceK = Math.min(1, Math.max(0, (t - T_SEAL - 0.34) / 0.18));
      const scale = 1.8 - 0.8 * press - 0.04 * Math.sin(bounceK * Math.PI);
      ctx.save();
      ctx.translate(sealX, sealY);
      ctx.rotate(-0.06 * (1 - press));
      ctx.scale(scale, scale);
      ctx.globalAlpha = press;
      // 印泥晕：印章落定后外圈一圈极淡主色
      if (k >= 1) {
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = COL.seal;
        ctx.beginPath(); ctx.arc(0, 0, sealSize * 0.78, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = COL.seal;
      const r = sealSize / 2, rr = sealSize * 0.16;
      ctx.beginPath();
      // 手工圆角矩形（兼容无 roundRect 的旧 WebView）
      ctx.moveTo(-r + rr, -r);
      ctx.arcTo(r, -r, r, r, rr); ctx.arcTo(r, r, -r, r, rr);
      ctx.arcTo(-r, r, -r, -r, rr); ctx.arcTo(-r, -r, r, -r, rr);
      ctx.fill();
      ctx.fillStyle = COL.onAccent;
      ctx.font = `${sealSize * 0.34}px ${kaiFont}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('日', 0, -sealSize * 0.2);
      ctx.fillText('程', 0, sealSize * 0.21);
      ctx.restore();
    }

    // 3) 副题
    if (t > T_SUB || reduced) {
      const k = reduced ? 1 : Math.min(1, (t - T_SUB) / 0.45);
      ctx.save();
      ctx.globalAlpha = 0.85 * easeOut(k);
      ctx.fillStyle = COL.ink3;
      ctx.font = `12.5px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.fillText('一 笔 一 画 ， 把 日 子 过 成 诗', cx, cy + wordSize * 1.85 + (1 - easeOut(k)) * 8);
      ctx.restore();
    }

    if (t >= T_END) { end(); return; }
    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);
}
