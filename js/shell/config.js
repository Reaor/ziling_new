/**
 * 部署配置 —— 交给后端/运维同学维护（普通用户永远不会看到这里）。
 *
 * API_BASE 的解析顺序（见 api.js resolveBase）：
 *   1. URL 参数 ?api=https://... （联调用，会记住在本机）
 *   2. 这里的 API_BASE
 *   3. 同源（zicodo 的 Nginx 同域托管这套前端时，留空即可，什么都不用配）
 *
 * 后端起好后改这一行、随前端一起发布即可：
 *   export const API_BASE = 'https://api.your-server.com';
 */
export const API_BASE = '';
