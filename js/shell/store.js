/**
 * 字灵日程 · 数据层
 * localStorage 持久化：任务 / 团队成员 / 团队动态 / 个人资料 / 偏好。
 * 纯前端可用（部署在静态站点即真实可用）；将来接后端时替换此层即可。
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
  const members = [
    { id: 'me',  name: '我',   color: MEMBER_COLORS[0] },
    { id: uid(), name: '沈书', color: MEMBER_COLORS[1] },
    { id: uid(), name: '林晚', color: MEMBER_COLORS[2] },
    { id: uid(), name: '苏砚', color: MEMBER_COLORS[3] },
  ];
  const [me, shen, lin, su] = members;
  const now = Date.now();
  const tasks = [
    { id: uid(), title: '晨间整理 · 列出今天最重要的三件事', date: t, time: '08:30', tag: 'life',  assignee: me.id,   done: true,  delayed: false, createdAt: now - 86400e3, doneAt: now - 3600e3 * 5 },
    { id: uid(), title: '完成字灵 App 视觉走查',             date: t, time: '10:00', tag: 'work',  assignee: me.id,   done: true,  delayed: false, createdAt: now - 86400e3, doneAt: now - 3600e3 * 2 },
    { id: uid(), title: '和团队对一版日程模块交互稿',         date: t, time: '15:00', tag: 'work',  assignee: shen.id, done: false, delayed: false, createdAt: now - 86400e3 },
    { id: uid(), title: '读《设计中的设计》两章',             date: t, time: '21:00', tag: 'study', assignee: me.id,   done: false, delayed: false, createdAt: now - 86400e3 },
    { id: uid(), title: '整理上周的会议纪要',                 date: t, time: '',      tag: 'work',  assignee: lin.id,  done: false, delayed: true,  createdAt: now - 2 * 86400e3 },
    { id: uid(), title: '准备周五的项目演示',                 date: tm, time: '14:00', tag: 'work', assignee: su.id,   done: false, delayed: false, createdAt: now - 86400e3 },
    { id: uid(), title: '给字灵新增三个形态彩蛋',             date: t3, time: '',      tag: 'work', assignee: me.id,   done: false, delayed: false, createdAt: now - 86400e3 },
  ];
  return {
    profile: { name: '行者', motto: '把日子过成诗' },
    settings: { theme: 'auto', uiStyle: null },   // uiStyle: null=首次进入待选 | 'ink' 水墨 | 'modern' 现代
    teamName: '同行小队',
    members,
    tasks,
    feed: [
      { id: uid(), ts: now - 3600e3 * 2, who: me.name, text: '完成了「完成字灵 App 视觉走查」' },
      { id: uid(), ts: now - 3600e3 * 7, who: shen.name, text: '加入了团队' },
    ],
    seededAt: now,
  };
}

let state = null;
const listeners = new Set();

export function load() {
  if (state) return state;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? JSON.parse(raw) : seed();
  } catch { state = seed(); }
  if (!('uiStyle' in state.settings)) state.settings.uiStyle = null;   // 旧数据迁移
  save();
  return state;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 隐私模式等场景下静默降级为内存态 */ }
  listeners.forEach((fn) => fn(state));
}

export const onChange = (fn) => { listeners.add(fn); };
export const get = () => state || load();

/* ── 任务 ───────────────────────────────────────────────── */
export function addTask({ title, date, time = '', tag = 'work', assignee = 'me' }) {
  const t = { id: uid(), title: title.trim(), date, time, tag, assignee, done: false, delayed: false, createdAt: Date.now() };
  state.tasks.unshift(t);
  logFeed(assignee, `创建了「${t.title}」`);
  save();
  return t;
}

export function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  save();
  return t;
}

export function toggleDone(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : undefined;
  if (t.done) { t.delayed = false; logFeed(t.assignee, `完成了「${t.title}」`); }
  save();
  return t;
}

export function toggleDelayed(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  t.delayed = !t.delayed;
  if (t.delayed) { t.done = false; logFeed(t.assignee, `搁置了「${t.title}」`); }
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
  logFeed(t.assignee, `把「${t.title}」顺延了一天`);
  save();
  return t;
}

export function removeTask(id) {
  state.tasks = state.tasks.filter((x) => x.id !== id);
  save();
}

export const tasksOn = (date) => get().tasks.filter((t) => t.date === date);

/** 今日视图 = 当天任务 + 之前没做完的（自动视为"拖延"，不让旧账消失） */
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

/* ── 团队 ───────────────────────────────────────────────── */
export function addMember(name) {
  const m = { id: uid(), name: name.trim().slice(0, 6), color: MEMBER_COLORS[state.members.length % MEMBER_COLORS.length] };
  state.members.push(m);
  state.feed.unshift({ id: uid(), ts: Date.now(), who: m.name, text: '加入了团队' });
  save();
  return m;
}

export function removeMember(id) {
  if (id === 'me') return;
  state.members = state.members.filter((m) => m.id !== id);
  state.tasks.forEach((t) => { if (t.assignee === id) t.assignee = 'me'; });
  save();
}

export function setTeamName(name) { state.teamName = name.trim() || state.teamName; save(); }
export const memberOf = (id) => get().members.find((m) => m.id === id) || get().members[0];

function logFeed(assigneeId, text) {
  const who = memberOf(assigneeId)?.name || '我';
  state.feed.unshift({ id: uid(), ts: Date.now(), who, text });
  state.feed = state.feed.slice(0, 40);
}

/** 本周每位成员的完成率（团队页统计条） */
export function weekStats() {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;            // 周一为一周之始
  const mon = new Date(now); mon.setDate(now.getDate() - day);
  const start = todayStr(mon);
  const end = todayStr(new Date(mon.getTime() + 6 * 86400e3));
  return get().members.map((m) => {
    const mine = get().tasks.filter((t) => t.assignee === m.id && t.date >= start && t.date <= end);
    return { member: m, total: mine.length, done: mine.filter((t) => t.done).length };
  });
}

/* ── 个人 / 偏好 ────────────────────────────────────────── */
export function setProfile(patch) { Object.assign(state.profile, patch); save(); }
export function setTheme(theme) { state.settings.theme = theme; save(); }
export function setUIStyle(style) { state.settings.uiStyle = style; save(); }

export function totalStats() {
  const ts = get().tasks;
  const doneCnt = ts.filter((t) => t.done).length;
  const days = new Set(ts.filter((t) => t.done && t.doneAt).map((t) => todayStr(new Date(t.doneAt)))).size;
  return { total: ts.length, done: doneCnt, days };
}

export function exportJSON() { return JSON.stringify(state, null, 2); }
export function resetAll(withSeed = true) {
  state = withSeed ? seed() : { ...seed(), tasks: [], feed: [], members: [{ id: 'me', name: '我', color: MEMBER_COLORS[0] }] };
  save();
}
