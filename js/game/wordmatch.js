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

// 本地双字词库（即时判定；未命中再问 AI 兜底）。覆盖大量高频常用词，让"正确的词"基本都能即时判对。
// 顺序不论：判定时同时检查 ab 与 ba。
const WORD_LIST = [
  '明天', '今天', '昨天', '天空', '天气', '休息', '加油', '快乐', '开心', '学习',
  '工作', '朋友', '时间', '完成', '努力', '进步', '成长', '希望', '未来', '梦想',
  '语言', '文字', '心想', '理想', '美好', '生活', '温暖', '光明', '阳光', '微笑',
  '花开', '月圆', '风云', '山水', '春风', '秋月', '冬雪', '夏日', '和气', '平安',
  '安宁', '安心', '知道', '思考', '记忆', '青春', '勇敢', '坚持', '相信', '感谢',
  '快慢', '高低', '大小', '上下', '左右', '前后', '内外', '东西', '南北', '黑白',
  '日月', '水火', '冷暖', '甘苦', '悲喜', '聚散', '动静', '问答', '来往', '出入',
  '朋辈', '同学', '老师', '父母', '家人', '孩子', '世界', '城市', '道路', '回家',
  '吃饭', '喝水', '睡觉', '读书', '写字', '唱歌', '跳舞', '画画', '运动', '游戏',
  '健康', '幸福', '自由', '宁静', '从容', '专注', '清醒', '放松', '充实', '丰盈',
];
const WORDS = new Set(WORD_LIST);
// 单字池 = 词库里所有出现过的字（保证棋盘里的字大多能两两组成词，减少"凑不出"的挫败）。
const POOL = [...new Set(WORD_LIST.join('').split(''))];

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
      + 'align-items:center;justify-content:center;gap:14px;padding:18px 10px;'
      + 'background:var(--zl-bg);color:var(--zl-fg);box-sizing:border-box;z-index:5;';
    root.addEventListener('pointerdown', e => e.stopPropagation());

    // 脉动等待 keyframes（作用域仅本覆盖层）。
    const style = document.createElement('style');
    style.textContent = '@keyframes zlpulse{0%,100%{transform:scale(1.0)}50%{transform:scale(1.14)}}';
    root.append(style);

    // 顶部：标题 + 计分胶囊 + 退出
    const top = document.createElement('div');
    top.style.cssText = 'width:100%;max-width:420px;display:flex;justify-content:space-between;align-items:center;gap:8px;';
    const title = document.createElement('div');
    title.textContent = '字 · 消'; title.style.cssText = 'font-size:17px;font-weight:600;letter-spacing:3px;opacity:0.9;';
    this.scoreEl = document.createElement('div');
    this.scoreEl.style.cssText = 'flex:1;text-align:center;font-size:15px;font-weight:600;letter-spacing:1px;'
      + 'padding:6px 0;border-radius:11px;background:rgba(127,127,127,0.12);';
    this._renderScore();
    const exit = document.createElement('button');
    exit.textContent = '✕';
    exit.style.cssText = pill() + 'width:36px;height:36px;padding:0;font-size:15px;';
    exit.addEventListener('pointerdown', e => e.stopPropagation());
    exit.addEventListener('click', () => this.close());
    top.append(title, this.scoreEl, exit);
    root.append(top);

    // 棋盘（带柔和外框、毛玻璃底）
    const board = document.createElement('div');
    const n = this.size;
    board.style.cssText = `display:grid;grid-template-columns:repeat(${n},1fr);gap:5px;`
      + 'width:min(92vw,420px);aspect-ratio:1;padding:8px;border-radius:16px;'
      + 'background:rgba(127,127,127,0.08);box-shadow:0 6px 24px rgba(0,0,0,0.18);';
    this.board = board;
    for (let i = 0; i < n * n; i++) {
      const cell = document.createElement('div');
      const ch = this._randChar();
      cell.textContent = ch;
      cell.addEventListener('pointerdown', e => e.stopPropagation());
      cell.addEventListener('click', () => this._tap(i));
      this.cells[i] = { ch, el: cell };
      cell.style.cssText = this._cellCss(false);
      board.append(cell);
    }
    root.append(board);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;opacity:0.55;';
    hint.textContent = '点两个能组成词的字即可消除（顺序不论·再点取消）';
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
    if (this.busy) return;                       // 判定中（等 AI）不接受新点击
    const cur = this.cells[i];
    if (!cur || cur.removing) return;
    // 再次单击已激活的字 → 解除该字激活。
    if (this.sel === i) { this._setActive(i, false); this.sel = null; return; }
    // 还没有激活的字 → 激活当前。
    if (this.sel == null) { this.sel = i; this._setActive(i, true); return; }

    // 已有一个激活字 + 点了另一个 → 判定这两个字能否组词（顺序不论）。
    const i1 = this.sel, i2 = i;
    const a = this.cells[i1].ch, b = this.cells[i2].ch;
    this._setActive(i2, true);                   // 第二个也高亮，明确"正在判定这两个"
    if (WORDS.has(a + b) || WORDS.has(b + a)) {   // 本地命中 → 即时判对
      this.sel = null;
      this._clearPair(i1, i2, WORDS.has(a + b) ? a + b : b + a);
      return;
    }
    // 本地未命中 → 问 AI 兜底（等待期两字脉动缓解延时）。无论判对判错，结束都清除两字激活。
    this.busy = true; this.sel = null;
    this._pulse(i1, true); this._pulse(i2, true);
    const done = (ok, word) => {
      this.busy = false;
      this._pulse(i1, false); this._pulse(i2, false);
      if (ok) { this._clearPair(i1, i2, word); }
      else { this._shake(i1); this._shake(i2); this._setActive(i1, false); this._setActive(i2, false); }
    };
    ai.validateWord(a, b)
      .then(res => done(!!(res && res.valid), (res && res.word) || (a + b)))
      .catch(() => done(false));
  }

  // 设置/取消某格的"激活"高亮（不带脉动）。
  _setActive(i, on) {
    const c = this.cells[i]; if (!c) return;
    c.active = on; c.pulsing = false;
    c.el.style.cssText = this._cellCss(on);
  }
  // 脉动等待态（仅判定期间）。结束时由 _setActive(false) 或 _clearPair 收尾。
  _pulse(i, on) {
    const c = this.cells[i]; if (!c) return;
    c.pulsing = on;
    c.el.style.cssText = this._cellCss(true) + (on ? 'animation:zlpulse .7s ease-in-out infinite;' : '');
  }
  _shake(i) {
    const el = this.cells[i].el;
    el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 280 });
  }

  // 消去一对：墨色溢出特效 + 计分 + 补字。
  _clearPair(i1, i2, word) {
    this.score += 10 + (word ? word.length * 2 : 0);
    this._renderScore();
    [i1, i2].forEach(i => { this.cells[i].active = false; this.cells[i].pulsing = false; this._inkBurst(i); });
    setTimeout(() => { this._refill(i1); this._refill(i2); }, 360);
    this.sel = null;
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
