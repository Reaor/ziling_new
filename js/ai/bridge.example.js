/**
 * AI 通信层模板 — 复制为 bridge.js 后使用
 *
 * 职责：封装 /api/* 请求，不包含 Canvas 或模态逻辑。
 * 配置：window.ZILING_CONFIG.apiBase（生产由 App 注入；开发留空即同源）
 *
 * 接口契约见：项目架构与集成指南.md §六
 */

function apiBase() {
  const base = (typeof window !== 'undefined' && window.ZILING_CONFIG?.apiBase) || '';
  return base.replace(/\/$/, '');
}

async function request(path, options = {}) {
  const url = `${apiBase()}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** @returns {Promise<{status: string}>} */
export function ping() {
  return request('/api/ping', { method: 'GET' });
}

/**
 * 互动态：日程反馈
 * @param {{ completed: object[], pending: object[], delayed: object[] }} schedule
 * @returns {Promise<{ message: string, emoji: string }>}
 */
export function schedule(schedule) {
  return request('/api/schedule', {
    method: 'POST',
    body: JSON.stringify(schedule),
  });
}

/**
 * 对话态：用户消息
 * @param {string} message
 * @param {Array<{role: string, content: string}>} [history]
 * @returns {Promise<{ quickReply: string, megachar?: object, stream?: object[] }>}
 */
export function chat(message, history = []) {
  return request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message, history }),
  });
}

/**
 * 游戏态：组词判定
 * @param {string} char1
 * @param {string} char2
 * @returns {Promise<{ valid: boolean, word?: string }>}
 */
export function validateWord(char1, char2) {
  return request('/api/validate', {
    method: 'POST',
    body: JSON.stringify({ char1, char2 }),
  });
}
