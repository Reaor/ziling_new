/**
 * 字灵 Mock AI —— 离线/无密钥时的高质量假数据
 *
 * 目的：云端/无后端环境也能完整检阅"互动态日程反馈、对话态三阶段"的呈现效果，
 *       且**不需要任何 API 密钥**（避免密钥泄露）。
 *
 * 与真实接口同构：返回的 JSON 形状与 `项目架构与集成指南.md §六` / `后端对接文档.md` 完全一致，
 * 这样接真 API 时前端代码无需改动。
 *
 * @module ai/mock
 * @license MIT
 */

const EMOJIS_POS = ['^_^', '^o^', '≥▽≤', '(^_^)/', '^.^'];
const EMOJIS_NEU = ['-_-', '=_=', '¬_¬', '⊙_⊙'];
const EMOJIS_NEG = ['>_<', 'T_T', 'Q_Q', '≥﹏≤', 'U_U'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** 互动态：根据日程完成情况给一句话 + 一个颜文字。 */
export function mockSchedule(schedule = {}) {
  const done = (schedule.completed || []).length;
  const pend = (schedule.pending || []).length;
  const late = (schedule.delayed || []).length;
  let emoji, message;
  if (late > 0 && late >= done) {
    emoji = pick(EMOJIS_NEG);
    message = `有 ${late} 件拖延了，别急，挑一件先开始就好`;
  } else if (done > 0 && pend + late === 0) {
    emoji = pick(EMOJIS_POS);
    message = `今天 ${done} 件都完成啦，超棒的`;
  } else if (done > 0) {
    emoji = pick(EMOJIS_POS);
    message = `已经完成 ${done} 件，还剩 ${pend + late} 件，稳住`;
  } else {
    emoji = pick(EMOJIS_NEU);
    message = `今天还没开始呢，先迈出第一步吧`;
  }
  return { message, emoji };
}

/** 对话态：根据用户消息情绪给 quickReply + 巨字 + 回复流。schedule 存在且问到日程相关时，给基于日程的建议。 */
export function mockChat(message = '', history = [], schedule = null) {
  const text = String(message);
  // 问到日程/安排/计划/待办类问题 → 基于当前日程给具体建议（Mock 版；真实由后端 LLM 据日程作答）。
  if (schedule && /日程|安排|计划|待办|任务|怎么办|先做|优先|时间管理|effic|规划/.test(text)) {
    const d = (schedule.completed || []).length, p = (schedule.pending || []).length, l = (schedule.delayed || []).length;
    const pend = (schedule.pending || [])[0], late = (schedule.delayed || [])[0];
    const focus = late ? (late.title || '拖延的那件') : pend ? (pend.title || '待办的第一件') : '当下最近的一件';
    return {
      quickReply: `先做「${focus}」，其余顺势推进`,
      megachar: { chars: ['先做'], direction: 'vertical', rotateInterval: 0, duration: 3200 },
      stream: [
        { text: `你今天完成 ${d} 件、待办 ${p} 件、拖延 ${l} 件`, emoji: '-_-' },
        { text: `建议先啃「${focus}」，它最影响后续`, emoji: '^.^' },
        { text: '给它一个明确的小起点，5 分钟就行', emoji: '(^_^)/' },
        { text: '其余的按截止时间排，不必都今天', emoji: '^_^' },
      ],
    };
  }
  const neg = /累|烦|难过|压力|拖延|焦虑|怕|哭|烦躁|不想/.test(text);
  const happy = /开心|高兴|完成|搞定|耶|棒|爽|成功/.test(text);
  const mood = neg ? 'neg' : happy ? 'pos' : 'neu';

  const PRESETS = {
    neg: {
      quickReply: '累的时候，停一下也是前进',
      char: '休',
      stream: [
        { text: '你看"休"字，是人靠在木旁', emoji: '^.^' },
        { text: '古人早懂得歇口气的重要', emoji: '-_-' },
        { text: '去喝杯水、伸个懒腰吧', emoji: '(^_^)/' },
      ],
    },
    pos: {
      quickReply: '真为你开心，继续保持',
      char: '赞',
      stream: [
        { text: '这股劲头很难得', emoji: '^o^' },
        { text: '把它记下来，下次还能借力', emoji: '^_^' },
        { text: '奖励自己一下，应得的', emoji: '≥▽≤' },
      ],
    },
    neu: {
      quickReply: '我在听，慢慢说',
      char: '安',
      stream: [
        { text: '把想法摊开，往往就清楚了', emoji: '^.^' },
        { text: '一次只想一件事就好', emoji: '-_-' },
        { text: '需要的话，我陪你理一理', emoji: '^_^' },
      ],
    },
  };
  const p = PRESETS[mood];
  return {
    quickReply: p.quickReply,
    megachar: { chars: [p.char], direction: 'vertical', rotateInterval: 0, duration: 3200 },
    stream: p.stream,
  };
}

/** 游戏态：简易词库判定（离线兜底；真实判定走后端 /api/validate）。 */
export function mockValidate(char1 = '', char2 = '') {
  const WORDS = new Set(['明天', '天明', '休息', '加油', '快乐', '学习', '工作', '朋友', '时间', '完成']);
  for (const w of [char1 + char2, char2 + char1]) {
    if (WORDS.has(w)) return { valid: true, word: w };
  }
  return { valid: false };
}
