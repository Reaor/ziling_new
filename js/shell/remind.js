/**
 * 任务提醒 / 闹钟（前端本地实现：zicodo 后端暂无提醒字段）
 * - 每 15s 检查一次到点任务（开了提醒、有时间点、今天、未完成、未响过/贪睡到点）
 * - 到点：应用内闹钟卡片（完成 / 稍后10分钟 / 知道了）+ 青瓷三连音 + 震动；
 *   页面在后台且已授权时，发系统通知。
 * - 限制（诚实声明）：纯前端 PWA，App 进程被杀时不响；需要离线推送得接 Web Push 服务。
 */

import * as store from './store.js';

let ui = null;          // { onFire(task) } 由 main.js 注入（渲染闹钟卡片）
let timer = null;

export function init(uiHooks) {
  ui = uiHooks;
  clearInterval(timer);
  timer = setInterval(check, 15000);
  check();
  // 切回前台立刻补查（后台 setInterval 可能被节流）
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
}

function check() {
  for (const t of store.dueReminders()) fire(t);
}

function fire(task) {
  store.markReminded(task.id);
  if (store.get().settings.remindSound) chime();
  try { navigator.vibrate && navigator.vibrate([180, 90, 180]); } catch { /* */ }
  if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification('zicodo · 到点了', { body: `${task.time}  ${task.title}`, tag: `zl-${task.id}` });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* 部分 WebView 无 Notification 构造器 */ }
  }
  ui && ui.onFire(task);
}

export function snooze(id, mins = 10) { store.snoozeReminder(id, mins); }

export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}
export function permissionState() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** 青瓷风提示音：五声音阶三连音（宫-角-徵），柔和不刺耳。 */
function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = chime.ctx || (chime.ctx = new AC());
    if (ctx.state === 'suspended') ctx.resume();
    const notes = [523.25, 659.25, 784.0, 659.25, 784.0];   // C5 E5 G5 E5 G5
    notes.forEach((f, i) => {
      const t0 = ctx.currentTime + i * 0.28;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + 0.3);
    });
  } catch { /* 无声环境静默 */ }
}
