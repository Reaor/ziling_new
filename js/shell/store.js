/**
 * 字灵日程 · 数据层 v2
 * localStorage 持久化：多团队 / 任务(含提醒) / 团队动态 / 个人资料 / 偏好。
 * 纯前端可用（静态部署即真实可用）；登录后由 api.js 同步到 zicodo 后端，本层仍是 UI 的事实来源。
 * v1 → v2 迁移：单团队(teamName+members) 包装成 teams[0]，任务补 teamId。
 */

const KEY = 'zlapp.v1';

/** 成员印章配色（青瓷主色领衔，其余取耐看的矿物色，保证头像区分度） */
export const MEMBER_COLORS = ['#569b86', '#3d6470', '#9a7b2d', '#6c5b8f', '#a4604f', '#41698c', '#4a7c59', '#8a6d3b'];

export const TAGS = [
  { id: 'work',  name: '工作', cls: 'tag-work' },
  { id: 'study', name: '学习', cls: 'tag-study' },
  { id: 'life',  name: '生活', cls: 'tag-life' },
];

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export const todayStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 首次进入的示例数据：让部署后的页面"一打开就活着"，全部可改可删。 */
function seed() {
  const t = todayStr();
  const d = new Date(); d.setDate(d.getDate() + 1); const tm = todayStr(d);
  d.setDate(d.getDate() + 2); const t3 = todayStr(d);
  const me = { id: 'me', name: '我', color: MEMBER_COLORS[0] };
  const shen = { id: uid(), name: '沈书', color: MEMBER_COLORS[1] };
  const lin = { id: uid(), name: '林晚', color: MEMBER_COLORS[2] };
  const su = { id: uid(), name: '苏砚', color: MEMBER_COLORS[3] };
  const gu = { id: uid(), name: '顾远', color: MEMBER_COLORS[4] };
  const team1 = { id: uid(), name: '同行小队', members: [me, shen, lin, su] };
  const team2 = { id: uid(), name: '读书会', members: [{ ...me }, gu] };
  const now = Date.now();
  const T = (o) => ({ id: uid(), done: false, delayed: false, remind: false, createdAt: now - 86400e3, ...o });
  const tasks = [
    T({ title: '晨间整理 · 列出今天最重要的三件事', date: t, time: '08:30', tag: 'life',  teamId: team1.id, assignee: 'me', done: true, doneAt: now - 3600e3 * 5 }),
    T({ title: '完成字灵 App 视觉走查',             date: t, time: '10:00', tag: 'work',  teamId: team1.id, assignee: 'me', done: true, doneAt: now - 3600e3 * 2 }),
    T({ title: '和团队对一版日程模块交互稿',         date: t, time: '15:00', tag: 'work',  teamId: team1.id, assignee: shen.id }),
    T({ title: '读《设计中的设计》两章',             date: t, time: '21:00', tag: 'study', teamId: team2.id, assignee: 'me' }),
    T({ title: '整理上周的会议纪要',                 date: t, time: '',      tag: 'work',  teamId: team1.id, assignee: lin.id, delayed: true, createdAt: now - 2 * 86400e3 }),
    T({ title: '准备周五的项目演示',                 date: tm, time: '14:00', tag: 'work', teamId: team1.id, assignee: su.id }),
    T({ title: '给字灵新增三个形态彩蛋',             date: t3, time: '',      tag: 'work', teamId: team1.id, assignee: 'me' }),
  ];
  return {
    v: 2,
    profile: { name: '行者', motto: '把日子过成诗' },
    settings: { theme: 'auto', uiStyle: null, remindSound: true },
    teams: [team1, team2],
    currentTeamId: team1.id,
    tasks,
    feed: [
      { id: uid(), ts: now - 3600e3 * 2, who: '我', text: '完成了「完成字灵 App 视觉走查」', teamId: team1.id },
      { id: uid(), ts: now - 3600e3 * 7, who: shen.name, text: '加入了团队', teamId: team1.id },
      { id: uid(), ts: now - 3600e3 * 9, who: gu.name, text: '加入了团队', teamId: team2.id },
    ],
    seededAt: now,
  };
}

/** v1（单团队）→ v2（多团队 + 提醒字段）。 */
function migrate(s) {
  if (s.v >= 2) return s;
  const team = {
    id: uid(),
    name: s.teamName || '同行小队',
    members: (s.members && s.members.length ? s.members : [{ id: 'me', name: '我', color: MEMBER_COLORS[0] }]),
  };
  s.teams = [team];
  s.currentTeamId = team.id;
  (s.tasks || []).forEach((t) => { t.teamId = team.id; if (t.remind == null) t.remind = false; });
  (s.feed || []).forEach((f) => { f.teamId = team.id; });
  if (s.settings && s.settings.remindSound == null) s.settings.remindSound = true;
  delete s.teamName; delete s.members;
  s.v = 2;
  return s;
}

let state = null;
const listeners = new Set();

export function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? migrate(JSON.parse(raw)) : seed();
  } catch { state = seed(); }
  if (!('uiStyle' in state.settings)) state.settings.uiStyle = null;
  if (!state.teams || !state.teams.length) { const fresh = seed(); state.teams = fresh.teams; state.currentTeamId = fresh.currentTeamId; }
  if (!state.teams.find((t) => t.id === state.currentTeamId)) state.currentTeamId = state.teams[0].id;
  save();
  return state;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 隐私模式等场景下静默降级为内存态 */ }
  listeners.forEach((fn) => fn(state));
}

export const onChange = (fn) => { listeners.add(fn); };
export const get = () => state || load();

/** 任务操作的同步钩子（api.js 注册；本地模式为空操作）。 */
let syncFn = null;
export const setSync = (fn) => { syncFn = fn; };
const emit = (op, t) => { try { syncFn && syncFn(op, t); } catch { /* 同步失败不打断 UI */ } };

/* ── 团队 ───────────────────────────────────────────────── */
export const teams = () => get().teams;
export const currentTeam = () => get().teams.find((t) => t.id === get().currentTeamId) || get().teams[0];
export function setCurrentTeam(id) {
  if (get().teams.find((t) => t.id === id)) { state.currentTeamId = id; save(); }
}
export function addTeam(name) {
  const team = {
    id: uid(), name: (name || '新团队').trim().slice(0, 12),
    members: [{ id: 'me', name: get().profile.name.slice(0, 2) || '我', color: MEMBER_COLORS[0] }],
  };
  state.teams.push(team);
  state.currentTeamId = team.id;
  state.feed.unshift({ id: uid(), ts: Date.now(), who: '我', text: `创建了团队「${team.name}」`, teamId: team.id });
  save();
  return team;
}
export function renameTeam(id, name) {
  const t = state.teams.find((x) => x.id === id);
  if (t) { t.name = name.trim().slice(0, 12) || t.name; save(); }
}
export function removeTeam(id) {
  if (state.teams.length <= 1) return false;   // 至少保留一个团队
  state.teams = state.teams.filter((t) => t.id !== id);
  state.tasks = state.tasks.filter((t) => t.teamId !== id);
  state.feed = state.feed.filter((f) => f.teamId !== id);
  if (state.currentTeamId === id) state.currentTeamId = state.teams[0].id;
  save();
  return true;
}

export function addMember(name, teamId = get().currentTeamId) {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return;
  const m = { id: uid(), name: name.trim().slice(0, 6), color: MEMBER_COLORS[team.members.length % MEMBER_COLORS.length] };
  team.members.push(m);
  state.feed.unshift({ id: uid(), ts: Date.now(), who: m.name, text: '加入了团队', teamId });
  save();
  return m;
}
export function removeMember(id, teamId = get().currentTeamId) {
  if (id === 'me') return;
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return;
  team.members = team.members.filter((m) => m.id !== id);
  state.tasks.forEach((t) => { if (t.teamId === teamId && t.assignee === id) t.assignee = 'me'; });
  save();
}

/** 找成员：先在指定/当前团队找，再全局找（任务行展示用）。 */
export function memberOf(id, teamId) {
  const team = teamId && get().teams.find((t) => t.id === teamId);
  const inTeam = team && team.members.find((m) => m.id === id);
  if (inTeam) return inTeam;
  for (const t of get().teams) { const m = t.members.find((x) => x.id === id); if (m) return m; }
  return { id: 'me', name: '我', color: MEMBER_COLORS[0] };
}
export const teamOf = (task) => get().teams.find((t) => t.id === task.teamId);

/* ── 任务 ───────────────────────────────────────────────── */
export function addTask({ title, date, time = '', tag = 'work', assignee = 'me', teamId = get().currentTeamId, remind = false }) {
  const t = {
    id: uid(), title: title.trim(), date, time, tag, assignee, teamId,
    remind: remind && !!time, done: false, delayed: false, createdAt: Date.now(),
  };
  state.tasks.unshift(t);
  logFeed(t, `创建了「${t.title}」`);
  save();
  emit('create', t);
  return t;
}

export function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  if (!t.time) t.remind = false;
  if (patch.date || patch.time) { delete t.remindedAt; delete t.snoozeUntil; }   // 改期 → 重新武装提醒
  save();
  emit('update', t);
  return t;
}

export function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : undefined;
  if (t.done) { t.delayed = false; logFeed(t, `完成了「${t.title}」`); }
  save();
  emit(t.done ? 'done' : 'undone', t);
  return t;
}

export function toggleDelayed(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.delayed = !t.delayed;
  if (t.delayed) { t.done = false; logFeed(t, `搁置了「${t.title}」`); }
  save();
  return t;
}

export function moveToTomorrow(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  const d = new Date((t.date || todayStr()) + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  t.date = todayStr(d);
  t.delayed = false;
  delete t.remindedAt; delete t.snoozeUntil;
  logFeed(t, `把「${t.title}」顺延了一天`);
  save();
  emit('update', t);
  return t;
}

export function removeTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  state.tasks = state.tasks.filter((x) => x.id !== id);
  save();
  if (t) emit('delete', t);
}

export const tasksOn = (date) => get().tasks.filter((t) => t.date === date);

/** 今日视图（跨团队的"我的一天"）= 当天任务 + 之前没做完的（自动视为"拖延"）。 */
export function todayView() {
  const t = todayStr();
  const list = get().tasks.filter((x) => x.date === t || (!x.done && x.date < t));
  const overdue = (x) => x.date < t && !x.done;
  return {
    doing: list.filter((x) => !x.done && !x.delayed && !overdue(x)),
    delayed: list.filter((x) => !x.done && (x.delayed || overdue(x))),
    done: list.filter((x) => x.done),
  };
}

/** 喂给字灵的日程载荷（contract 见 后端对接文档.md §5） */
export function zilingPayload() {
  const { doing, delayed, done } = todayView();
  return {
    completed: done.map((x) => ({ title: x.title, time: x.time || undefined })),
    pending: doing.map((x) => ({ title: x.title, deadline: x.time || undefined })),
    delayed: delayed.map((x) => ({ title: x.title })),
  };
}

/* ── 提醒 ───────────────────────────────────────────────── */
export function setRemind(id, on) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.remind = on && !!t.time;
  delete t.remindedAt; delete t.snoozeUntil;
  save();
  return t;
}
/** 该响的提醒：今天、有时间、开了提醒、没完成、时间到了、还没响过（或贪睡到点）。 */
export function dueReminders(now = Date.now()) {
  const t = todayStr();
  const hhmm = new Date(now).toTimeString().slice(0, 5);
  return get().tasks.filter((x) =>
    x.remind && !x.done && x.date === t && x.time && !x.remindedAt
    && (x.snoozeUntil ? now >= x.snoozeUntil : x.time <= hhmm));
}
export function markReminded(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (t) { t.remindedAt = Date.now(); delete t.snoozeUntil; save(); }
}
export function snoozeReminder(id, mins = 10) {
  const t = state.tasks.find((x) => x.id === id);
  if (t) { t.snoozeUntil = Date.now() + mins * 60e3; delete t.remindedAt; save(); }
}

/* ── 动态 / 统计 ────────────────────────────────────────── */
function logFeed(task, text) {
  const who = memberOf(task.assignee, task.teamId)?.name || '我';
  state.feed.unshift({ id: uid(), ts: Date.now(), who, text, teamId: task.teamId });
  state.feed = state.feed.slice(0, 80);
}

/** 本周当前团队每位成员的完成率。 */
export function weekStats(teamId = get().currentTeamId) {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return [];
  const now = new Date();
  const day = (now.getDay() + 6) % 7;            // 周一为一周之始
  const mon = new Date(now); mon.setDate(now.getDate() - day);
  const start = todayStr(mon);
  const end = todayStr(new Date(mon.getTime() + 6 * 86400e3));
  return team.members.map((m) => {
    const mine = get().tasks.filter((t) => t.teamId === teamId && t.assignee === m.id && t.date >= start && t.date <= end);
    return { member: m, total: mine.length, done: mine.filter((t) => t.done).length };
  });
}

/* ── 个人 / 偏好 ────────────────────────────────────────── */
export function setProfile(patch) { Object.assign(state.profile, patch); save(); }
export function setTheme(theme) { state.settings.theme = theme; save(); }
export function setUIStyle(style) { state.settings.uiStyle = style; save(); }
export function setRemindSound(on) { state.settings.remindSound = !!on; save(); }

export function totalStats() {
  const ts = get().tasks;
  const doneCnt = ts.filter((t) => t.done).length;
  const days = new Set(ts.filter((t) => t.done && t.doneAt).map((t) => todayStr(new Date(t.doneAt)))).size;
  return { total: ts.length, done: doneCnt, days };
}

export function exportJSON() { return JSON.stringify(state, null, 2); }
export function resetAll(withSeed = true) {
  if (withSeed) { state = seed(); }
  else {
    const s = seed();
    const team = { id: s.teams[0].id, name: '我的团队', members: [{ id: 'me', name: '我', color: MEMBER_COLORS[0] }] };
    state = { ...s, tasks: [], feed: [], teams: [team], currentTeamId: team.id };
  }
  save();
}

/** 登录后从后端拉到的数据整体替换（api.js 用）。 */
export function replaceData({ teams: ts, tasks, currentTeamId }) {
  if (ts && ts.length) { state.teams = ts; state.currentTeamId = currentTeamId || ts[0].id; }
  if (tasks) state.tasks = tasks;
  save();
}
