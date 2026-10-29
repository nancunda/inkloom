# inkloom

[中文](README.md) · [English](README.en.md)

![version](https://img.shields.io/badge/version-0.1.0-3F5D4B?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Web-3F5D4B?style=flat-square)
![tests](https://img.shields.io/badge/tests-876%20passing-3F5D4B?style=flat-square)

**AI 与你共写长篇小说，稿子永远是你的。** 一本书 = 一个文件夹：正文是 Markdown，设定是 JSON，历史归 Git —— 删掉软件，稿子还在。

![阅读器](docs/screenshots/reader.png)

## 它和「又一个 AI 写作工具」不一样

| | inkloom | 常见的 AI 写作工具 |
|---|---|---|
| 数据在哪 | 本地文件夹，可 `git clone`、可整个拷走 | 别人的数据库 |
| AI 的权限 | 只提案：计划要你批准，正文要你接受 | 直接改写你的稿子 |
| 长篇结构 | 世界 / 角色 / 线索 / 节奏 都是结构化数据 | 一段长对话 |
| 历史 | 每次接受自动 commit，随时回退 | 撤销栈 |

## 十个模块

概览 · 共创 · 世界 · 角色 · 故事 · 图谱 · 写作 · 阅读 · 素材 · 设置

| 概览：进度、张力曲线、悬着的线 | 图谱：要素按类型分组，位置会记住 |
|---|---|
| ![概览](docs/screenshots/overview.png) | ![图谱](docs/screenshots/graph.png) |

## 共创 Agent：先批准计划，才动笔

![共创](docs/screenshots/cocreate.png)

- **计划驱动**：Agent 先写 `write_plan`，你在界面上批准后才允许改设定、写正文
- **多智能体**：`delegate('researcher')` 派子智能体去查资料，步数与 token 有上限，触顶如实收尾
- **一致性门禁**：任务说「做完了」之前，子 Agent 拿新内容比对全书设定；有矛盾就返回 `error`，任务不许关
- **全链路 trace**：每个 span 的耗时、token、输入输出都能点开；会话落在书里，重启还能续

## 正文排成一本书

双页对开、章扉页、CSS 多栏真分页（不是假滚动）：`←` `→` 翻屏，`c` 目录，`f` 沉浸，字号四档，读到哪记到哪，窄屏自动退化成单页。

## 桌面版：双击即用

![桌面版](docs/screenshots/accept-desktop.png)

Tauri 2 外壳 + 内置本地服务端，不用开浏览器、不用装 Node；随机端口、单实例、关窗即停。书库默认 `~/inkloom`，Key 存在 `%APPDATA%\inkloom\.env`（卸载不会带走）。

## 快速开始

### 桌面版（Windows，推荐）

从 [Releases](https://github.com/nancunda/inkloom/releases/latest) 下载 `inkloom_0.1.0_x64-setup.exe`，双击安装，从开始菜单启动。

### 便携版（无需安装）

下载 `inkloom-0.1.0-win-x64.zip` → 解压 → 双击 `start.bat` → 浏览器打开 `http://127.0.0.1:8787`。

### 开发版

```bash
pnpm install

# 终端 1：API（默认 127.0.0.1:8787，无鉴权，因此只绑本机）
pnpm api

# 终端 2：前端（Vite，/api 代理到 8787）
pnpm web                # → http://localhost:5173

# 桌面壳（需要 Rust 工具链）
pnpm --filter @inkloom/desktop dev
```

打包桌面版：先 `node scripts/build-release.mjs` 出便携版，再 `pnpm --filter @inkloom/desktop build`。

### 环境变量

写在仓库根目录的 `.env`（开发版）、`start.bat` 同目录的 `.env`（便携版），或直接用界面的「设置」页（桌面版写在 `%APPDATA%\inkloom\.env`）。

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 生成正文、共创 Agent |
| `SILICONFLOW_API_KEY` | 人物形象图（Kolors）、判断层 |
| `TAVILY_API_KEY` | 联网搜索（可选） |
| `SEARXNG_BASE_URLS` | 可选：SearXNG 实例，逗号分隔（无 key 时 DuckDuckGo 兜底） |
| `INKLOOM_LIBRARY` | 书库根目录，默认 `~/inkloom` |
| `INKLOOM_CRITIC` | 任务完成前的一致性检查，默认 `on`；`off` 关闭 |
| `INKLOOM_JUDGE` | 判断层：`off`（默认）/ `mock` / `openai` / `typesafe` |

没有 key 也能浏览、导入、编辑、导出与回退，只是不能调模型。

## 架构

| 铁律 | 含义 | 强制手段 |
|---|---|---|
| **文件是唯一事实源** | 一本书 = 一个文件夹，正文是 `.md` | `pnpm check-deps` |
| **`core` 零 IO** | 纯函数，不碰文件/网络/数据库 | 依赖扫描 |
| **要素 append-only** | 永不 UPDATE，回退 = 产生新版本 | JSONL 历史 + 写入串行队列 |
| **正文不进 revision** | 正文历史只归 Git | `EntityRevision` 里没有 `draft_segment` |
| **派生层可丢弃** | 索引与 Agent 日志不进版本历史 | 书内 `.gitignore` + 启动自愈 |

```
一本书/
├── novel.json                  身份锚与篇幅设定
├── chapters/ch-001.md          定稿正文（一章一文件）
├── chapters/ch-001/scenes/     候选场景 sN.vM.md（永远写新版本）
├── characters/ story/ world/   结构化要素（整表写入 + CAS）
└── .inkloom/                   索引（可重建）、revision 历史、Agent journal
```

| 包 | 职责 |
|---|---|
| `packages/shared` | Zod schema + 统一错误类型 |
| `packages/core` | 段标记、版本、状态推导、diff（零 IO） |
| `packages/prompt` | Prompt 装配（缓存友好 + 工具协议） |
| `apps/api` | 存储 + 服务层 + HTTP 路由 + Agent 运行时（唯一有副作用的地方） |
| `apps/cli` | 命令行，复用 api 服务层 |
| `apps/web` | React 19 工作台，只读 HTTP，SSE 接收 Agent 事件 |
| `apps/desktop` | Tauri 2 桌面壳：拉起便携版服务端 → 探活 → 窗口导航到本机端口 |

## 验证

```bash
pnpm verify      # biome + tsc + check-deps + 529 单元 + 347 集成
```

真机验收（联网搜索、多智能体、trace 续接、阅读器、桌面版安装/卸载）逐条记在 [docs/verification.md](docs/verification.md)。

## 已知缺口

| # | 缺口 | 影响 |
|---|---|---|
| 1 | Agent run 在内存 | 服务重启丢进行中的 run；会话与事件已落盘，可续跑 |
| 2 | 长会话未做虚拟化 | 数百 span 时滚动与展开可能变卡 |
| 3 | 前端无自动化 UI 回归 | 界面回归靠手工 |
| 4 | Agent 思考流是英文 | 模型自选语言；正文与工具参数是中文 |

## 版本

当前 **0.1.0**（2026-10-30）：首个公开版本，十个模块 + Windows 桌面版。变更见 [CHANGELOG.md](CHANGELOG.md)。
