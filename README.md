# 字灵（ZiLing）

汉字精灵宠物页——由大量统一大小的**里字**（汉字）拼成形状、沿格子运动的可交互 Canvas 应用。最终嵌入宿主 App 的 WebView，不是独立网站。

> **给 AI / 新开发者**：请先读 [`项目架构与集成指南.md`](./项目架构与集成指南.md)，再读 [`理解记录.md`](./理解记录.md) 与 [`技术规格.md`](./技术规格.md)。

---

## 快速开始（本地开发）

```bash
# 1. 复制本地开发服模板（含 AI 代理，密钥不进仓库）
cp server.example.js server.js   # Windows: copy server.example.js server.js

# 2. 配置 DeepSeek Key 并启动
# PowerShell:
$env:DEEPSEEK_API_KEY = "你的Key"
node server.js

# 3. 浏览器打开
# http://localhost:8080
# 调试叠加层: http://localhost:8080?debug=1
```

前端为零依赖 Vanilla JS（ES Module），**必须经 HTTP 提供**（`file://` 在部分 WebView 下模块加载会失败）。`server.example.js` 同时承担静态资源服务。

---

## 仓库文档索引

| 文档 | 用途 |
|---|---|
| [**项目架构与集成指南.md**](./项目架构与集成指南.md) | **App ↔ WebView ↔ AI** 关系、API 契约、模块分工、实现进度——网页 AI 开发首选 |
| [理解记录.md](./理解记录.md) | 产品需求精确理解（三模态、形状、运动、颜文字） |
| [字灵最新收束.md](./字灵最新收束.md) | 产品原始收束文档 |
| [技术规格.md](./技术规格.md) | 完整技术规格与 Phase 0–21 实施路线 |
| [未纳入版本库说明.md](./未纳入版本库说明.md) | 仅列出 `.gitignore` 项及本地副本说明 |

---

## 当前实现进度（摘要）

| 区域 | 状态 |
|---|---|
| Canvas 渲染、格子、里字池、PIBT 运动引擎 | ✅ 已实现 |
| 形状掩码、点击散开、拖拽、手势 | ✅ 已实现（`app.js` 内联 demo） |
| DOM UI（按钮、输入框、提示） | ❌ `#ui-overlay` 空壳，待 `js/ui/overlay.js` |
| 三模态状态机 | ❌ 待 `js/modes/*.js` |
| AI 通信 | ❌ 待 `js/ai/bridge.js`；本地代理见 `server.example.js` |
| 宿主 App 日程桥接 | ❌ 待实现 postMessage / 注入接口 |
| 字体 LXGW WenKai | ❌ 暂用系统字体 fallback |

---

## 技术栈

- **渲染**：Canvas 2D，`fillText` 逐字绘制
- **语言**：Vanilla JS ES6+ Module，零 npm 运行时依赖
- **视口**：390×700 逻辑像素，16px 格子
- **嵌入**：iOS / Android / 跨平台 App WebView
- **AI**：DeepSeek（开发期经 `server.js` 代理；上线由 App 后端或宿主提供等价 API）

---

## 目录结构

```
├── index.html              # Canvas + ui-overlay 骨架
├── css/app.css
├── js/
│   ├── app.js              # 主入口（当前为运动引擎 demo）
│   ├── core/               # grid, character, motion(PIBT), shape
│   ├── render/renderer.js
│   ├── input/gestures.js
│   ├── ai/bridge.example.js   # AI 通信模板（待实现 bridge.js）
│   ├── modes/              # （待建）interactive / conversation / game
│   └── ui/                 # （待建）overlay
├── tests/engine-behavior.mjs
├── server.example.js       # 本地开发服 + /api/chat 代理（复制为 server.js 使用）
└── docs…                   # 见上表
```

---

## 仓库

https://github.com/Reaor/ziling_new
