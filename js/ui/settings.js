/**
 * 字灵设置面板（"App 内调整页面"）——独立、可拆解、易改装到其他页面。
 *
 * 设计原则（应用户要求）：UI 与功能控制解耦。本模块**不直接读写 app 内部状态**，而是通过
 * 构造时传入的 `hooks` 回调来读/写（主题、字体、字色、呼吸炫彩、AI 风格、记忆、API、原态字号）。
 * 后端组装时可整体替换本文件的外观、或把同一组 hooks 接到别的 UI，互不影响。
 *
 * 这个页面本身也是"呈现给后端做取舍/再设计"的——例如"用户达成任务才解锁某颜色"等运营逻辑，
 * 后端可在此基础上增删项。当前实现的每一项都已实装生效。
 *
 * @module ui/settings
 */

import * as ai from '../ai/bridge.js';

const LS = {
  mode: 'ziling.theme.mode',        // 'system' | 'light' | 'dark'
  font: 'ziling.theme.font',
  color: 'ziling.theme.color',      // 自定义字色（空=跟随主题 fg）
  fx: 'ziling.theme.fx',            // 'none' | 'breathe' | 'rainbow'
  originScale: 'ziling.origin.scale',
};
const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* */ } };

export const FONTS = [
  { label: '黑体', css: '"PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif' },
  { label: '宋体', css: '"Songti SC", "SimSun", "STSong", serif' },
  { label: '楷体', css: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
  { label: '圆体', css: '"Yuanti SC", "Microsoft YaHei", sans-serif' },
];
export const FX = [{ label: '无', v: 'none' }, { label: '呼吸渐变', v: 'breathe' }, { label: '炫彩', v: 'rainbow' }];

/** 读取持久化的设置（app 启动时用来还原）。 */
export function loadSettings() {
  return {
    mode: get(LS.mode, 'system'),
    font: get(LS.font, FONTS[0].css),
    color: get(LS.color, ''),
    fx: get(LS.fx, 'none'),
    originScale: parseFloat(get(LS.originScale, '1')) || 1,
    persona: ai.getPersona(),
    memory: ai.memoryOn(),
  };
}

/**
 * 构建设置面板 DOM 并返回根元素。
 * @param {object} hooks 回调：
 *   setMode(mode), setFont(css), setColor(hex|''), setFx(v), setOriginScale(num)
 * 每次改动即调用对应 hook（hook 负责实际生效，如改 CSS 变量、清字形缓存）。
 */
export function buildSettings(hooks) {
  const wrap = el('div', 'position:absolute;left:6px;right:6px;bottom:6px;display:none;flex-direction:column;'
    + 'gap:9px;padding:11px;border-radius:12px;background:rgba(10,12,20,0.82);backdrop-filter:blur(3px);'
    + 'max-height:62%;overflow:auto;color:#dfe7f5;font-size:13px;');
  const stop = e => e.stopPropagation();
  wrap.addEventListener('pointerdown', stop);

  const s = loadSettings();

  // 1) 深/浅色（默认跟随系统）—— 下拉
  wrap.append(rowDropdown('外观', [['跟随系统', 'system'], ['浅色', 'light'], ['深色', 'dark']], s.mode,
    v => { set(LS.mode, v); hooks.setMode(v); }));

  // 2) 字体 —— 下拉
  wrap.append(rowDropdown('字体', FONTS.map(f => [f.label, f.css]), s.font,
    v => { set(LS.font, v); hooks.setFont(v); }));

  // 3) 字色（取色器 + 跟随主题）
  const colorRow = row('字色');
  const cpick = document.createElement('input');
  cpick.type = 'color'; cpick.value = s.color || '#e0e0e0';
  cpick.style.cssText = 'width:40px;height:28px;border:none;background:none;cursor:pointer;border-radius:6px;';
  cpick.addEventListener('input', () => { set(LS.color, cpick.value); hooks.setColor(cpick.value); });
  const cReset = btn('跟随主题', () => { set(LS.color, ''); hooks.setColor(''); });
  colorRow.append(cpick, cReset);
  wrap.append(colorRow);

  // 3b) 字色特效 —— 下拉
  wrap.append(rowDropdown('字色特效', FX.map(f => [f.label, f.v]), s.fx,
    v => { set(LS.fx, v); hooks.setFx(v); }));

  // 7) 原态字号
  const osRow = row('原态字号');
  const osr = document.createElement('input');
  osr.type = 'range'; osr.min = '0.7'; osr.max = '1.6'; osr.step = '0.05'; osr.value = String(s.originScale);
  osr.style.cssText = 'flex:1;';
  const osVal = el('span', 'width:34px;text-align:right;', `${s.originScale.toFixed(2)}×`);
  osr.addEventListener('input', () => { const v = parseFloat(osr.value); osVal.textContent = `${v.toFixed(2)}×`; set(LS.originScale, String(v)); hooks.setOriginScale(v); });
  osRow.append(osr, osVal);
  wrap.append(osRow);

  wrap.append(divider('—— AI ——'));

  // 4) AI 回复风格（人设）
  const pRow = row('AI风格');
  const pin = document.createElement('input');
  pin.type = 'text'; pin.placeholder = '如：温柔/俏皮/古典文艺'; pin.value = s.persona;
  pin.maxLength = 40; pin.style.cssText = inputCss();
  pin.addEventListener('pointerdown', stop);
  pin.addEventListener('keydown', e => e.stopPropagation());
  pin.addEventListener('change', () => ai.setPersona(pin.value.trim()));
  pRow.append(pin, btn('保存', () => ai.setPersona(pin.value.trim())));
  wrap.append(pRow);

  // 5) AI 记忆开关 —— 拨动开关（主流逻辑）
  wrap.append(rowToggle('AI记忆', s.memory, on => ai.setMemory(on)));

  // 6) API Key（仅本机 localStorage；上线走后端网关）
  const kRow = row('API Key');
  const kin = document.createElement('input');
  kin.type = 'password'; kin.placeholder = ai.hasUserKey() ? '已存(本机)' : 'DeepSeek key';
  kin.style.cssText = inputCss();
  kin.addEventListener('pointerdown', stop);
  kin.addEventListener('keydown', e => e.stopPropagation());
  const srcTag = el('span', 'opacity:0.7;font-size:12px;', '来源:' + ai.aiSource());
  kRow.append(kin,
    btn('存', () => { if (kin.value.trim()) { ai.setUserKey(kin.value.trim()); kin.value = ''; kin.placeholder = '已存(本机)'; srcTag.textContent = '来源:' + ai.aiSource(); } }),
    btn('清', () => { ai.setUserKey(''); kin.placeholder = 'DeepSeek key'; srcTag.textContent = '来源:' + ai.aiSource(); }),
    srcTag);
  wrap.append(kRow);

  return wrap;

  /* —— 小工具 —— */
  function el(tag, css, text) { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; }
  function inputCss() { return 'flex:1;min-width:90px;padding:6px;border-radius:7px;border:1px solid #3c4f76;background:#0d1320;color:#fff;font-size:13px;'; }
  function row(label) { const r = el('div', 'display:flex;gap:7px;align-items:center;'); r.append(el('span', 'width:60px;color:#8fa8d6;flex:none;', label)); return r; }
  function divider(t) { return el('div', 'text-align:center;color:#5f7196;font-size:12px;margin-top:2px;', t); }
  function btn(label, fn) {
    const b = el('button', 'padding:5px 9px;border-radius:7px;border:1px solid #3c4f76;background:#22304d;color:#eaeaea;font-size:12px;cursor:pointer;', label);
    b.addEventListener('pointerdown', stop);
    b.addEventListener('click', e => { stop(e); fn(); });
    return b;
  }
  // 下拉选择（原生 select，主流移动端设置常见样式）。
  function rowDropdown(label, opts, cur, fn) {
    const r = row(label);
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;min-width:90px;padding:7px 9px;border-radius:8px;border:1px solid #3c4f76;'
      + 'background:#0d1320;color:#fff;font-size:13px;cursor:pointer;appearance:auto;';
    opts.forEach(([t, v]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === cur) o.selected = true; sel.append(o); });
    sel.addEventListener('pointerdown', stop);
    sel.addEventListener('change', () => fn(sel.value));
    r.append(sel);
    return r;
  }
  // 拨动开关（iOS 风格圆钮）。
  function rowToggle(label, on, fn) {
    const r = row(label);
    const track = el('div', `width:46px;height:26px;border-radius:13px;cursor:pointer;flex:none;position:relative;`
      + `transition:background .2s;background:${on ? '#3a6df0' : '#41506e'};`);
    const knob = el('div', 'position:absolute;top:3px;width:20px;height:20px;border-radius:50%;background:#fff;'
      + `transition:left .2s;left:${on ? '23px' : '3px'};box-shadow:0 1px 3px rgba(0,0,0,0.4);`);
    track.append(knob);
    let state = on;
    track.addEventListener('pointerdown', stop);
    track.addEventListener('click', () => { state = !state; track.style.background = state ? '#3a6df0' : '#41506e'; knob.style.left = state ? '23px' : '3px'; fn(state); });
    r.append(track);
    return r;
  }
}
