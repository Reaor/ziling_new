/**
 * zicodo 后端客户端（契约见仓库 qiadastrachen-bit/zicodo master）
 * - 统一包裹 {code,message,data}：code===0 成功；1001/1002 = token 失效 → 自动登出
 * - 认证：JWT Bearer，7 天；localStorage 持久化（与字灵 iframe 同源共享）
 * - 未配置服务器/未登录 = 本地模式，App 全功能可用；登录后：
 *     · 团队 → 服务器真实多人团队（邀请码加入、成员、积分排行）
 *     · 任务 → 个人任务云同步（title/dueDate/category/status 映射；
 *               时间点/提醒/指派是本层之上的本地增强字段，后端暂不存）
 *     · 字灵 AI → 写 'ziling.gateway'，iframe 内 bridge.js 自动直连 /ziling/api/*
 */

import * as store from './store.js';

const LS = { base: 'zl.api.base', token: 'zl.api.token', user: 'zl.api.user' };
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* */ } };

export const getBase = () => lsGet(LS.base).replace(/\/$/, '');
export function setBase(url) {
  const base = (url || '').trim().replace(/\/$/, '');
  lsSet(LS.base, base);
  syncZilingGateway();
}
export const token = () => lsGet(LS.token);
export const currentUser = () => { try { return JSON.parse(lsGet(LS.user) || 'null'); } catch { return null; } };
export const isAuthed = () => !!(getBase() && token());

/** 字灵 iframe 的网关配置与登录态共用同一组键（同源 localStorage）。 */
function syncZilingGateway() {
  lsSet('ziling.gateway', isAuthed() || getBase() ? getBase() : '');
  lsSet('ziling.gateway.prefix', '/ziling/api');
}

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function call(path, { method = 'GET', body } = {}) {
  if (!getBase()) throw new ApiError(-1, '未配置服务器地址');
  let res;
  try {
    res = await fetch(getBase() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiError(-2, '连不上服务器'); }
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  if (!json || typeof json.code !== 'number') throw new ApiError(-3, `服务器响应异常（HTTP ${res.status}）`);
  if (json.code !== 0) {
    if (json.code === 1001 || json.code === 1002) logout(false);   // token 失效 → 静默登出
    throw new ApiError(json.code, json.message || `错误 ${json.code}`);
  }
  return json.data;
}

/* ── 认证 ───────────────────────────────────────────────── */
function saveSession(data) {
  lsSet(LS.token, data.token);
  lsSet(LS.user, JSON.stringify(data.user));
  syncZilingGateway();
}
export async function register({ username, password, nickname }) {
  const data = await call('/api/auth/register', { method: 'POST', body: { username, password, nickname: nickname || undefined } });
  saveSession(data);
  return data.user;
}
export async function login({ username, password }) {
  const body = username.includes('@') ? { email: username, password } : { username, password };
  const data = await call('/api/auth/login', { method: 'POST', body });
  saveSession(data);
  return data.user;
}
/** 游客一键体验：服务端生成「灵伴_xxx」随机账号。 */
export async function autoLogin() {
  const data = await call('/api/auth/auto-login', { method: 'POST', body: {} });
  saveSession(data);
  return data.user;
}
export async function me() {
  const user = await call('/api/auth/me');
  lsSet(LS.user, JSON.stringify(user));
  return user;
}
export function logout(clearGateway = true) {
  lsSet(LS.token, ''); lsSet(LS.user, '');
  if (clearGateway) syncZilingGateway();
}

/* ── 团队（服务器多团队：邀请码制） ─────────────────────────── */
export const listTeams = async () => (await call('/api/teams')).list || [];
export const teamDetail = (id) => call(`/api/teams/${id}`);
export const createTeam = (name, description = '') => call('/api/teams', { method: 'POST', body: { name, description } });
export const joinTeam = (inviteCode) => call('/api/teams/join', { method: 'POST', body: { inviteCode: String(inviteCode).trim() } });
export const leaveTeam = (teamId) => call('/api/teams/leave', { method: 'POST', body: { teamId } });
export const teamRanking = () => call('/api/teams/ranking');

/* ── 任务云同步 ─────────────────────────────────────────────
 * 字段映射：date↔dueDate；tag↔category(work→other/study→study/life→habit)；
 * done：一次性任务(repeatType none) status==='completed'。
 * 本地任务记 serverId；时间点/提醒/团队归属/指派为本地增强，不上传。 */
const TAG2CAT = { work: 'other', study: 'study', life: 'habit' };
const CAT2TAG = { other: 'work', study: 'study', habit: 'life', fitness: 'life' };
const serverDone = (s) => (s.repeatType === 'none' ? s.status === 'completed' : !!s.checkedToday);

export async function pullTasks() {
  const list = await call('/api/tasks');
  const st = store.get();
  const byServerId = new Map(st.tasks.filter((t) => t.serverId).map((t) => [t.serverId, t]));
  for (const s of list) {
    const local = byServerId.get(s.id);
    const done = serverDone(s);
    if (local) {
      local.title = s.title;
      if (s.dueDate) local.date = s.dueDate;
      if (local.done !== done) { local.done = done; local.doneAt = done ? Date.now() : undefined; }
    } else {
      st.tasks.push({
        id: 'srv_' + s.id, serverId: s.id,
        title: s.title, date: s.dueDate || store.todayStr(), time: '',
        tag: CAT2TAG[s.category] || 'work', teamId: st.currentTeamId, assignee: 'me',
        done, delayed: false, remind: false,
        createdAt: new Date(s.createdAt || Date.now()).getTime(), doneAt: done ? Date.now() : undefined,
      });
    }
  }
  // 本地新增、还没上云的 → 补传
  for (const t of st.tasks.filter((x) => !x.serverId)) pushCreate(t);
  store.replaceData({ tasks: st.tasks });
}

async function pushCreate(t) {
  try {
    const s = await call('/api/tasks', { method: 'POST', body: { title: t.title, dueDate: t.date || undefined, category: TAG2CAT[t.tag] || 'other' } });
    t.serverId = s.id;
    if (t.done) await call(`/api/tasks/${s.id}/check`, { method: 'POST' }).catch(() => {});
  } catch (e) { console.warn('[sync] create:', e.message); }
}

/** store 同步钩子：本地操作 → 镜像到服务器（尽力而为，失败只警告不打断 UI）。 */
export function syncHandler(op, t) {
  if (!isAuthed() || !t) return;
  const sid = t.serverId;
  const safe = (p) => p.catch((e) => console.warn(`[sync] ${op}:`, e.message));
  if (op === 'create') { pushCreate(t); return; }
  if (!sid) return;
  if (op === 'update') safe(call(`/api/tasks/${sid}`, { method: 'PUT', body: { title: t.title, dueDate: t.date || null, category: TAG2CAT[t.tag] || 'other' } }));
  if (op === 'done') safe(call(`/api/tasks/${sid}/check`, { method: 'POST' }).catch((e) => { if (e.code !== 3003) throw e; }));
  if (op === 'undone') safe(call(`/api/tasks/${sid}`, { method: 'PUT', body: { status: 'active' } }));
  if (op === 'delete') safe(call(`/api/tasks/${sid}`, { method: 'DELETE' }));
}

/** 启动时恢复会话：验证 token、拉取任务。返回 user 或 null。 */
export async function restoreSession() {
  syncZilingGateway();
  if (!isAuthed()) return null;
  try {
    const user = await me();
    pullTasks().catch((e) => console.warn('[sync] pull:', e.message));
    return user;
  } catch { return null; }
}
