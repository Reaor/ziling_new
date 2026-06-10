/**
 * 字灵日程 · App 外壳总控
 * 五页：今日 / 日历 / 灵（字灵宠物页 iframe）/ 团队 / 我的。
 * 数据在 store.js（localStorage 真持久化）；日程实时喂给字灵（postMessage）。
 */

import * as store from './store.js';
import { playSplash } from './splash.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

store.load();

/* ── 主题 ─────────────────────────────────────────────────── */
const mqDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = store.get().settings.theme;
  const mode = pref === 'auto' ? (mqDark.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = mode;
  $('meta[name="theme-color"]').content = mode === 'dark' ? '#17161a' : '#f6f2e9';
}
mqDark.addEventListener('change', applyTheme);
applyTheme();

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

function taskRow(t) {
  const tag = store.TAGS.find((x) => x.id === t.tag);
  const m = store.memberOf(t.assignee);
  const overdue = !t.done && t.date < store.todayStr();
  return `<div class="task ${t.done ? 'done' : ''} ${t.delayed || overdue ? 'delayed' : ''}" data-id="${t.id}">
    <span class="tick" data-act="tick">✓</span>
    <div class="t-main">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">
        ${t.time ? `<span class="chip time">${esc(t.time)}</span>` : ''}
        ${tag ? `<span class="chip ${tag.cls}">${tag.name}</span>` : ''}
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
        if (t?.done) toast('完成一件，墨迹又添一笔 ✦');
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

  const R = 40, C = 2 * Math.PI * R;
  page.innerHTML = `
    <header class="page-head">
      <div class="eyebrow">${weekText} · ${esc(store.get().profile.motto)}</div>
      <h1>${dateText}</h1>
    </header>

    <div class="card overview">
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
    </div>

    <div class="card ziling-note" id="go-ziling">
      <span class="seal-avatar">灵</span>
      <div class="note-body"><i>字 灵 寄 语</i><p>${zilingQuote(v)}</p></div>
      <span class="go">›</span>
    </div>

    ${v.doing.length ? `<div class="group-label">进 行 中<span class="cnt">${v.doing.length}</span></div>${v.doing.map(taskRow).join('')}` : ''}
    ${v.delayed.length ? `<div class="group-label">搁 置 / 逾 期<span class="cnt">${v.delayed.length}</span></div>${v.delayed.map(taskRow).join('')}` : ''}
    ${v.done.length ? `<div class="group-label">已 完 成<span class="cnt">${v.done.length}</span></div>${v.done.map(taskRow).join('')}` : ''}
    ${total === 0 ? emptyBlock('閒', '今日无事<br>点右下角，落下今天第一笔') : ''}
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
      <div class="eyebrow">日 历</div>
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
    ${selTasks.length ? selTasks.map(taskRow).join('') : emptyBlock('白', '这一天还是留白<br>点右下角为它写点什么')}
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
let zilingFrame = null;

function openZiling() {
  if (!zilingFrame) {
    zilingFrame = document.createElement('iframe');
    zilingFrame.title = '字灵 · 汉字精灵';
    zilingFrame.allow = 'clipboard-write';
    // 通过 URL 直接带上当日日程，iframe 一加载字灵就会播报；后续更新走 postMessage。
    zilingFrame.src = `ziling.html?schedule=${encodeURIComponent(JSON.stringify(store.zilingPayload()))}`;
    zilingFrame.addEventListener('load', () => {
      $('#ziling-loading')?.remove();
      feedZiling();
    });
    $('#ziling-stage').appendChild(zilingFrame);
  } else {
    feedZiling();
  }
}

let feedTimer = null;
function feedZiling() {
  if (!zilingFrame?.contentWindow) return;
  clearTimeout(feedTimer);
  feedTimer = setTimeout(() => {
    try { zilingFrame.contentWindow.postMessage({ type: 'ziling:schedule', payload: store.zilingPayload() }, '*'); } catch { /* iframe 未就绪时忽略 */ }
  }, 400);
}

/* ════════════════════════════ 团队 ══════════════════════════ */
let teamFilter = null;   // 按成员过滤任务；null = 全部

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function renderTeam() {
  const page = $('#page-team');
  const st = store.get();
  const stats = store.weekStats();
  const teamTasks = st.tasks
    .filter((t) => !teamFilter || t.assignee === teamFilter)
    .slice()
    .sort((a, b) => (a.done - b.done) || a.date.localeCompare(b.date))
    .slice(0, 30);

  page.innerHTML = `
    <header class="page-head">
      <div class="eyebrow">同 舟 共 济</div>
      <h1 id="team-name">${esc(st.teamName)}</h1>
      <div class="sub">${st.members.length} 位成员 · 轻触队名可改 · 任务可指派给任何人</div>
    </header>

    <div class="member-strip">
      <div class="member-cell ${!teamFilter ? 'sel' : ''}" data-mid="">
        <span class="big-avatar" style="background:var(--ink)">众</span><span class="m-name">全部</span>
      </div>
      ${st.members.map((m) => `
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

    <div class="group-label">${teamFilter ? esc(store.memberOf(teamFilter).name) + ' 的任务' : '团 队 任 务'}<span class="cnt">${teamTasks.length}</span></div>
    ${teamTasks.length ? teamTasks.map(taskRow).join('') : emptyBlock('和', '暂无任务<br>去「今日」页新建并指派给伙伴')}

    <div class="card">
      <div class="card-title"><b>团队动态</b></div>
      ${st.feed.slice(0, 8).map((f) => `
        <div class="feed-item">
          <div class="f-text"><b>${esc(f.who)}</b> ${esc(f.text)}</div>
          <div class="f-time">${relTime(f.ts)}</div>
        </div>`).join('') || '<div class="empty">还没有动态</div>'}
    </div>
  `;

  page.querySelectorAll('.member-cell[data-mid]').forEach((c) => c.addEventListener('click', () => {
    teamFilter = c.dataset.mid || null;
    renderTeam();
  }));
  $('#add-member', page).addEventListener('click', openAddMemberSheet);
  $('#team-name', page).addEventListener('click', openTeamNameSheet);
  bindTaskRows(page);
}

function openAddMemberSheet() {
  const sheet = openSheet(`
    <h2 class="sheet-title">添加成员</h2>
    <div class="field"><label>名 字</label><input type="text" id="f-mname" maxlength="6" placeholder="如：林晚"></div>
    <button class="btn btn-primary" id="f-msave">添 入 队 中</button>
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
  const sheet = openSheet(`
    <h2 class="sheet-title">队名</h2>
    <div class="field"><input type="text" id="f-tname" maxlength="12" value="${esc(store.get().teamName)}"></div>
    <button class="btn btn-primary" id="f-tsave">改 定</button>
  `);
  $('#f-tsave', sheet).addEventListener('click', () => {
    store.setTeamName($('#f-tname', sheet).value);
    closeSheet();
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
      <div class="eyebrow">我 的</div>
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
      <div><b>${s.days}</b><span>落笔之日</span></div>
      <div><b>${st.members.length}</b><span>同行伙伴</span></div>
    </div>

    <div class="card">
      <div class="card-title"><b>外观</b></div>
      <div class="seg" id="theme-seg">
        <button data-t="auto" class="${theme === 'auto' ? 'on' : ''}">随系统</button>
        <button data-t="light" class="${theme === 'light' ? 'on' : ''}">宣纸</button>
        <button data-t="dark" class="${theme === 'dark' ? 'on' : ''}">夜墨</button>
      </div>
    </div>

    <div class="card cell-list">
      <div class="cell" id="cell-ziling"><span class="c-icon">灵</span><span class="c-label">去看看字灵</span><span class="c-value">它知道你今天的日程</span><span class="c-go">›</span></div>
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
  $('#me-name', page).addEventListener('click', () => {
    const sheet = openSheet(`
      <h2 class="sheet-title">改个名字</h2>
      <div class="field"><label>名 字</label><input type="text" id="f-pname" maxlength="8" value="${esc(st.profile.name)}"></div>
      <div class="field"><label>座 右 铭</label><input type="text" id="f-pmotto" maxlength="16" value="${esc(st.profile.motto)}"></div>
      <button class="btn btn-primary" id="f-psave">就 这 样</button>
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
      · 中间的朱砂「灵」钮就是字灵的家：点它、拖它、双击它、和它说话<br>
      · 团队功能为本地演示，将来可接真实后端
    </p>
    <button class="btn btn-ghost" onclick="document.getElementById('scrim').click()">好 的</button>
  `));
}

function confirmSheet(title, desc, onYes) {
  const sheet = openSheet(`
    <h2 class="sheet-title">${esc(title)}</h2>
    <p style="font-size:13.5px; color:var(--ink-2); margin:0 2px 18px; line-height:1.7;">${esc(desc)}</p>
    <button class="btn btn-danger-line" id="c-yes" style="margin-bottom:8px;">确 定</button>
    <button class="btn btn-ghost" id="c-no">再想想</button>
  `);
  $('#c-yes', sheet).addEventListener('click', () => { closeSheet(); onYes(); });
  $('#c-no', sheet).addEventListener('click', closeSheet);
}

/* ═══════════════════ 新建 / 编辑 / 详情 抽屉 ═══════════════════ */
function openTaskSheet(editing = null) {
  const st = store.get();
  const defDate = current === 'calendar' ? calSelected : store.todayStr();
  const t = editing || { title: '', date: defDate, time: '', tag: 'work', assignee: 'me' };

  const sheet = openSheet(`
    <h2 class="sheet-title">${editing ? '改一改' : '落 一 笔'}</h2>
    <div class="field"><label>要 做 的 事</label>
      <input type="text" id="f-title" maxlength="40" placeholder="写下一件具体的小事…" value="${esc(t.title)}"></div>
    <div class="field-row">
      <div class="field"><label>日 期</label><input type="date" id="f-date" value="${t.date}"></div>
      <div class="field"><label>时 间（可空）</label><input type="time" id="f-time" value="${t.time}"></div>
    </div>
    <div class="field"><label>标 签</label>
      <div class="pick-row" id="f-tags">
        ${store.TAGS.map((g) => `<button class="pick ${t.tag === g.id ? 'on' : ''}" data-v="${g.id}">${g.name}</button>`).join('')}
      </div></div>
    <div class="field"><label>交 给 谁</label>
      <div class="pick-row" id="f-who">
        ${st.members.map((m) => `<button class="pick ${t.assignee === m.id ? 'on' : ''}" data-v="${m.id}">${avatar(m)}${esc(m.name)}</button>`).join('')}
      </div></div>
    <button class="btn btn-primary" id="f-save">${editing ? '改 定' : '落 笔'}</button>
  `);

  let tag = t.tag, who = t.assignee;
  const wirePicks = (id, set) => $(id, sheet).querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => {
    $(id, sheet).querySelectorAll('.pick').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    set(b.dataset.v);
  }));
  wirePicks('#f-tags', (v) => (tag = v));
  wirePicks('#f-who', (v) => (who = v));
  const titleInput = $('#f-title', sheet);
  if (!editing) titleInput.focus();

  $('#f-save', sheet).addEventListener('click', () => {
    const title = titleInput.value.trim();
    if (!title) { toast('总得写点什么'); titleInput.focus(); return; }
    const data = { title, date: $('#f-date', sheet).value || store.todayStr(), time: $('#f-time', sheet).value, tag, assignee: who };
    if (editing) { store.updateTask(editing.id, data); toast('已改定'); }
    else { store.addTask(data); toast('已落笔'); }
    closeSheet();
  });
}

function openTaskDetail(id) {
  const t = store.get().tasks.find((x) => x.id === id);
  if (!t) return;
  const m = store.memberOf(t.assignee);
  const tag = store.TAGS.find((x) => x.id === t.tag);
  const dateLabel = new Date(t.date + 'T00:00:00').toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

  const sheet = openSheet(`
    <h2 class="sheet-title" style="margin-bottom:8px;">${esc(t.title)}</h2>
    <div class="t-meta" style="margin: 0 2px 16px;">
      <span class="chip">${dateLabel}</span>
      ${t.time ? `<span class="chip time">${esc(t.time)}</span>` : ''}
      ${tag ? `<span class="chip ${tag.cls}">${tag.name}</span>` : ''}
      <span class="chip">${esc(m.name)}</span>
    </div>
    <div class="action-grid">
      <button id="d-done"><span class="a-glyph">${t.done ? '回' : '成'}</span>${t.done ? '撤销完成' : '完成'}</button>
      <button id="d-delay" class="warm"><span class="a-glyph">${t.delayed ? '启' : '搁'}</span>${t.delayed ? '重新拾起' : '先搁置'}</button>
      <button id="d-tomorrow"><span class="a-glyph">明</span>顺延一天</button>
      <button id="d-edit"><span class="a-glyph">改</span>编辑</button>
    </div>
    <button class="btn btn-ghost" id="d-del" style="color:var(--seal); margin-top:14px;">删除这件事</button>
  `);
  $('#d-done', sheet).addEventListener('click', () => { const r = store.toggleDone(id); closeSheet(); if (r?.done) toast('完成一件，墨迹又添一笔 ✦'); });
  $('#d-delay', sheet).addEventListener('click', () => { store.toggleDelayed(id); closeSheet(); });
  $('#d-tomorrow', sheet).addEventListener('click', () => { store.moveToTomorrow(id); closeSheet(); toast('已顺延到明天'); });
  $('#d-edit', sheet).addEventListener('click', () => openTaskSheet(t));
  $('#d-del', sheet).addEventListener('click', () => { store.removeTask(id); closeSheet(); toast('已删去'); });
}

/* ── 启动 ─────────────────────────────────────────────────── */
go('today');
// 字灵 iframe 懒加载：首次切到「灵」页时才唤醒，让用户亲眼看到它的苏醒动画。
playSplash({ onDone: () => {} });
