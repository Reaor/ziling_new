/**
 * 字灵 AI 通信层 —— 统一封装 /api/* 请求，自动在「真实后端 / Mock 假数据」间切换。
 *
 * 职责：只做 HTTP + 数据，**不碰 Canvas/模态**（解析后的 JSON 交给上层）。
 *
 * 三种数据来源（自动按可用性选择，优先级从高到低）：
 *   1. 后端网关：window.ZILING_CONFIG.apiBase 指向的 App 后端（生产环境）。
 *   2. 用户自带 Key：设置里临时填入的 DeepSeek key（仅存 localStorage，绝不进仓库/不上云）。
 *      —— 解决"云端 review 想看真实 AI、又怕密钥泄露"：key 只活在你自己浏览器里。
 *   3. Mock 假数据：以上都没有时用内置高质量假数据，无需任何密钥即可看全部呈现效果。
 *
 * 接口契约见：项目架构与集成指南.md §六 / 后端对接文档.md。
 * @module ai/bridge
 */

import { mockSchedule, mockChat, mockValidate } from './mock.js';

const LS_KEY = 'ziling.deepseek.key';      // 用户自带 key 的 localStorage 键
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

/* ── 配置读取 ─────────────────────────────────────────────── */

function apiBase() {
  // 优先级：宿主注入 ZILING_CONFIG（原始契约 /api/*、裸 JSON）→ localStorage 网关
  // （宿主 App 登录 zicodo 后写入 'ziling.gateway'，走 /ziling/api/*、{code,data} 包裹）。
  let base = (typeof window !== 'undefined' && window.ZILING_CONFIG?.apiBase) || '';
  if (!base) { try { base = localStorage.getItem('ziling.gateway') || ''; } catch { /* */ } }
  return base.replace(/\/$/, '');
}
function apiPrefix() {
  if (typeof window !== 'undefined' && window.ZILING_CONFIG?.apiBase) return '/api';
  try { return localStorage.getItem('ziling.gateway.prefix') || '/ziling/api'; } catch { return '/ziling/api'; }
}
function authToken() {
  // 与宿主 App 同源共享的登录态（zicodo JWT）；带上则后端可读宠物名/保存对话，不带也能用。
  try { return localStorage.getItem('zl.api.token') || ''; } catch { return ''; }
}
function userKey() {
  try { return (typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY)) || ''; }
  catch { return ''; }
}
/** 设置/清除用户自带 key（仅本机 localStorage）。供设置面板调用。 */
export function setUserKey(k) {
  try { k ? localStorage.setItem(LS_KEY, k) : localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}
export function hasUserKey() { return !!userKey(); }

/** 当前数据来源：'backend' | 'direct' | 'mock'（供 UI 显示/调试）。 */
export function aiSource() {
  if (apiBase()) return 'backend';
  if (userKey()) return 'direct';
  return 'mock';
}

/* ── 人设 / 记忆（设置页可调；后端可在 system prompt 用 persona、用 memory 决定是否带历史） ── */
const LS_PERSONA = 'ziling.persona', LS_MEMORY = 'ziling.memory';
export function setPersona(p) { try { p ? localStorage.setItem(LS_PERSONA, p) : localStorage.removeItem(LS_PERSONA); } catch { /* */ } }
export function getPersona() { try { return localStorage.getItem(LS_PERSONA) || ''; } catch { return ''; } }
/** AI 记忆开关：关 → chat 不带历史（每次都是新对话）。默认开。 */
export function setMemory(on) { try { localStorage.setItem(LS_MEMORY, on ? '1' : '0'); } catch { /* */ } }
export function memoryOn() { try { return localStorage.getItem(LS_MEMORY) !== '0'; } catch { return true; } }

/* ── 后端网关请求 ─────────────────────────────────────────── */

async function backend(path, body, method = 'POST') {
  const token = authToken();
  const res = await fetch(`${apiBase()}${apiPrefix()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  // zicodo 统一包裹 {code,message,data}：code≠0 视为业务错误；裸 JSON（原始契约）原样返回。
  if (json && typeof json === 'object' && typeof json.code === 'number' && 'data' in json) {
    if (json.code !== 0) throw new Error(json.message || `code ${json.code}`);
    return json.data;
  }
  return json;
}

/* ── 用户自带 Key：浏览器直连 DeepSeek（仅本机调试用） ──────────
 * 注意：浏览器直连会暴露 key 给该请求（仅你本机发起、key 来自你本机 localStorage）。
 * 这是"本机调试"专用通道，绝不用于上线；上线一律走后端网关。 */

const SYSTEM_PROMPT_CHAT = `你叫"字灵"，一个温柔、聪慧、懂用户的汉字精灵，住在用户的日程 App 里陪伴并帮助他。
【回答质量要求——这是重点】
1. 真正读懂用户这句话的意图与情绪，针对性地回应，绝不套话、空洞鸡汤或答非所问。
2. 若给了【用户当前日程】，结合其真实安排/完成情况给具体、可操作、个性化的建议（点名某件事、给出明确的小步骤），像一个记得他日程的朋友。
3. 提到问题就给真办法；情绪低落就先共情再轻推一步；开心就一起庆祝并帮他记住这份劲头。语气自然、有温度、不端着。
4. 善用汉字之美：可借一个字的字形/字义点题（如"休=人倚木"），但点到为止，别掉书袋。
【输出】只输出 JSON，不要解释或 Markdown：
{"quickReply":"≤20字、直接回应这句话的核心（最重要的一句）","megachar":{"chars":["1~2个最能概括此刻主旨/心境的字"],"direction":"vertical","rotateInterval":0,"duration":3200},"stream":[{"text":"一句话","emoji":"颜文字"},{"text":"承接上一句、递进","emoji":"颜文字"},{"text":"落到一个具体行动或暖心收尾","emoji":"颜文字"}]}
stream 的三句要连贯成一段完整的小思路（共情→展开→落地），不是三句不相干的话。每句≤22字。
颜文字只能从这些里选：^_^ -_- T_T Q_Q U_U >_< ≥﹏≤ ¬_¬ =_= ⊙_⊙ ^o^ ^.^ ≥▽≤ (^_^)/，且要贴合该句情绪。绝不输出负面攻击或敷衍内容。`;

const SYSTEM_PROMPT_SCHEDULE = `你叫"字灵"。根据用户今日日程完成情况，输出 JSON：{"message":"≤30字的鼓励/陪伴话","emoji":"颜文字"}。颜文字从 ^_^ ^o^ ≥▽≤ (^_^)/ ^.^ -_- =_= >_< T_T 里选，完成多用积极的、拖延多用安慰的。`;

async function direct(systemPrompt, userContent, temperature = 1.0, history = []) {
  // 带上最近几轮对话（history）→ AI 有上下文记忆、回答更连贯更懂用户。只取 role/content 干净字段。
  const hist = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userKey()}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...hist, { role: 'user', content: userContent }],
      response_format: { type: 'json_object' },
      temperature,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

/* ── 对外 API（三态统一入口；失败自动回退 Mock，绝不让前端崩） ── */

export async function ping() {
  if (aiSource() === 'backend') { try { return await backend('/ping', null, 'GET'); } catch { /* fall */ } }
  return { status: 'ok', source: aiSource() };
}

const personaLine = () => { const p = getPersona(); return p ? `\n人设/风格要求：${p}。` : ''; };

/** 互动态：日程反馈 → { message, emoji } */
export async function schedule(sch) {
  try {
    if (aiSource() === 'backend') return await backend('/schedule', { ...sch, persona: getPersona() });
    if (aiSource() === 'direct') return await direct(SYSTEM_PROMPT_SCHEDULE + personaLine(), JSON.stringify(sch));
  } catch (e) { console.warn('[ai] schedule fallback to mock:', e.message); }
  return mockSchedule(sch);
}

/**
 * 对话态：用户消息 → { quickReply, megachar, stream }。记忆关闭时不带 history。
 * @param {object} [ctx] 上下文：{ schedule } 当前日程 → 让 AI 能基于用户日程/习惯给专业回答。
 */
export async function chat(message, history = [], ctx = {}) {
  const hist = memoryOn() ? history : [];
  const schedule = ctx && ctx.schedule || null;
  try {
    if (aiSource() === 'backend') return await backend('/chat', { message, history: hist, persona: getPersona(), schedule });
    if (aiSource() === 'direct') {
      const sched = schedule ? `\n【用户当前日程】${JSON.stringify(schedule)}。回答涉及日程的问题时请据此给出基于其实际安排/习惯的具体建议。` : '';
      return await direct(SYSTEM_PROMPT_CHAT + personaLine() + sched, message, 0.85, hist);
    }
  } catch (e) { console.warn('[ai] chat fallback to mock:', e.message); }
  return mockChat(message, hist, schedule);
}

/** 游戏态：组词判定 → { valid, word? }。本地词库未命中时由 AI（后端或自带 key 直连）判别。
 *  判定从严：只认"两字直接相连成的现代汉语常用双字词"，温度 0 求稳；并校验 AI 回的词确实由这两字组成。 */
export async function validateWord(char1, char2) {
  try {
    if (aiSource() === 'backend') return await backend('/validate', { char1, char2 });
    if (aiSource() === 'direct') {
      const sys = '你是严格的中文组词判定器。判断给定两个汉字能否直接相连（顺序不论，不加任何其他字）组成一个'
        + '现代汉语里真实存在、有意义的【常用双字词】。判定从严：生僻词、文言、专有名词、需要加字才成词的一律判否；'
        + '拿不准就判否。只输出 JSON：{"valid":true,"word":"组成的那个双字词"} 或 {"valid":false}。不要解释。';
      const out = await direct(sys, `两个字：${char1}、${char2}`, 0);
      const word = out && out.word ? String(out.word) : '';
      // 反幻觉校验：必须恰好是这两个字直接组成的双字词（顺序不论），否则判否。
      const ok = !!(out && out.valid) && (word === char1 + char2 || word === char2 + char1);
      return ok ? { valid: true, word } : { valid: false };
    }
  } catch (e) { console.warn('[ai] validate fallback to mock:', e.message); }
  return mockValidate(char1, char2);
}
