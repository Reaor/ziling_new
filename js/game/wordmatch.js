/**
 * 字灵 · 游戏态：文字消消乐（收束 L21）。
 *
 * 玩法：N×N 规整格子，每格一个汉字。点亮一个字，再点一个能与它组成词的字（顺序不论）→ 消去两字，
 * 墨色溢出特效 + 计分 + 上方补入新字。退出按钮回互动态。
 *
 * 延时方案（应用户顾虑，两者结合）：
 *   1) 本地双字词库即时判定 → 多数情况 0 延迟、即时正反馈。
 *   2) 本地未命中时再问 AI（bridge.validateWord）兜底，避免"做对了被判错"；等待期间被点的两个字
 *      做"脉动等待"动效缓解延时负反馈；AI 判对则照常消去，判错则轻轻抖动复位。
 *
 * 字体/颜色跟随设置（用 CSS 变量 --zl-fg/--zl-bg + 传入的 fontCss）。
 * 独立、可拆解：只依赖一个挂载容器 + ai.validateWord + 主题取值回调；后端可整体替换外观。
 *
 * @module game/wordmatch
 */

import * as ai from '../ai/bridge.js';

// 常用单字池（用于铺格子，偏向易组词的高频字）。
const POOL = ('天明休息加油快乐学习工作朋友时间完成心想事成花开月圆风云山水日春秋冬'
  + '人和气安宁知道理想美好生活努力进步成长温暖光亮希望未来梦语言文字').split('');

// 本地双字词库（即时判定；未命中再问 AI）。可持续扩充。
const WORDS = new Set([
  '天明', '明天', '休息', '加油', '快乐', '学习', '工作', '朋友', '时间', '完成',
  '花开', '月圆', '风云', '山水', '春秋', '人和', '安宁', '知道', '理想', '美好',
  '生活', '努力', '进步', '成长', '温暖', '光亮', '希望', '未来', '梦想', '语言',
  '文字', '心想', '想事', '事成', '日月', '春风', '秋月', '气和', '和气', '美满',
]);

export class WordMatch {
  /**
   * @param {HTMLElement} mount 挂载容器（游戏层覆盖在 canvas 之上）
   * @param {object} opts { size=8, fontCss, onExit }
   */
  constructor(mount, opts = {}) {
    this.mount = mount;
    this.size = opts.size || 8;
    this.fontCss = opts.fontCss || 'inherit';
    this.onExit = opts.onExit || (() => {});
    this.score = 0;
    this.sel = null;          // 当前选中的 {r,c,el}
    this.busy = false;        // 等 AI 判定时禁止新点击
    this.cells = [];          // r*size+c → {ch, el}
    this.root = null;
  }

  open() {
    const root = document.createElement('div');
    root.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:flex-start;gap:10px;padding:14px 8px;'
      + 'background:var(--zl-bg);color:var(--zl-fg);box-sizing:border-box;z-index:5;';
    root.addEventListener('pointerdown', e => e.stopPropagation());

    // 顶部：计分 + 退出
    const top = document.createElement('div');
    top.style.cssText = 'width:100%;max-width:420px;display:flex;justify-content:space-between;align-items:center;';
    this.scoreEl = document.createElement('div');
    this.scoreEl.style.cssText = 'font-size:18px;font-weight:600;letter-spacing:1px;';
    this._renderScore();
    const exit = document.createElement('button');
    exit.textContent = '退出 ✕';
    exit.style.cssText = pill();
    exit.addEventListener('pointerdown', e => e.stopPropagation());
    exit.addEventListener('click', () => this.close());
    top.append(this.scoreEl, exit);
    root.append(top);

    // 棋盘
    const board = document.createElement('div');
    const n = this.size;
    board.style.cssText = `display:grid;grid-template-columns:repeat(${n},1fr);gap:4px;`
      + 'width:min(92vw,420px);aspect-ratio:1;';
    this.board = board;
    for (let i = 0; i < n * n; i++) {
      const cell = document.createElement('div');
      cell.style.cssText = this._cellCss();
      const ch = this._randChar();
      cell.textContent = ch;
      cell.addEventListener('pointerdown', e => e.stopPropagation());
      cell.addEventListener('click', () => this._tap(i));
      this.cells[i] = { ch, el: cell };
      board.append(cell);
    }
    root.append(board);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;opacity:0.6;';
    hint.textContent = '点两个能组成词的字消除它们';
    root.append(hint);

    this.mount.append(root);
    this.root = root;
  }

  close() {
    if (this.root) { this.root.remove(); this.root = null; }
    this.onExit();
  }

  _cellCss(active) {
    return 'display:flex;align-items:center;justify-content:center;'
      + `font-family:${this.fontCss};font-size:min(6vw,26px);`
      + 'border-radius:9px;border:1px solid rgba(127,127,127,0.25);'
      + 'background:rgba(127,127,127,0.10);cursor:pointer;user-select:none;'
      + 'transition:transform .15s,background .2s,box-shadow .2s,opacity .25s;'
      + (active ? 'box-shadow:0 0 0 2px var(--zl-fg) inset;transform:scale(1.06);' : '');
  }

  _randChar() { return POOL[(Math.random() * POOL.length) | 0]; }
  _renderScore() { this.scoreEl.textContent = `得分 ${this.score}`; }

  _tap(i) {
    if (this.busy) return;
    const cur = this.cells[i];
    if (!cur || cur.removing) return;
    if (this.sel && this.sel.i === i) { this._deselect(); return; } // 再点同一个 → 取消
    if (!this.sel) { this._select(i); return; }

    // 已有选中 → 判定这两个字能否组词
    const a = this.cells[this.sel.i].ch, b = cur.ch;
    const local = WORDS.has(a + b) || WORDS.has(b + a);
    if (local) { this._clearPair(this.sel.i, i, (a + b)); this.sel = null; return; }

    // 本地未命中 → 问 AI（等待期被点两字"脉动"缓解延时）。
    const i1 = this.sel.i, i2 = i;
    this._pulse(i1, true); this._pulse(i2, true); this.busy = true;
    ai.validateWord(a, b).then(res => {
      this.busy = false; this._pulse(i1, false); this._pulse(i2, false);
      if (res && res.valid) this._clearPair(i1, i2, res.word || (a + b));
      else { this._shake(i1); this._shake(i2); this._deselect(); }
    }).catch(() => { this.busy = false; this._pulse(i1, false); this._pulse(i2, false); this._shake(i2); this._deselect(); });
  }

  _select(i) { this.sel = { i }; this.cells[i].el.style.cssText = this._cellCss(true); }
  _deselect() { if (this.sel) { this.cells[this.sel.i].el.style.cssText = this._cellCss(false); this.sel = null; } }

  _pulse(i, on) {
    const el = this.cells[i].el;
    el.style.animation = on ? 'zlpulse 0.7s ease-in-out infinite' : '';
    if (on) el.style.cssText = this._cellCss(true) + 'animation:zlpulse .7s ease-in-out infinite;';
    else el.style.cssText = this._cellCss(true);
  }
  _shake(i) {
    const el = this.cells[i].el;
    el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 280 });
  }

  // 消去一对：墨色溢出特效 + 计分 + 补字。
  _clearPair(i1, i2, word) {
    this.score += 10 + (word ? word.length * 2 : 0);
    this._renderScore();
    [i1, i2].forEach(i => this._inkBurst(i));
    setTimeout(() => { this._refill(i1); this._refill(i2); }, 360);
    this._deselect();
  }

  // 墨色溢出：格内一团墨迅速涨满并淡出，字消失。
  _inkBurst(i) {
    const cell = this.cells[i].el;
    cell.removing = true; this.cells[i].removing = true;
    const ink = document.createElement('div');
    ink.style.cssText = 'position:absolute;inset:0;margin:auto;width:6px;height:6px;border-radius:50%;'
      + 'background:var(--zl-fg);opacity:0.85;transform:scale(1);';
    cell.style.position = 'relative';
    cell.append(ink);
    ink.animate([{ transform: 'scale(1)', opacity: 0.85 }, { transform: 'scale(9)', opacity: 0 }], { duration: 360, easing: 'ease-out' });
    cell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' });
    cell.textContent = '';
    setTimeout(() => { ink.remove(); }, 380);
  }

  _refill(i) {
    const ch = this._randChar();
    this.cells[i].ch = ch; this.cells[i].removing = false;
    const cell = this.cells[i].el;
    cell.textContent = ch;
    cell.style.cssText = this._cellCss(false);
    cell.animate([{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
  }
}

function pill() {
  return 'padding:7px 12px;border-radius:12px;border:1px solid rgba(127,127,127,0.3);'
    + 'background:rgba(127,127,127,0.12);color:var(--zl-fg);font-size:13px;cursor:pointer;'
    + 'backdrop-filter:blur(6px);';
}
