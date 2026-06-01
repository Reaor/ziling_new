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
  const base = (typeof window !== 'undefined' && window.ZILING_CONFIG?.apiBase) || '';
  return base.replace(/\/$/, '');
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
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ── 用户自带 Key：浏览器直连 DeepSeek（仅本机调试用） ──────────
 * 注意：浏览器直连会暴露 key 给该请求（仅你本机发起、key 来自你本机 localStorage）。
 * 这是"本机调试"专用通道，绝不用于上线；上线一律走后端网关。 */

const SYSTEM_PROMPT_CHAT = `你叫"字灵"，一个温柔的汉字精灵，陪伴用户。只输出 JSON，不要解释或 Markdown。
格式：{"quickReply":"≤20字的简洁回应","megachar":{"chars":["单个汉字"],"direction":"vertical","rotateInterval":0,"duration":3200},"stream":[{"text":"一句话","emoji":"颜文字"},{"text":"...","emoji":"..."},{"text":"...","emoji":"..."}]}
颜文字只能从这些里选：^_^ -_- T_T Q_Q U_U >_< ≥﹏≤ ¬_¬ =_= ⊙_⊙ ^o^ ^.^ ≥▽≤ (^_^)/。megachar.chars 给 1 个最能概括心境的汉字。绝不输出负面攻击性内容。`;

const SYSTEM_PROMPT_SCHEDULE = `你叫"字灵"。根据用户今日日程完成情况，输出 JSON：{"message":"≤30字的鼓励/陪伴话","emoji":"颜文字"}。颜文字从 ^_^ ^o^ ≥▽≤ (^_^)/ ^.^ -_- =_= >_< T_T 里选，完成多用积极的、拖延多用安慰的。`;

async function direct(systemPrompt, userContent) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userKey()}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
      response_format: { type: 'json_object' },
      temperature: 1.0,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

/* ── 对外 API（三态统一入口；失败自动回退 Mock，绝不让前端崩） ── */

export async function ping() {
  if (aiSource() === 'backend') { try { return await backend('/api/ping', null, 'GET'); } catch { /* fall */ } }
  return { status: 'ok', source: aiSource() };
}

const personaLine = () => { const p = getPersona(); return p ? `\n人设/风格要求：${p}。` : ''; };

/** 互动态：日程反馈 → { message, emoji } */
export async function schedule(sch) {
  try {
    if (aiSource() === 'backend') return await backend('/api/schedule', { ...sch, persona: getPersona() });
    if (aiSource() === 'direct') return await direct(SYSTEM_PROMPT_SCHEDULE + personaLine(), JSON.stringify(sch));
  } catch (e) { console.warn('[ai] schedule fallback to mock:', e.message); }
  return mockSchedule(sch);
}

/** 对话态：用户消息 → { quickReply, megachar, stream }。记忆关闭时不带 history。 */
export async function chat(message, history = []) {
  const hist = memoryOn() ? history : [];
  try {
    if (aiSource() === 'backend') return await backend('/api/chat', { message, history: hist, persona: getPersona() });
    if (aiSource() === 'direct') return await direct(SYSTEM_PROMPT_CHAT + personaLine(), message);
  } catch (e) { console.warn('[ai] chat fallback to mock:', e.message); }
  return mockChat(message, hist);
}

/** 游戏态：组词判定 → { valid, word? } */
export async function validateWord(char1, char2) {
  try {
    if (aiSource() === 'backend') return await backend('/api/validate', { char1, char2 });
  } catch (e) { console.warn('[ai] validate fallback to mock:', e.message); }
  return mockValidate(char1, char2);
}
