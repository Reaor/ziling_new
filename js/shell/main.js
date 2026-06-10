/**
 * 字灵日程 · App 外壳总控
 * 五页：今日 / 日历 / 灵（字灵宠物页 iframe）/ 团队 / 我的。
 * 数据在 store.js（localStorage 真持久化）；日程实时喂给字灵（postMessage）。
 */

import * as store from './store.js';
import * as api from './api.js';
import * as remind from './remind.js';
import { playSplash } from './splash.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

store.load();

/* ── 主题 + 界面风格（水墨 ink / 现代 modern）──────────────── */
let zilingFrame = null;   // 字灵 iframe（懒加载；提前声明因 applyTheme 启动时即同步调色板）
const mqDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = store.get().settings.theme;
  const mode = pref === 'auto' ? (mqDark.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.ui = store.get().settings.uiStyle === 'modern' ? 'modern' : 'ink';
  $('meta[name="theme-color"]').content =
    getComputedStyle(document.documentElement).getPropertyValue('--paper').trim();
  sendZilingPalette();
}
mqDark.addEventListener('change', applyTheme);
applyTheme();

const isModern = () => store.get().settings.uiStyle === 'modern';
/** 双风格文案：水墨版有笔墨气，现代版直白利落。 */
const T = (ink, modern) => (isModern() ? modern : ink);

/* ── 轻提示 ───────────────────────────────────────────────── */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ── 底部抽屉 ─────────────────────────────────────────────── */
function openSheet(html) {
  const sheet = $('#sheet'), scrim = $('#scrim');
  sheet.innerHTML = `<div class="sheet-grip"></div>${html}`;
  sheet.classList.add('show');
  scrim.classList.add('show');
  return sheet;
}
function closeSheet() {
  $('#sheet').classList.remove('show');
  $('#scrim').classList.remove('show');
}
$('#scrim').addEventListener('click', closeSheet);

/* ── 页面路由 ─────────────────────────────────────────────── */
let current = 'today';
const renderers = { today: renderToday, calendar: renderCalendar, ziling: openZiling, team: renderTeam, me: renderMe };

function go(page) {
  current = page;
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  document.querySelectorAll('#tabbar .tab').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
  fab.style.display = (page === 'today' || page === 'calendar') ? '' : 'none';
  renderers[page]();
}
document.querySelectorAll('#tabbar .tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.page)));

// 数据变化 → 重绘当前页 + 同步字灵
store.onChange(() => { if (current !== 'ziling') renderers[current](); feedZiling(); });

/* ── 悬浮新建钮 ───────────────────────────────────────────── */
const fab = document.createElement('button');
fab.className = 'fab';
fab.textContent = '+';
fab.setAttribute('aria-label', '新建日程');
fab.addEventListener('click', () => openTaskSheet());
$('#phone').appendChild(fab);

/* ── 公共渲染小件 ─────────────────────────────────────────── */
const avatar = (m, size = '') => `<span class="dot-avatar ${size}" style="background:${m.color}">${esc(m.name[0])}</span>`;

function taskRow(t, { showTeam = true } = {}) {
  const tag = store.TAGS.find((x) => x.id === t.tag);
  const m = store.memberOf(t.assignee, t.teamId);
  const team = store.teamOf(t);
  const overdue = !t.done && t.date < store.todayStr();
  return `<div class="task ${t.done ? 'done' : ''} ${t.delayed || overdue ? 'delayed' : ''}" data-id="${t.id}">
    <span class="tick" data-act="tick">✓</span>
    <div class="t-main">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">
        ${t.time ? `<span class="chip time">${esc(t.time)}${t.remind && !t.done ? ' ⏰' : ''}</span>` : ''}
        ${tag ? `<span class="chip ${tag.cls}">${tag.name}</span>` : ''}
        ${showTeam && team && store.teams().length > 1 ? `<span class="chip">${esc(team.name)}</span>` : ''}
        ${overdue ? `<span class="chip delay">逾期</span>` : t.delayed ? `<span class="chip delay">搁置</span>` : ''}
      </div>
    </div>
    ${avatar(m)}
  </div>`;
}

function bindTaskRows(root) {
  root.querySelectorAll('.task').forEach((el) => {
    el.addEventListener('click', (e) => {
      const id = el.dataset.id;
      if (e.target.closest('[data-act="tick"]')) {
        const t = store.toggleDone(id);
        if (t?.done) toast(T('完成一件，墨迹又添一笔 ✦', '已完成 ✓'));
      } else {
        openTaskDetail(id);
      }
    });
  });
}

const emptyBlock = (glyph, lines) => `<div class="empty"><span class="e-glyph">${glyph}</span>${lines}</div>`;

/* ════════════════════════════ 今日 ═══════════════════════════ */
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 9) return '早安';
  if (h < 12) return '上午好';
  if (h < 14) return '午安';
  if (h < 18) return '下午好';
  return '晚上好';
}

function zilingQuote(v) {
  const doneN = v.done.length, leftN = v.doing.length + v.delayed.length;
  if (doneN === 0 && leftN === 0) return '今日纸上无事，正好留白。来陪我玩一会儿？';
  if (leftN === 0) return `今日 ${doneN} 件事尽数落笔，漂亮。来听我夸夸你 —`;
  if (v.delayed.length > 0) return '有几件事搁了墨，不急，挑一件先开始就好。';
  if (doneN > 0) return `已完成 ${doneN} 件，笔意正顺，乘势再写一件？`;
  return '一日之计，先从最小的那件事破题。';
}

function renderToday() {
  const page = $('#page-today');
  const v = store.todayView();
  const total = v.doing.length + v.delayed.length + v.done.length;
  const pct = total ? Math.round((v.done.length / total) * 100) : 0;
  const d = new Date();
  const dateText = d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  const weekText = d.toLocaleDateString('zh-CN', { weekday: 'long' });

  // 双风格的"今日概览"：
  // · 水墨——进度环 + 问候 + 页头笔触与闲章（艺术性：留白、笔意、印章）
  // · 现代——KPI 数字条 + 线性进度（办公性：数字前置、一眼可读）
  const weekChar = '日一二三四五六'[new Date().getDay()];
  const R = 40, C = 2 * Math.PI * R;
  const headHtml = isModern()
    ? `<header class="page-head">
        <div class="eyebrow">${weekText}</div>
        <h1>${dateText}</h1>
        <div class="sub">${greeting()}，${esc(store.get().profile.name)} · 今日 ${total} 项，完成 ${pct}%</div>
      </header>`
    : `<header class="page-head">
        <div class="eyebrow">${weekText} · ${esc(store.get().profile.motto)}</div>
        <h1>${dateText}</h1>
        <svg class="brush-line" width="150" height="10" viewBox="0 0 150 10" aria-hidden="true">
          <path d="M2 6 C 40 2, 95 9, 148 4" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" opacity=".85"/>
        </svg>
        <span class="head-seal">${weekChar}</span>
      </header>`;
  const overviewHtml = isModern()
    ? `<div class="card">
        <div class="kpi-row">
          <div><b class="hl">${v.doing.length}</b><span>待办</span></div>
          <div><b>${v.done.length}</b><span>已完成</span></div>
          <div><b>${v.delayed.length}</b><span>搁置/逾期</span></div>
          <div><b>${pct}%</b><span>完成率</span></div>
        </div>
        <div class="kpi-bar"><i style="width:${pct}%"></i></div>
      </div>`
    : `<div class="card overview">
        <div class="ring-wrap">
          <svg width="92" height="92" viewBox="0 0 92 92">
            <circle class="ring-bg" cx="46" cy="46" r="${R}" fill="none" stroke-width="7"/>
            <circle class="ring-fg" cx="46" cy="46" r="${R}" fill="none" stroke-width="7"
              stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/>
          </svg>
          <div class="ring-num"><b>${pct}%</b><span>完成</span></div>
        </div>
        <div class="overview-text">
          <div class="greet">${greeting()}，${esc(store.get().profile.name)}</div>
          <div class="detail">今日共 <b>${total}</b> 件事 · 已完成 <b>${v.done.length}</b> · 待办 <b>${v.doing.length}</b>${v.delayed.length ? ` · 搁置 <b>${v.delayed.length}</b>` : ''}</div>
        </div>
      </div>`;
  page.innerHTML = `
    ${headHtml}
    ${overviewHtml}

    <div class="card ziling-note" id="go-ziling">
      <span class="seal-avatar">灵</span>
      <div class="note-body"><i>字灵寄语</i><p>${zilingQuote(v)}</p></div>
      <span class="go">›</span>
    </div>

    ${v.doing.length ? `<div class="group-label">进行中<span class="cnt">${v.doing.length}</span></div>${v.doing.map(taskRow).join('')}` : ''}
    ${v.delayed.length ? `<div class="group-label">搁置 / 逾期<span class="cnt">${v.delayed.length}</span></div>${v.delayed.map(taskRow).join('')}` : ''}
    ${v.done.length ? `<div class="group-label">已完成<span class="cnt">${v.done.length}</span></div>${v.done.map(taskRow).join('')}` : ''}
    ${total === 0 ? emptyBlock('閒', T('今日无事<br>点右下角，落下今天第一笔', '今天还没有任务<br>点右下角新建一条')) : ''}
  `;
  bindTaskRows(page);
  $('#go-ziling', page).addEventListener('click', () => go('ziling'));
}

/* ════════════════════════════ 日历 ═══════════════════════════ */
let calCursor = new Date();          // 当前查看的月份
let calSelected = store.todayStr();  // 选中的日期

function renderCalendar() {
  const page = $('#page-calendar');
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 6) % 7;            // 周一为首
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = store.todayStr();

  let cells = '';
  for (let i = 0; i < lead; i++) {
    const d = new Date(y, m, i - lead + 1);
    cells += `<div class="cal-day dim" data-date="${store.todayStr(d)}">${d.getDate()}</div>`;
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const ds = store.todayStr(new Date(y, m, day));
    const dayTasks = store.tasksOn(ds);
    const dots = dayTasks.slice(0, 3).map((t) => `<i class="${t.done ? 'd-done' : 'd-pending'}"></i>`).join('');
    cells += `<div class="cal-day ${ds === today ? 'today' : ''} ${ds === calSelected ? 'sel' : ''}" data-date="${ds}">
      ${day}<span class="cal-dots">${dots}</span></div>`;
  }
  const tail = (7 - (lead + daysInMonth) % 7) % 7;
  for (let i = 1; i <= tail; i++) {
    const d = new Date(y, m + 1, i);
    cells += `<div class="cal-day dim" data-date="${store.todayStr(d)}">${i}</div>`;
  }

  const selTasks = store.tasksOn(calSelected);
  const selDate = new Date(calSelected + 'T00:00:00');
  const selLabel = selDate.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

  page.innerHTML = `
    <header class="page-head">
      <div class="eyebrow">日历</div>
      <h1>${y} 年 ${m + 1} 月</h1>
    </header>
    <div class="card">
      <div class="cal-nav">
        <button data-nav="-1" aria-label="上月">‹</button>
        <b>${m + 1} 月</b>
        <button data-nav="1" aria-label="下月">›</button>
      </div>
      <div class="cal-grid">
        ${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<div class="cal-wd">${w}</div>`).join('')}
        ${cells}
      </div>
    </div>
    <div class="group-label">${selLabel}<span class="cnt">${selTasks.length} 件</span></div>
    ${selTasks.length ? selTasks.map(taskRow).join('') : emptyBlock('白', T('这一天还是留白<br>点右下角为它写点什么', '这一天还没有安排<br>点右下角新建'))}
  `;
  page.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    calCursor = new Date(y, m + Number(b.dataset.nav), 1);
    renderCalendar();
  }));
  page.querySelectorAll('.cal-day').forEach((c) => c.addEventListener('click', () => {
    calSelected = c.dataset.date;
    const cd = new Date(calSelected + 'T00:00:00');
    if (cd.getMonth() !== m) calCursor = cd;
    renderCalendar();
  }));
  bindTaskRows(page);
}

/* ════════════════════════════ 字灵页 ══════════════════════════ */

/** 当前主题/风格下要传给字灵的调色板（让它的背景、按钮与 App 浑然一体）。 */
function zilingPalette() {
  const cs = getComputedStyle(document.documentElement);
  const c = (n) => cs.getPropertyValue(n).trim();
  return { bg: c('--paper'), fg: c('--ink'), ac: c('--seal'), onAc: c('--on-accent') };
}

function openZiling() {
  if (!zilingFrame) {
    const p = zilingPalette();
    const hex = (s) => encodeURIComponent(s.replace('#', ''));
    zilingFrame = document.createElement('iframe');
    zilingFrame.title = '字灵 · 汉字精灵';
    zilingFrame.allow = 'clipboard-write';
    // embed=1 进入嵌入模式（按钮融入宿主风格、设置融入 App）；调色板与当日日程经 URL 首发，
    // 后续更新走 postMessage。
    const payload = store.zilingPayload();
    lastFedJSON = JSON.stringify(payload);   // URL 已带上首份日程，load 后不再重复推送同一份
    zilingFrame.src = `ziling.html?embed=1&pbg=${hex(p.bg)}&pfg=${hex(p.fg)}&pac=${hex(p.ac)}&pon=${hex(p.onAc)}`
      + `&schedule=${encodeURIComponent(lastFedJSON)}`;
    zilingFrame.addEventListener('load', () => {
      $('#ziling-loading')?.remove();
      feedZiling();
    });
    $('#ziling-stage').appendChild(zilingFrame);
  } else {
    feedZiling();
  }
}

let feedTimer = null, lastFedJSON = '';
function feedZiling() {
  if (!zilingFrame?.contentWindow) return;
  clearTimeout(feedTimer);
  feedTimer = setTimeout(() => {
    // 只在日程内容真的变化时才推送：重复推送会让字灵反复重启"日程播报流"，
    // 打断进行中的呈现（这正是此前"里字大小不一"高发的诱因之一）。
    const payload = store.zilingPayload();
    const j = JSON.stringify(payload);
    if (j === lastFedJSON) return;
    lastFedJSON = j;
    try { zilingFrame.contentWindow.postMessage({ type: 'ziling:schedule', payload }, '*'); } catch { /* iframe 未就绪时忽略 */ }
  }, 400);
}

function sendZilingPalette() {
  try { zilingFrame?.contentWindow?.postMessage({ type: 'ziling:palette', payload: zilingPalette() }, '*'); } catch { /* ignore */ }
}

/** App 侧改了字灵设置（同一组 localStorage 键）后，通知 iframe 重放设置。 */
function refreshZilingSettings() {
  try { zilingFrame?.contentWindow?.postMessage({ type: 'ziling:refreshSettings' }, '*'); } catch { /* ignore */ }
}

/* ════════════════════════════ 团队 ══════════════════════════
 * 本地模式：多团队（设备内演示，成员是名牌）。
 * 联机模式（登录 zicodo 后）：服务器真实多人团队——6 位邀请码加入、成员/角色/积分、排行。 */
let teamFilter = null;   // 本地：按成员过滤任务；null = 全部
let srvTeams = null;     // 联机：我的团队列表缓存
let srvSelected = null;  // 联机：当前查看的团队 id

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function renderTeam() { api.isAuthed() ? renderTeamOnline() : renderTeamLocal(); }

/* —— 团队切换条（两种模式共用样式） —— */
const teamChips = (list, selId, extra = '') => `
  <div class="member-strip team-strip">
    ${list.map((t) => `
      <div class="member-cell ${t.id === selId ? 'sel' : ''}" data-tid="${t.id}">
        <span class="big-avatar" style="background:${t.id === selId ? 'var(--seal)' : 'var(--paper-3)'}; color:${t.id === selId ? 'var(--on-accent)' : 'var(--ink-2)'}">${esc(t.name[0])}</span>
        <span class="m-name">${esc(t.name)}</span>
      </div>`).join('')}
    ${extra}
  </div>`;

function renderTeamLocal() {
  const page = $('#page-team');
  const st = store.get();
  const team = store.currentTeam();
  const stats = store.weekStats(team.id);
  const memberIds = new Set(team.members.map((m) => m.id));
  if (teamFilter && !memberIds.has(teamFilter)) teamFilter = null;
  const teamTasks = st.tasks
    .filter((t) => t.teamId === team.id && (!teamFilter || t.assignee === teamFilter))
    .slice()
    .sort((a, b) => (a.done - b.done) || a.date.localeCompare(b.date))
    .slice(0, 30);
  const feed = st.feed.filter((f) => f.teamId === team.id);

  page.innerHTML = `
    <header class="page-head">
      <div class="eyebrow">${T('同舟共济', '团队协作')}</div>
      <h1 id="team-name">${esc(team.name)}</h1>
      <div class="sub">${st.teams.length} 个团队 · ${team.members.length} 位成员 · 轻触队名可改/解散 · 登录后可与真人组队</div>
    </header>

    ${teamChips(st.teams, team.id, `
      <div class="member-cell add-cell" id="add-team"><span class="big-avatar">+</span><span class="m-name">新团队</span></div>`)}

    <div class="member-strip">
      <div class="member-cell ${!teamFilter ? 'sel' : ''}" data-mid="">
        <span class="big-avatar" style="background:var(--ink)">众</span><span class="m-name">全部</span>
      </div>
      ${team.members.map((m) => `
        <div class="member-cell ${teamFilter === m.id ? 'sel' : ''}" data-mid="${m.id}">
          <span class="big-avatar" style="background:${m.color}">${esc(m.name[0])}</span>
          <span class="m-name">${esc(m.name)}</span>
        </div>`).join('')}
      <div class="member-cell add-cell" id="add-member">
        <span class="big-avatar">+</span><span class="m-name">添加</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><b>本周进度</b><span class="more">周一起算</span></div>
      ${stats.map(({ member, total, done }) => `
        <div class="stat-row">
          <span class="s-name">${avatar(member)}${esc(member.name)}</span>
          <span class="stat-bar"><i style="width:${total ? (done / total) * 100 : 0}%; background:${member.color}"></i></span>
          <span class="s-num">${done}/${total}</span>
        </div>`).join('')}
    </div>

    <div class="group-label">${teamFilter ? esc(store.memberOf(teamFilter, team.id).name) + ' 的任务' : '团队任务'}<span class="cnt">${teamTasks.length}</span></div>
    ${teamTasks.length ? teamTasks.map((t) => taskRow(t, { showTeam: false })).join('') : emptyBlock('和', '暂无任务<br>去「今日」页新建并指派给伙伴')}

    <div class="card">
      <div class="card-title"><b>团队动态</b></div>
      ${feed.slice(0, 8).map((f) => `
        <div class="feed-item">
          <div class="f-text"><b>${esc(f.who)}</b> ${esc(f.text)}</div>
          <div class="f-time">${relTime(f.ts)}</div>
        </div>`).join('') || '<div class="empty">还没有动态</div>'}
    </div>
  `;

  page.querySelectorAll('[data-tid]').forEach((c) => c.addEventListener('click', () => {
    store.setCurrentTeam(c.dataset.tid);
    teamFilter = null;
  }));
  $('#add-team', page).addEventListener('click', openAddTeamSheet);
  page.querySelectorAll('.member-cell[data-mid]').forEach((c) => c.addEventListener('click', () => {
    teamFilter = c.dataset.mid || null;
    renderTeam();
  }));
  $('#add-member', page).addEventListener('click', openAddMemberSheet);
  $('#team-name', page).addEventListener('click', openTeamNameSheet);
  bindTaskRows(page);
}

function openAddTeamSheet() {
  const sheet = openSheet(`
    <h2 class="sheet-title">新建团队</h2>
    <div class="field"><label>队名</label><input type="text" id="f-team" maxlength="12" placeholder="如：晨跑搭子"></div>
    <button class="btn btn-primary" id="f-tsave">建 队</button>
  `);
  $('#f-team', sheet).focus();
  $('#f-tsave', sheet).addEventListener('click', () => {
    const name = $('#f-team', sheet).value.trim();
    if (!name) { toast('给团队起个名字'); return; }
    store.addTeam(name);
    closeSheet();
    toast(`「${name}」建好了`);
  });
}

function openAddMemberSheet() {
  const sheet = openSheet(`
    <h2 class="sheet-title">添加成员</h2>
    <div class="field"><label>名字</label><input type="text" id="f-mname" maxlength="6" placeholder="如：林晚"></div>
    <p class="hint-text" style="margin:0 2px 14px;">本地模式的成员是"名牌"，方便指派与统计；登录后可邀请真实用户。</p>
    <button class="btn btn-primary" id="f-msave">${T('添入队中', '加入团队')}</button>
  `);
  const input = $('#f-mname', sheet);
  input.focus();
  $('#f-msave', sheet).addEventListener('click', () => {
    if (!input.value.trim()) { toast('名字不能为空'); return; }
    store.addMember(input.value);
    closeSheet();
    toast(`欢迎 ${input.value.trim()} 加入`);
  });
}

function openTeamNameSheet() {
  const team = store.currentTeam();
  const canRemove = store.teams().length > 1;
  const sheet = openSheet(`
    <h2 class="sheet-title">队名</h2>
    <div class="field"><input type="text" id="f-tname" maxlength="12" value="${esc(team.name)}"></div>
    <button class="btn btn-primary" id="f-tsave" style="margin-bottom:8px;">${T('改定', '保存')}</button>
    ${canRemove ? '<button class="btn btn-danger-line" id="f-tdel">解散这个团队</button>' : ''}
  `);
  $('#f-tsave', sheet).addEventListener('click', () => {
    store.renameTeam(team.id, $('#f-tname', sheet).value);
    closeSheet();
  });
  $('#f-tdel', sheet)?.addEventListener('click', () => {
    closeSheet();
    confirmSheet(`解散「${team.name}」？`, '该团队的任务与动态会一并删除。', () => { store.removeTeam(team.id); toast('已解散'); });
  });
}

/* —— 联机模式：zicodo 服务器团队 —— */
async function renderTeamOnline() {
  const page = $('#page-team');
  const my = api.currentUser();
  page.innerHTML = `
    <header class="page-head">
      <div class="eyebrow">${T('同舟共济', '团队协作')}</div>
      <h1>团队</h1>
      <div class="sub">联机模式 · ${esc(my?.nickname || my?.username || '')} · 邀请码与真人组队</div>
    </header>
    <div class="empty"><span class="e-glyph">候</span>正在取回你的团队…</div>`;

  try {
    if (!srvTeams) srvTeams = await api.listTeams();
  } catch (e) {
    page.querySelector('.empty').innerHTML = `<span class="e-glyph">断</span>${esc(e.message)}<br><button class="mini-btn" id="t-retry" style="margin-top:10px;">重试</button>`;
    $('#t-retry', page)?.addEventListener('click', () => { srvTeams = null; renderTeam(); });
    return;
  }
  if (current !== 'team') return;

  if (!srvTeams.length) {
    page.innerHTML = `
      <header class="page-head">
        <div class="eyebrow">${T('同舟共济', '团队协作')}</div>
        <h1>团队</h1>
        <div class="sub">联机模式 · 还没加入任何团队</div>
      </header>
      <div class="card" style="text-align:center; padding:28px 16px;">
        <div class="empty" style="padding:0 0 18px;"><span class="e-glyph">聚</span>建一个队，或用伙伴分享的 6 位邀请码加入</div>
        <button class="btn btn-primary" id="t-create" style="margin-bottom:10px;">创建团队</button>
        <button class="btn btn-ghost" id="t-join">输入邀请码加入</button>
      </div>`;
    $('#t-create', page).addEventListener('click', openSrvCreateSheet);
    $('#t-join', page).addEventListener('click', openSrvJoinSheet);
    return;
  }

  if (!srvSelected || !srvTeams.find((t) => t.id === srvSelected)) srvSelected = srvTeams[0].id;
  let team;
  try { team = await api.teamDetail(srvSelected); }
  catch { team = srvTeams.find((t) => t.id === srvSelected); }
  if (current !== 'team') return;
  const isLeader = team.leaderId === my?.id;
  const members = team.members || [];
  const maxPts = Math.max(1, ...members.map((m) => m.totalPoints || 0));

  page.innerHTML = `
    <header class="page-head">
      <div class="eyebrow">${T('同舟共济', '团队协作')}</div>
      <h1>${esc(team.name)}</h1>
      <div class="sub">联机模式 · ${members.length}/${team.maxMembers || 10} 人 · ${isLeader ? '你是组长' : '成员'}</div>
    </header>

    ${teamChips(srvTeams, srvSelected, `
      <div class="member-cell add-cell" id="srv-create"><span class="big-avatar">+</span><span class="m-name">建队</span></div>
      <div class="member-cell add-cell" id="srv-join"><span class="big-avatar">码</span><span class="m-name">加入</span></div>`)}

    <div class="card" style="display:flex; align-items:center; gap:14px;">
      <div style="flex:1;">
        <div class="card-title" style="margin-bottom:4px;"><b>邀请码</b></div>
        <div class="hint-text">把这串数字发给伙伴，TA 在「团队 → 加入」里输入即可</div>
      </div>
      <b id="invite-code" style="font-size:26px; letter-spacing:.18em; font-variant-numeric:tabular-nums; color:var(--seal-deep); cursor:pointer;">${esc(team.inviteCode || '——')}</b>
    </div>

    <div class="card">
      <div class="card-title"><b>成员</b><span class="more">按积分</span></div>
      ${members.slice().sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0)).map((m) => `
        <div class="stat-row">
          <span class="s-name" style="width:84px;"><span class="dot-avatar" style="background:${m.id === my?.id ? 'var(--seal)' : 'var(--cyan)'}; color:${m.id === my?.id ? 'var(--on-accent)' : '#fff'}">${esc((m.nickname || m.username || '?')[0])}</span>${esc(m.nickname || m.username)}</span>
          <span class="stat-bar"><i style="width:${((m.totalPoints || 0) / maxPts) * 100}%"></i></span>
          <span class="s-num">${m.totalPoints || 0}分${m.role === '组长' ? ' · 长' : ''}</span>
        </div>`).join('')}
    </div>

    <div class="card" id="rank-card">
      <div class="card-title"><b>团队排行</b><span class="more">全服 · 按总积分</span></div>
      <div class="hint-text">加载中…</div>
    </div>

    <button class="btn btn-danger-line" id="srv-leave" style="margin:4px 0 20px;">${isLeader ? '解散团队（组长退出即解散）' : '退出这个团队'}</button>
  `;

  page.querySelectorAll('[data-tid]').forEach((c) => c.addEventListener('click', () => { srvSelected = c.dataset.tid; renderTeam(); }));
  $('#srv-create', page).addEventListener('click', openSrvCreateSheet);
  $('#srv-join', page).addEventListener('click', openSrvJoinSheet);
  $('#invite-code', page).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(team.inviteCode); toast('邀请码已复制'); } catch { toast(`邀请码：${team.inviteCode}`); }
  });
  $('#srv-leave', page).addEventListener('click', () => confirmSheet(
    isLeader ? `解散「${team.name}」？` : `退出「${team.name}」？`,
    isLeader ? '你是组长：退出会解散整个团队，所有成员都会被移出。' : '之后可凭邀请码再加入。',
    async () => {
      try { await api.leaveTeam(team.id); srvTeams = null; srvSelected = null; renderTeam(); toast('已退出'); }
      catch (e) { toast(e.message); }
    }));
  api.teamRanking().then((list) => {
    const card = $('#rank-card', page);
    if (!card) return;
    card.innerHTML = `<div class="card-title"><b>团队排行</b><span class="more">全服 · 按总积分</span></div>`
      + (list || []).slice(0, 5).map((r) => `
        <div class="stat-row">
          <span class="s-name" style="width:auto; flex:1;">${r.rank}. ${esc(r.name)}${r.id === team.id ? ' ←' : ''}</span>
          <span class="s-num" style="width:auto;">${r.totalPoints || 0} 分 · ${r.memberCount}人</span>
        </div>`).join('');
  }).catch(() => { $('#rank-card', page)?.remove(); });
}

function openSrvCreateSheet() {
  const sheet = openSheet(`
    <h2 class="sheet-title">创建团队</h2>
    <div class="field"><label>队名</label><input type="text" id="f-sname" maxlength="20" placeholder="2~50 个字符"></div>
    <button class="btn btn-primary" id="f-screate">创 建</button>
  `);
  $('#f-sname', sheet).focus();
  $('#f-screate', sheet).addEventListener('click', async () => {
    const name = $('#f-sname', sheet).value.trim();
    if (name.length < 2) { toast('队名至少 2 个字'); return; }
    try {
      const team = await api.createTeam(name);
      srvTeams = null; srvSelected = team.id;
      closeSheet(); renderTeam();
      toast(`建好了，邀请码 ${team.inviteCode}`);
    } catch (e) { toast(e.message); }
  });
}

function openSrvJoinSheet() {
  const sheet = openSheet(`
    <h2 class="sheet-title">加入团队</h2>
    <div class="field"><label>6 位邀请码</label><input type="text" id="f-code" maxlength="6" inputmode="numeric" placeholder="向队长要一串 6 位数字"></div>
    <button class="btn btn-primary" id="f-join">加 入</button>
  `);
  $('#f-code', sheet).focus();
  $('#f-join', sheet).addEventListener('click', async () => {
    const code = $('#f-code', sheet).value.trim();
    if (!/^\d{6}$/.test(code)) { toast('邀请码是 6 位数字'); return; }
    try {
      const team = await api.joinTeam(code);
      srvTeams = null; srvSelected = team.id;
      closeSheet(); renderTeam();
      toast(`已加入「${team.name}」`);
    } catch (e) { toast(e.message); }
  });
}

/* ════════════════════════════ 我的 ══════════════════════════ */
function renderMe() {
  const page = $('#page-me');
  const st = store.get();
  const s = store.totalStats();
  const theme = st.settings.theme;

  page.innerHTML = `
    <header class="page-head">
      <div class="eyebrow">我的</div>
      <div class="me-head">
        <div class="me-avatar">${esc(st.profile.name[0] || '我')}</div>
        <div>
          <div class="me-name" id="me-name">${esc(st.profile.name)}</div>
          <div class="me-sub">${esc(st.profile.motto)} · 轻触名字可改</div>
        </div>
      </div>
    </header>

    <div class="card stat-trio">
      <div><b>${s.done}</b><span>累计完成</span></div>
      <div><b>${s.days}</b><span>${T('落笔之日', '活跃天数')}</span></div>
      <div><b>${st.teams.length}</b><span>${T('同行团队', '我的团队')}</span></div>
    </div>

    <div class="card cell-list">
      ${api.isAuthed() ? `
        <div class="cell" id="cell-account"><span class="c-icon">账</span><span class="c-label">${esc(api.currentUser()?.nickname || api.currentUser()?.username || '已登录')}</span><span class="c-value">联机模式 · 轻触管理</span><span class="c-go">›</span></div>
      ` : `
        <div class="cell" id="cell-account"><span class="c-icon">账</span><span class="c-label">登录 / 注册</span><span class="c-value">本地模式 · 登录后云同步</span><span class="c-go">›</span></div>
      `}
      <div class="cell" id="cell-notify"><span class="c-icon">铃</span><span class="c-label">提醒与通知</span><span class="c-value">${remind.permissionState() === 'granted' ? '已授权' : '应用内响铃'}</span><span class="c-go">›</span></div>
    </div>

    <div class="card">
      <div class="card-title"><b>界面风格</b></div>
      <div class="seg" id="style-seg">
        <button data-s="ink" class="${!isModern() ? 'on' : ''}">水墨 · 纸上</button>
        <button data-s="modern" class="${isModern() ? 'on' : ''}">现代 · 案头</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title"><b>外观</b></div>
      <div class="seg" id="theme-seg">
        <button data-t="auto" class="${theme === 'auto' ? 'on' : ''}">随系统</button>
        <button data-t="light" class="${theme === 'light' ? 'on' : ''}">${T('宣纸', '浅色')}</button>
        <button data-t="dark" class="${theme === 'dark' ? 'on' : ''}">${T('夜墨', '深色')}</button>
      </div>
    </div>

    <div class="card cell-list">
      <div class="cell" id="cell-ziling"><span class="c-icon">灵</span><span class="c-label">去看看字灵</span><span class="c-value">它知道你今天的日程</span><span class="c-go">›</span></div>
      <div class="cell" id="cell-zlset"><span class="c-icon">调</span><span class="c-label">字灵设置</span><span class="c-value">字体 · 字色 · AI</span><span class="c-go">›</span></div>
      <div class="cell" id="cell-export"><span class="c-icon">出</span><span class="c-label">导出数据</span><span class="c-value">JSON</span><span class="c-go">›</span></div>
      <div class="cell" id="cell-reseed"><span class="c-icon">还</span><span class="c-label">恢复示例数据</span><span class="c-go">›</span></div>
      <div class="cell danger" id="cell-clear"><span class="c-icon">空</span><span class="c-label">清空所有数据</span><span class="c-go">›</span></div>
    </div>

    <div class="card cell-list">
      <div class="cell" id="cell-about"><span class="c-icon">关</span><span class="c-label">关于字灵日程</span><span class="c-value">v1.0</span><span class="c-go">›</span></div>
    </div>
  `;

  $('#theme-seg', page).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    store.setTheme(b.dataset.t);
    applyTheme();
    renderMe();
  }));
  $('#style-seg', page).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    store.setUIStyle(b.dataset.s);
    applyTheme();
    renderMe();
  }));
  $('#cell-zlset', page).addEventListener('click', openZilingSettingsSheet);
  $('#cell-account', page).addEventListener('click', openAccountSheet);
  $('#cell-notify', page).addEventListener('click', openNotifySheet);
  $('#me-name', page).addEventListener('click', () => {
    const sheet = openSheet(`
      <h2 class="sheet-title">改个名字</h2>
      <div class="field"><label>名字</label><input type="text" id="f-pname" maxlength="8" value="${esc(st.profile.name)}"></div>
      <div class="field"><label>座右铭</label><input type="text" id="f-pmotto" maxlength="16" value="${esc(st.profile.motto)}"></div>
      <button class="btn btn-primary" id="f-psave">${T('就这样', '保存')}</button>
    `);
    $('#f-psave', sheet).addEventListener('click', () => {
      store.setProfile({ name: $('#f-pname', sheet).value.trim() || st.profile.name, motto: $('#f-pmotto', sheet).value.trim() || st.profile.motto });
      closeSheet();
    });
  });
  $('#cell-ziling', page).addEventListener('click', () => go('ziling'));
  $('#cell-export', page).addEventListener('click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `字灵日程-${store.todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('#cell-reseed', page).addEventListener('click', () => confirmSheet('恢复示例数据？', '会覆盖当前所有任务与成员。', () => { store.resetAll(true); toast('已恢复示例'); }));
  $('#cell-clear', page).addEventListener('click', () => confirmSheet('清空所有数据？', '任务、成员、动态都会被抹去，从一张白纸开始。', () => { store.resetAll(false); toast('纸已铺好，从头来过'); }));
  $('#cell-about', page).addEventListener('click', () => openSheet(`
    <h2 class="sheet-title">关于</h2>
    <p style="font-size:14px; line-height:1.9; color:var(--ink-2); margin:0 2px 18px;">
      <b style="color:var(--ink)">字灵日程</b>是一个把日程管理与「汉字精灵」结合的小应用：
      成百上千个汉字聚散成形，陪你看完今天的待办，给你鼓励与安慰。<br><br>
      · 数据只存在你的浏览器本地（localStorage）<br>
      · 中间的青瓷「灵」钮就是字灵的家：点它、拖它、双击它、和它说话<br>
      · 团队功能为本地演示，将来可接真实后端
    </p>
    <button class="btn btn-ghost" onclick="document.getElementById('scrim').click()">好的</button>
  `));
}

/* ── 账户（zicodo 登录注册）────────────────────────────────── */
function openAccountSheet() {
  if (api.isAuthed()) {
    const u = api.currentUser() || {};
    const sheet = openSheet(`
      <h2 class="sheet-title">账户</h2>
      <div class="cell-list" style="margin-bottom:14px;">
        <div class="cell"><span class="c-icon">名</span><span class="c-label">${esc(u.nickname || u.username)}</span><span class="c-value">@${esc(u.username || '')}</span></div>
        <div class="cell"><span class="c-icon">分</span><span class="c-label">总积分</span><span class="c-value">${u.totalPoints ?? 0}</span></div>
        <div class="cell"><span class="c-icon">服</span><span class="c-label">服务器</span><span class="c-value" style="max-width:170px; overflow:hidden; text-overflow:ellipsis;">${esc(api.getBase())}</span></div>
      </div>
      <button class="btn btn-primary" id="a-sync" style="margin-bottom:8px;">立即同步任务</button>
      <button class="btn btn-danger-line" id="a-logout">退出登录</button>
    `);
    $('#a-sync', sheet).addEventListener('click', async () => {
      try { await api.pullTasks(); closeSheet(); toast('已同步'); } catch (e) { toast(e.message); }
    });
    $('#a-logout', sheet).addEventListener('click', () => {
      api.logout(); srvTeams = null; srvSelected = null;
      closeSheet(); renderers[current]();
      toast('已退出，回到本地模式');
    });
    return;
  }

  const sheet = openSheet(`
    <h2 class="sheet-title">登录 zicodo</h2>
    <div class="field"><label>服务器地址</label>
      <input type="text" id="a-base" placeholder="https://你的服务器" value="${esc(api.getBase())}"></div>
    <div class="field"><label>用户名 / 邮箱</label><input type="text" id="a-user" maxlength="50" autocomplete="username"></div>
    <div class="field"><label>密码（注册需 ≥6 位）</label><input type="password" id="a-pass" maxlength="64" autocomplete="current-password"></div>
    <div class="field" id="a-nick-row" style="display:none;"><label>昵称（可选）</label><input type="text" id="a-nick" maxlength="20"></div>
    <button class="btn btn-primary" id="a-login" style="margin-bottom:8px;">登 录</button>
    <button class="btn btn-ghost" id="a-reg">还没账号？注册一个</button>
    <button class="btn btn-ghost" id="a-guest">游客一键体验（随机账号）</button>
    <p class="hint-text" style="margin:8px 2px 0;">不登录也能用：数据存在本机。登录后任务云同步、可与真人组队、字灵直连后端 AI。</p>
  `);
  let mode = 'login';
  const baseOf = () => $('#a-base', sheet).value.trim().replace(/\/$/, '');
  $('#a-reg', sheet).addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    $('#a-nick-row', sheet).style.display = mode === 'register' ? '' : 'none';
    $('#a-login', sheet).textContent = mode === 'register' ? '注 册' : '登 录';
    $('#a-reg', sheet).textContent = mode === 'register' ? '已有账号？去登录' : '还没账号？注册一个';
  });
  const finish = (u) => {
    srvTeams = null; srvSelected = null;
    closeSheet(); renderers[current]();
    toast(`欢迎，${u.nickname || u.username}`);
    api.pullTasks().catch(() => {});
  };
  $('#a-login', sheet).addEventListener('click', async () => {
    const base = baseOf();
    if (!/^https?:\/\//.test(base)) { toast('先填服务器地址（http/https）'); return; }
    api.setBase(base);
    const username = $('#a-user', sheet).value.trim();
    const password = $('#a-pass', sheet).value;
    if (!username || !password) { toast('用户名和密码都要填'); return; }
    try {
      const u = mode === 'register'
        ? await api.register({ username, password, nickname: $('#a-nick', sheet).value.trim() })
        : await api.login({ username, password });
      finish(u);
    } catch (e) { toast(e.message); }
  });
  $('#a-guest', sheet).addEventListener('click', async () => {
    const base = baseOf();
    if (!/^https?:\/\//.test(base)) { toast('先填服务器地址（http/https）'); return; }
    api.setBase(base);
    try { finish(await api.autoLogin()); } catch (e) { toast(e.message); }
  });
}

/* ── 提醒与通知设置 ─────────────────────────────────────────── */
function openNotifySheet() {
  const st = store.get();
  const perm = remind.permissionState();
  const permText = { granted: '已授权（后台也能弹通知）', denied: '已被拒绝（去浏览器设置里开启）', default: '未授权', unsupported: '当前环境不支持' }[perm];
  const sheet = openSheet(`
    <h2 class="sheet-title">提醒与通知</h2>
    <div class="field"><label>提醒声音</label>
      <div class="inline-row"><div class="toggle ${st.settings.remindSound ? 'on' : ''}" id="n-sound"></div>
      <span class="hint-text grow">到点响一段青瓷三连音</span></div></div>
    <div class="field"><label>系统通知</label>
      <div class="inline-row">
        <button class="mini-btn" id="n-perm" ${perm === 'granted' || perm === 'unsupported' ? 'disabled' : ''}>申请授权</button>
        <span class="hint-text grow">${permText}</span>
      </div></div>
    <p class="hint-text" style="margin:4px 2px 14px;">提醒在新建/编辑任务时按条开启（需选时间）。说明：网页应用在进程被杀后无法响铃；添加到主屏幕并保持后台可大幅提高可靠性。</p>
    <button class="btn btn-ghost" id="n-done">好的</button>
  `);
  $('#n-sound', sheet).addEventListener('click', (e) => {
    e.target.classList.toggle('on');
    store.setRemindSound(e.target.classList.contains('on'));
  });
  $('#n-perm', sheet).addEventListener('click', async () => {
    const r = await remind.requestPermission();
    toast(r === 'granted' ? '已授权' : '未授权');
    closeSheet();
  });
  $('#n-done', sheet).addEventListener('click', closeSheet);
}

/* ── 字灵设置（融合自字灵页原内建设置面板）──────────────────────
 * 写的就是字灵自己的 localStorage 键（同源共享），改完通知 iframe 重放设置即时生效。
 * 「外观深浅」不在此列：嵌入模式下字灵的底色/字色整体跟随 App 主题与调色板。
 * 键名与 js/ui/settings.js、js/ai/bridge.js 保持一致。 */
const ZLS = {
  font: 'ziling.theme.font', color: 'ziling.theme.color', fx: 'ziling.theme.fx',
  scale: 'ziling.origin.scale', persona: 'ziling.persona', memory: 'ziling.memory',
  key: 'ziling.deepseek.key',
};
const ZL_FONTS = [
  { label: '黑体', css: '"PingFang SC", "Microsoft YaHei", "Heiti SC", sans-serif' },
  { label: '宋体', css: '"Songti SC", "SimSun", "STSong", serif' },
  { label: '楷体', css: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
  { label: '圆体', css: '"Yuanti SC", "Microsoft YaHei", sans-serif' },
];
const ZL_FX = [{ label: '无', v: 'none' }, { label: '呼吸渐变', v: 'breathe' }, { label: '炫彩', v: 'rainbow' }];
const lsGet = (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { v == null || v === '' ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* */ } };

function openZilingSettingsSheet() {
  const cur = {
    font: lsGet(ZLS.font, ZL_FONTS[0].css),
    color: lsGet(ZLS.color),
    fx: lsGet(ZLS.fx, 'none'),
    scale: parseFloat(lsGet(ZLS.scale, '1')) || 1,
    persona: lsGet(ZLS.persona),
    memory: lsGet(ZLS.memory) !== '0',
    hasKey: !!lsGet(ZLS.key),
  };
  const sheet = openSheet(`
    <h2 class="sheet-title">字灵设置</h2>
    <div class="field"><label>里字字体</label>
      <div class="pick-row" id="z-fonts">
        ${ZL_FONTS.map((f) => `<button class="pick ${cur.font === f.css ? 'on' : ''}" data-v="${esc(f.css)}">${f.label}</button>`).join('')}
      </div></div>
    <div class="field"><label>字色</label>
      <div class="inline-row">
        <input type="color" id="z-color" value="${cur.color || '#888888'}">
        <button class="mini-btn" id="z-color-reset">跟随主题</button>
        <span class="hint-text grow" id="z-color-state">${cur.color ? '自定义中' : '跟随主题'}</span>
      </div></div>
    <div class="field"><label>字色特效</label>
      <div class="pick-row" id="z-fx">
        ${ZL_FX.map((f) => `<button class="pick ${cur.fx === f.v ? 'on' : ''}" data-v="${f.v}">${f.label}</button>`).join('')}
      </div></div>
    <div class="field"><label>原态字号 <span id="z-scale-val">${cur.scale.toFixed(2)}×</span></label>
      <input type="range" id="z-scale" min="0.7" max="1.6" step="0.05" value="${cur.scale}"></div>
    <div class="field"><label>AI 风格（人设）</label>
      <input type="text" id="z-persona" maxlength="40" placeholder="如：温柔 / 俏皮 / 古典文艺" value="${esc(cur.persona)}"></div>
    <div class="field"><label>AI 记忆（带上下文对话）</label>
      <div class="inline-row"><div class="toggle ${cur.memory ? 'on' : ''}" id="z-memory"></div>
      <span class="hint-text grow">关闭后每句话都是新的开始</span></div></div>
    <div class="field"><label>API Key（仅存本机，不上传）</label>
      <div class="inline-row">
        <input type="password" id="z-key" class="grow" placeholder="${cur.hasKey ? '已存（本机）' : 'DeepSeek key（可不填，用内置演示）'}" style="width:100%">
        <button class="mini-btn" id="z-key-save">存</button>
        <button class="mini-btn" id="z-key-clear">清</button>
      </div></div>
    <p class="hint-text">字灵的底色与深浅跟随 App 的「外观」与「界面风格」；改动即时生效。</p>
    <button class="btn btn-ghost" id="z-done" style="margin-top:6px;">完成</button>
  `);

  const apply = () => refreshZilingSettings();
  const wirePicks = (id, save) => $(id, sheet).querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => {
    $(id, sheet).querySelectorAll('.pick').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    save(b.dataset.v);
    apply();
  }));
  wirePicks('#z-fonts', (v) => lsSet(ZLS.font, v));
  wirePicks('#z-fx', (v) => lsSet(ZLS.fx, v === 'none' ? '' : v));

  $('#z-color', sheet).addEventListener('input', (e) => {
    lsSet(ZLS.color, e.target.value);
    $('#z-color-state', sheet).textContent = '自定义中';
    apply();
  });
  $('#z-color-reset', sheet).addEventListener('click', () => {
    lsSet(ZLS.color, '');
    $('#z-color-state', sheet).textContent = '跟随主题';
    apply();
  });
  $('#z-scale', sheet).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    $('#z-scale-val', sheet).textContent = `${v.toFixed(2)}×`;
    lsSet(ZLS.scale, String(v));
    apply();
  });
  $('#z-persona', sheet).addEventListener('change', (e) => { lsSet(ZLS.persona, e.target.value.trim()); apply(); });
  $('#z-memory', sheet).addEventListener('click', (e) => {
    e.target.classList.toggle('on');
    lsSet(ZLS.memory, e.target.classList.contains('on') ? '1' : '0');
    apply();
  });
  $('#z-key-save', sheet).addEventListener('click', () => {
    const v = $('#z-key', sheet).value.trim();
    if (!v) { toast('先填入 key'); return; }
    lsSet(ZLS.key, v);
    $('#z-key', sheet).value = '';
    $('#z-key', sheet).placeholder = '已存（本机）';
    apply();
    toast('已存到本机');
  });
  $('#z-key-clear', sheet).addEventListener('click', () => {
    lsSet(ZLS.key, '');
    $('#z-key', sheet).placeholder = 'DeepSeek key（可不填，用内置演示）';
    apply();
    toast('已清除');
  });
  $('#z-done', sheet).addEventListener('click', closeSheet);
}

function confirmSheet(title, desc, onYes) {
  const sheet = openSheet(`
    <h2 class="sheet-title">${esc(title)}</h2>
    <p style="font-size:13.5px; color:var(--ink-2); margin:0 2px 18px; line-height:1.7;">${esc(desc)}</p>
    <button class="btn btn-danger-line" id="c-yes" style="margin-bottom:8px;">确定</button>
    <button class="btn btn-ghost" id="c-no">再想想</button>
  `);
  $('#c-yes', sheet).addEventListener('click', () => { closeSheet(); onYes(); });
  $('#c-no', sheet).addEventListener('click', closeSheet);
}

/* ═══════════════════ 新建 / 编辑 / 详情 抽屉 ═══════════════════ */
function openTaskSheet(editing = null) {
  const st = store.get();
  const defDate = current === 'calendar' ? calSelected : store.todayStr();
  const t = editing || { title: '', date: defDate, time: '', tag: 'work', assignee: 'me', teamId: st.currentTeamId, remind: false };
  let teamId = t.teamId || st.currentTeamId;

  const sheet = openSheet(`
    <h2 class="sheet-title">${editing ? T('改一改', '编辑任务') : T('落一笔', '新建任务')}</h2>
    <div class="field"><label>${T('要做的事', '任务内容')}</label>
      <input type="text" id="f-title" maxlength="40" placeholder="${T('写下一件具体的小事…', '输入任务内容…')}" value="${esc(t.title)}"></div>
    <div class="field-row">
      <div class="field"><label>日期</label><input type="date" id="f-date" value="${t.date}"></div>
      <div class="field"><label>时间（可空）</label><input type="time" id="f-time" value="${t.time}"></div>
    </div>
    <div class="field"><label>准点提醒</label>
      <div class="inline-row">
        <div class="toggle ${t.remind ? 'on' : ''}" id="f-remind"></div>
        <span class="hint-text grow" id="f-remind-hint">${t.time ? '到点响铃提醒（应用开启时）' : '先选一个时间，才能提醒'}</span>
      </div></div>
    <div class="field"><label>标签</label>
      <div class="pick-row" id="f-tags">
        ${store.TAGS.map((g) => `<button class="pick ${t.tag === g.id ? 'on' : ''}" data-v="${g.id}">${g.name}</button>`).join('')}
      </div></div>
    <div class="field"><label>团队</label>
      <div class="pick-row" id="f-team">
        ${st.teams.map((x) => `<button class="pick ${teamId === x.id ? 'on' : ''}" data-v="${x.id}">${esc(x.name)}</button>`).join('')}
      </div></div>
    <div class="field"><label>${T('交给谁', '负责人')}</label>
      <div class="pick-row" id="f-who"></div></div>
    <button class="btn btn-primary" id="f-save">${editing ? T('改定', '保存') : T('落笔', '创建')}</button>
  `);

  let tag = t.tag, who = t.assignee, remindOn = !!t.remind;
  const wirePicks = (id, set) => $(id, sheet).querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => {
    $(id, sheet).querySelectorAll('.pick').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    set(b.dataset.v);
  }));
  // 负责人列表随所选团队联动重建
  const renderWho = () => {
    const team = st.teams.find((x) => x.id === teamId) || st.teams[0];
    if (!team.members.find((m) => m.id === who)) who = 'me';
    $('#f-who', sheet).innerHTML = team.members
      .map((m) => `<button class="pick ${who === m.id ? 'on' : ''}" data-v="${m.id}">${avatar(m)}${esc(m.name)}</button>`).join('');
    wirePicks('#f-who', (v) => (who = v));
  };
  renderWho();
  wirePicks('#f-tags', (v) => (tag = v));
  wirePicks('#f-team', (v) => { teamId = v; renderWho(); });

  const remindToggle = $('#f-remind', sheet);
  const timeInput = $('#f-time', sheet);
  remindToggle.addEventListener('click', async () => {
    if (!timeInput.value) { toast('先选一个时间'); return; }
    remindOn = !remindOn;
    remindToggle.classList.toggle('on', remindOn);
    if (remindOn) {
      const p = await remind.requestPermission();
      $('#f-remind-hint', sheet).textContent = p === 'granted' ? '到点响铃 + 系统通知' : '到点响铃提醒（应用开启时）';
    }
  });
  timeInput.addEventListener('input', () => {
    if (!timeInput.value) { remindOn = false; remindToggle.classList.remove('on'); }
    $('#f-remind-hint', sheet).textContent = timeInput.value ? '到点响铃提醒（应用开启时）' : '先选一个时间，才能提醒';
  });

  const titleInput = $('#f-title', sheet);
  if (!editing) titleInput.focus();

  $('#f-save', sheet).addEventListener('click', () => {
    const title = titleInput.value.trim();
    if (!title) { toast('总得写点什么'); titleInput.focus(); return; }
    const data = { title, date: $('#f-date', sheet).value || store.todayStr(), time: timeInput.value, tag, assignee: who, teamId, remind: remindOn && !!timeInput.value };
    if (editing) { store.updateTask(editing.id, data); toast(T('已改定', '已保存')); }
    else { store.addTask(data); toast(T('已落笔', '已创建')); }
    closeSheet();
  });
}

function openTaskDetail(id) {
  const t = store.get().tasks.find((x) => x.id === id);
  if (!t) return;
  const m = store.memberOf(t.assignee, t.teamId);
  const team = store.teamOf(t);
  const tag = store.TAGS.find((x) => x.id === t.tag);
  const dateLabel = new Date(t.date + 'T00:00:00').toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

  const sheet = openSheet(`
    <h2 class="sheet-title" style="margin-bottom:8px;">${esc(t.title)}</h2>
    <div class="t-meta" style="margin: 0 2px 16px;">
      <span class="chip">${dateLabel}</span>
      ${t.time ? `<span class="chip time">${esc(t.time)}${t.remind ? ' ⏰' : ''}</span>` : ''}
      ${tag ? `<span class="chip ${tag.cls}">${tag.name}</span>` : ''}
      ${team ? `<span class="chip">${esc(team.name)}</span>` : ''}
      <span class="chip">${esc(m.name)}</span>
    </div>
    <div class="action-grid">
      <button id="d-done"><span class="a-glyph">${t.done ? '回' : '成'}</span>${t.done ? '撤销完成' : '完成'}</button>
      <button id="d-delay" class="warm"><span class="a-glyph">${t.delayed ? '启' : '搁'}</span>${t.delayed ? '重新拾起' : '先搁置'}</button>
      <button id="d-tomorrow"><span class="a-glyph">明</span>顺延一天</button>
      <button id="d-edit"><span class="a-glyph">改</span>编辑</button>
    </div>
    <button class="btn btn-ghost" id="d-del" style="color:var(--danger); margin-top:14px;">删除这件事</button>
  `);
  $('#d-done', sheet).addEventListener('click', () => { const r = store.toggleDone(id); closeSheet(); if (r?.done) toast(T('完成一件，墨迹又添一笔 ✦', '已完成 ✓')); });
  $('#d-delay', sheet).addEventListener('click', () => { store.toggleDelayed(id); closeSheet(); });
  $('#d-tomorrow', sheet).addEventListener('click', () => { store.moveToTomorrow(id); closeSheet(); toast('已顺延到明天'); });
  $('#d-edit', sheet).addEventListener('click', () => openTaskSheet(t));
  $('#d-del', sheet).addEventListener('click', () => { store.removeTask(id); closeSheet(); toast('已删去'); });
}

/* ── 首次进入 · 界面风格选择 ────────────────────────────────── */
function showStylePick() {
  const el = document.createElement('div');
  el.id = 'style-pick';
  el.innerHTML = `
    <div class="sp-eyebrow">初 次 见 面</div>
    <h2>选一种你喜欢的样子</h2>
    <div class="sp-sub">两种气质，同一副筋骨；之后随时可在「我的」里更换。</div>
    <div class="style-card" data-s="ink">
      <span class="sc-preview ink-mini">
        <span class="pv-head">六月十日</span><span class="pv-seal"></span>
        <span class="pv-line" style="top:38px"></span><span class="pv-line" style="top:60px"></span><span class="pv-line" style="top:82px; right:34px"></span>
      </span>
      <span class="sc-text">
        <span class="sc-name">水墨 · 纸上</span>
        <span class="sc-desc">宣纸、墨色与青瓷印，<br>把日子过成诗。</span>
      </span>
      <span class="sc-go">›</span>
    </div>
    <div class="style-card" data-s="modern">
      <span class="sc-preview modern-mini">
        <span class="pv-head">6月10日</span><span class="pv-seal"></span>
        <span class="pv-line" style="top:38px"></span><span class="pv-line" style="top:60px"></span><span class="pv-line" style="top:82px; right:34px"></span>
      </span>
      <span class="sc-text">
        <span class="sc-name">现代 · 案头</span>
        <span class="sc-desc">利落的灰白与青瓷绿，<br>像一件称手的办公软件。</span>
      </span>
      <span class="sc-go">›</span>
    </div>
    <div class="sp-note">字灵在两种风格里都会陪着你</div>`;
  $('#phone').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  el.querySelectorAll('.style-card').forEach((c) => c.addEventListener('click', () => {
    store.setUIStyle(c.dataset.s);
    applyTheme();
    renderers[current]();
    el.classList.add('out');
    setTimeout(() => el.remove(), 520);
  }));
}

/* ── 闹钟卡片（提醒到点时从顶部落下） ─────────────────────────── */
function showAlarm(task) {
  document.querySelector('.alarm-card')?.remove();
  const el = document.createElement('div');
  el.className = 'alarm-card';
  el.innerHTML = `
    <span class="seal-avatar" style="width:38px;height:38px;font-size:20px;flex:none;">铃</span>
    <div class="a-body">
      <i>${esc(task.time)} · 到点了</i>
      <p>${esc(task.title)}</p>
    </div>
    <div class="a-actions">
      <button data-a="done">完成</button>
      <button data-a="snooze">+10分</button>
      <button data-a="ok">知道了</button>
    </div>`;
  $('#phone').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 350); };
  el.querySelector('[data-a="done"]').addEventListener('click', () => { store.toggleDone(task.id); close(); toast(T('完成一件，墨迹又添一笔 ✦', '已完成 ✓')); });
  el.querySelector('[data-a="snooze"]').addEventListener('click', () => { remind.snooze(task.id, 10); close(); toast('10 分钟后再提醒'); });
  el.querySelector('[data-a="ok"]').addEventListener('click', close);
  setTimeout(() => { if (el.isConnected) close(); }, 30000);
}

/* ── 启动 ─────────────────────────────────────────────────── */
store.setSync(api.syncHandler);                 // 登录后任务操作镜像到 zicodo
api.restoreSession().then((user) => { if (user && current !== 'ziling') renderers[current](); });
remind.init({ onFire: showAlarm });             // 任务提醒/闹钟
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
go('today');
// 字灵 iframe 懒加载：首次切到「灵」页时才唤醒，让用户亲眼看到它的苏醒动画。
playSplash({ onDone: () => { if (!store.get().settings.uiStyle) showStylePick(); } });
