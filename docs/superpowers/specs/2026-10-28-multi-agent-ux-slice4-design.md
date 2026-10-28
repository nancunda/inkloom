# 切片 4：共创的多智能体可用性、可读性与会话管理

**日期**：2026-10-28
**上游**：`2026-10-28-multi-agent-slice3-design.md`（切片 3 已落地：roles / subagent / critic / delegate / 前端卡片）
**配套计划**：`docs/superpowers/plans/2026-10-28-multi-agent-ux-slice4.md`

---

## 0. 一句话

把共创从「一次性对话」升级为「可回看、可续接的会话」，让子智能体的运行与产出在 AgentPrism 的 trace 形态下清楚可见；子体步数触顶不再等于失败。

---

## 1. 已确认决策

| 决策点 | 选择 | 依据 |
|---|---|---|
| 子体步数触顶 | **部分结论放行**：有文本即返回 `partial`，主 Agent 继续；无文本才算失败 | 真实数据：4 次子体调用 3 次因触顶失败，已拿到的资料被一起丢弃 |
| 会话历史 | **可继续对话**（真续接：messages 快照 + `transformContext` 裁剪） | Pi 的 `AgentInitialState` 接受 `messages`，技术上成立 |
| 对话界面 | **完全改用 AgentPrism 的 trace 形态**（会话列表 / span 树 / 详情） | 用户拍板 |
| 子体产出 | 完整结论（≤6000 字）在右栏 Output 可见，span 行显示摘要 | trace 形态下 span 是行不是卡片 |
| 引入方式 | `degit` 复制组件源码入库 + 8 个依赖 + Tailwind 4 `@theme inline` 适配 | spike 已验证：76 文件 / 4367 行，仅 4 处类名需微调，**不需要造 OTLP** |

### 1.1 spike 结论（已执行，2026-10-28）

- 组件源码：`npx degit evilmartians/agent-prism/packages/ui/src/components` → 76 文件 / 4367 行
- 第三方依赖只有：`@evilmartians/agent-prism-types`、`@evilmartians/agent-prism-data`、`@radix-ui/react-collapsible`、`@radix-ui/react-tabs`、`classnames`、`lucide-react`、`react-json-pretty`、`react-resizable-panels`
- Tailwind 4 破坏性类名仅 4 处：`rounded-sm`×2、`outline-none`×1、`shadow-sm`×1
- 主题：`theme.css` 提供 `--agentprism-*` 的 Oklch 分量；需要写一份 `@theme inline` 把它们映射成 `--color-agentprism-*`（165 处 `bg-agentprism-*` / `text-agentprism-*` 依赖）
- `TraceSpan` / `TraceRecord` 是纯数据结构，可直接构造，**不经过 OTLP adapter**
- `TraceViewer` 是受控度较低的一体化组件；本切片改用 **TraceList + TreeView + DetailsView 组合**（官方 Custom Layout 玩法），这样会话切换与按需加载完全可控

---

## 2. 范围

### 做

1. 子体软着陆：触顶 → `partial` 成功；子体提示词加上限与止损规则
2. 事件补字段：`subagent.ended.partial` / `.text`；事件带 `runId`
3. 会话模型：`Session`（可续接）与 `Run`（一次执行）分离，会话索引与消息快照落盘
4. 真续接：messages 快照 + `transformContext` 裁剪 + system/tools 重建
5. TraceSpan 映射层（纯函数）：会话事件 → `TraceRecord` + `TraceSpan[]`
6. 共创页重构：会话列表 / span 树 / 详情（含新增「正文」tab）/ 顶栏门禁与预算 / 底部输入
7. AgentPrism 源码引入 + Tailwind 4 主题适配
8. 会话接口：列表 / 回放 / 重命名 / 删除 / 续接

### 不做

- 不做 OTLP / Langfuse 导出（用不到 adapter）
- 不做多用户、权限、跨书会话
- 不迁移旧 journal 的「续接」能力（legacy 会话只读回看）
- 不做移动端深度优化（沿用组件自带 mobile layout）
- 不改 critic 的判定规则（切片 3 已定）

---

## 3. 子体软着陆

### 3.1 判定表（`runSubagent` 收尾）

| 情况 | `ok` | `partial` | `error` | 说明 |
|---|---|---|---|---|
| 正常结束 | `true` | `false` | `null` | |
| 步数触顶，已有 `text` | `true` | `true` | `步数上限（N 步）` | ★ 新增：结论可用但不完整 |
| 步数触顶，`text` 为空 | `false` | `false` | `步数上限（N 步）` | 真失败 |
| 超时，已有 `text` | `true` | `true` | `子任务超时（Nms）` | |
| 超时，`text` 为空 | `false` | `false` | `子任务超时（Nms）` | |
| 被停止 | `false` | `false` | `运行已停止` | 作者主动停 |
| 模型/构造异常 | `false` | `false` | 原错误 | |

规则：`ok = error === null || text.trim().length > 0 && error ∈ {步数上限, 超时}`。

### 3.2 子体提示词（`roles.ts` 的 `READ_ONLY` 之后追加一段通用约束）

```
# 步数纪律
你最多能调用 N 次工具（N 由系统在任务里给出）。每次工具失败都算一步：
- read_url 连续失败 2 次就停止读网页，改用 web_search 的摘要。
- web_search 连续失败 2 次就停止检索，直接说明拿不到资料。
- 步数用满前必须先给出结论：宁可结论短、带"未核实"标注，也不要空手结束。
```

`delegate` 工具的 `task` 文本里由调用方补 `本次最多 N 步`（N = `AGENT_ROLES[role].maxSteps`），让子体知道自己有多少预算。

### 3.3 `delegate` 返回给主 Agent

- 成功：`【研究员·完成】…`（现状不变）
- `partial`：`【研究员·未跑完（步数上限 12 步）】以下结论可能不完整，需要更多信息就再派一次更窄的任务：\n…`
- 失败：现状（带部分结论时保留）

### 3.4 事件

`subagent.ended` 增加：

```ts
partial: boolean      // 触顶/超时但有结论
text: string          // 完整结论，按码点截到 6000 字（journal 会变大，可接受）
```

前端：`partial` → 状态 `warning`（琥珀），文案「已收尾 · 步数上限」，不再显示红色「未跑完」。

---

## 4. 会话模型与存储

### 4.1 概念

```
Session（可续接的共创会话，落盘）
  └── Run（一次执行，内存；每次「开始 / 继续」都新建）
```

- `Session.id = cs_<12hex>`；`Run.id = ar_<12hex>`（沿用现状），Run 增加 `sessionId`
- 一个 Session 的事件写在**同一个 journal 文件**里（多次 Run 按时间追加）
- 每个事件增加 `runId` 字段；`seq` 仍是 **per-run** 递增（SSE 去重语义不变）

### 4.2 目录布局（书内）

```
.inkloom/agent/
  sessions/
    <sessionId>.jsonl        # 事件流（append-only）
    <sessionId>.meta.json    # 会话元信息（每次状态变化覆盖写）
    <sessionId>.messages.json# 消息快照（剥离 system；用于真续接）
  runs/
    ar_*.jsonl               # 切片 3 的旧 journal → 视为 legacy 会话
```

### 4.3 `AgentSessionMeta`

```ts
interface AgentSessionMeta {
  id: string
  title: string            // 默认 goal 前 40 字，可 PATCH 重命名
  goal: string
  status: 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped' | 'legacy'
  createdAt: string
  updatedAt: string
  tokens: number
  steps: number
  subagentCalls: number
  planId: string | null
  planTitle: string | null
  planDone: number
  planTotal: number
  runIds: string[]
  /** 有 messages 快照 且 会话未在运行 → 可续接（计划缺失也允许，只是没有计划上下文） */
  resumable: boolean
}
```

写入时机：会话创建、run 开始、`gate.waiting`、`run.paused`、`finished/failed/stopped`、重命名。全部走 `writeQueue`。

### 4.4 messages 快照（`.messages.json`）

```ts
type MessageSnapshot = {
  version: 1
  savedAt: string
  sessionId: string
  runId: string
  /** 已剥离首条 system message（工具声明会随代码变化，不能复用旧 system） */
  messages: AgentMessage[]
}
```

写入时机：`run.finished / paused / failed / stopped`（含 `stopAgentRun`）。崩溃时最多丢最后一轮，可接受。

### 4.5 旧 journal 兼容

启动/列会话时若发现 `runs/*.jsonl` 且无对应 `sessions/*.meta.json`，生成 `legacy` 会话项：`id = lg_<runId>`，`title` 取首条 `run.started.goal`，`status = 'legacy'`，`resumable = false`。回放时 events 从 `runs/<runId>.jsonl` 读取。不移动、不删除旧文件。

---

## 5. 真续接

### 5.1 恢复流程（`POST /agent/sessions/:id/messages`）

1. 读 `.meta.json`；若 `status === 'running'` → `409 CONFLICT`
2. 读 `.messages.json`；缺失 → `409 CONFLICT`「这个会话没有可续接的记录」
3. 读当前计划（`planId`）；计划缺失 → 允许，但 run 不带 plan 上下文
4. 新建 Run（`sessionId` 绑定），组装依赖（与 `startAgentRun` 同一份代码路径）
5. `new Agent({ initialState: { systemPrompt: 当前 prompt, model, thinkingLevel, tools, messages: snapshot.messages }, transformContext })`
6. `emit({ type: 'run.started', goal: 新消息 })` → `agent.prompt(新消息)`
7. 结束/暂停时照常写 meta 与 messages 快照

### 5.2 `transformContext` 裁剪（`apps/api/src/agent/history.ts`）

目标：恢复长会话时不把上下文撑爆，同时保留最近决策。

```
输入 messages（已剥离 system）→ 输出 messages'
规则（从新到旧扫描，累计字符预算 120_000）：
1. 最近 8 条消息（user/assistant/toolResult）原样保留
2. 更早的 toolResult：content 文本截到 500 字，加“…（早期工具输出已压缩）”
3. 更早的 assistant：保留文本前 800 字；思考内容丢弃
4. 超出预算时，从最旧开始丢弃整条；保留首条 user（作者原始目标）
5. 永远不丢最近 2 条
```

导出 `compactMessages(messages, opts)` 纯函数，单测覆盖（预算、最近 8 条、toolResult 截断、首条 user 保留）。

### 5.3 边界

| 情况 | 行为 |
|---|---|
| messages 快照含 system | 读取时丢弃所有 `role === 'system'` 的消息，用当前 prompt 重建 |
| 工具集变化（如 `INKLOOM_CRITIC` 开关） | 因 system 重建，工具声明自动更新 |
| 计划已被作废/换书 | 续接仍可进行，只是工具会返回「还没有计划」；meta 里 `planId` 置空 |
| 会话正在运行 | 409 |
| 旧会话（legacy） | `resumable=false`，前端禁用输入 |
| messages 体积 > 8MB | 保存前按 5.2 规则压缩一次（`savedCompacted: true`） |

---

## 6. TraceSpan 映射（`apps/web/src/agent-trace/to-trace.ts`）

纯函数，输入 `{ meta, events }`，输出 `TraceViewerData`。

### 6.1 结构

```
TraceRecord: { id, name: title, spansCount, durationMs, agentDescription, startTime, totalTokens, totalCost? }
root span: agent_invocation「主笔」
  ├─ llm_call「思考/回复 #n」       input=上一条 user/tool 摘要, output=assistant 文本, reasoning={content: thinking}, tokenUsage
  ├─ tool_execution「工具名」        input=args JSON, output=summary, status=ok/error/stopped
  ├─ agent_invocation「研究员」      input=task, output=完整结论, status=success/warning/error, tokenUsage, children=子体工具
  ├─ event「计划批准 / 打回 / 跳过」   input=feedback
  ├─ event「一致性检查」            由 update_task 返回文案推出（通过/未完成/矛盾）
  └─ chain_operation「计划《标题》」 children=每个任务（Span: 任务标题，status=done/doing/todo/blocked）
```

### 6.2 事件映射表

| 事件 | span | 关键字段 |
|---|---|---|
| `run.started` | 根 `agent_invocation` | `title = '主笔 · ' + goal 前 20 字`，`startTime` |
| `user.message` | `chain_operation`「作者」 | `output = text` |
| `thinking.delta` + `text.delta` | `llm_call`（按连续的 delta 段合并成一个） | `reasoning.content`、`output` |
| `tool.started` / `tool.ended` | `tool_execution`（用 `toolCallId` 配对） | `status`、`input=args`、`output=summary` |
| `subagent.started` / `tool` / `ended` | `agent_invocation`（`sa:` + id） | `children`、`output=text`（无则 summary）、`status` |
| `plan.updated` | `chain_operation`「计划」 | children = 任务 span |
| `gate.waiting` / `gate.resolved` | `event` | `status=warning` / `success` |
| `run.paused / failed / stopped / finished` | 根 span 的 `status` + `output` | 状态映射 |
| 未知类型 | `span`（`status='success'`） | `raw` 保留 JSON |

- 所有 span：`raw: [JSON.stringify(event)]`，`startTime/endTime` 由 `at` 与下一事件时间推出
- 子体没有 `ended`（进行中）→ `status='pending'`
- 状态映射：`run.failed/tool error` → `error`；`partial` → `warning`；其余 `success`

### 6.3 多 Run 合并

同一会话的多个 run 事件连续排列。第 2 个及以后 run 的 `run.started` 不新建根 span，而是生成 `event`「继续对话」span，其后的 `llm_call` / `tool_execution` 仍挂在根 span 下（按时间顺序）。

---

## 7. 界面

### 7.1 布局（共创 module）

```
┌ 顶栏：书名 · 会话标题（双击重命名） · 状态徽标 · 步数/子智能体/tokens · [计划 3/5] [停止] [继续执行] [重新规划] [新会话]
├ 门禁横幅（仅 gate.waiting）：计划/任务待批准 → [批准] [打回…] [跳过]
├ 左：会话列表（TraceList：标题/时间/状态/tokens，支持搜索，运行中的会话带脉冲点）
│ 中：span 树（TreeView：搜索、展开/折叠全部、状态点、耗时条）
│ 右：详情（DetailsView + 自定义 tab：产出 / 输入 / 属性 / 原始 / 正文 / 计划）
└ 底部：输入框（发送 → 续接或 steer） + 预算提示
```

顶栏按钮按状态显示：`running` → [停止]；`paused/stopped/failed` → [继续执行] [重新规划]；`waiting_review` → [重新规划]（门禁在横幅里操作）；任意状态 → [新会话]。

- 只有「当前会话在运行」时输入框可用；历史会话选中时显示「基于此会话继续」按钮（点击 → 续接，输入框启用）
- 顶栏「计划 N/M」按钮：打开右栏的「计划」tab（任务列表 + 状态 + 产物），不离开 trace
- 正文 tab：只读预览当前选中章节（默认第 1 章），底部「去写作页」链接
- 移动端：沿用 `TraceViewerMobileLayout` 的三段式（tab 切换）

### 7.2 会话切换与加载

- `GET /agent/sessions` 只返回 meta（不解析 jsonl）
- 选中会话 → `GET /agent/sessions/:id?limit=2000` 拉事件 → `toTrace()` → `setSpans`
- 当前运行中的会话：SSE 增量 → 追加到本地 events → 重新 `toTrace()`（节流 200ms）
- 切换会话时清空选中 span

### 7.3 组件改造（我们拥有源码）

- `DetailsView` 增加 `extraTabs?: { key, title, icon?, content }[]`，插在 Raw 之前
- `TraceList` 增加可选 `onRename` / `onDelete`（右键菜单或行尾 `…`）
- `SpanCard` 的 `title` 用中文；子体 span 通过 `avatar` 显示角色徽标色

---

## 8. AgentPrism 引入与 Tailwind 4 适配

### 8.1 落位

```
apps/web/src/components/agent-prism/    # degit 复制，入库，由我们维护
apps/web/src/components/agent-prism/NOTICE.md  # 上游 commit、许可证、改动清单
```

- 上游：`github.com/evilmartians/agent-prism`（MIT），记录复制时的 commit SHA
- 依赖加入 `apps/web/package.json`
- 升级策略：不自动跟随上游；需要时重新 degit + 按 NOTICE 里的改动清单重放

### 8.2 Tailwind 4 适配

`apps/web/src/index.css` 追加：

```css
@import "./components/agent-prism/theme/theme.css";

@theme inline {
  --color-agentprism-background: oklch(var(--agentprism-background));
  --color-agentprism-foreground: oklch(var(--agentprism-foreground));
  /* …按 theme/index.ts 的 AGENT_PRISM_TOKENS 全量生成… */
}
```

- 4 处类名调整：`rounded-sm→rounded-xs`（2）、`shadow-sm→shadow-xs`（1）、`outline-none→outline-hidden`（1）
- 这些改动写进 `NOTICE.md`

### 8.3 主题融合

`agentprism-*` 变量映射到项目现有的中性色与强调色（保持与其它模块一致）；不改上游 token 名。

---

## 9. HTTP 接口

| 方法 | 路径 | 请求 | 响应 | 错误 |
|---|---|---|---|---|
| GET | `/agent/sessions` | `?limit=50` | `{ sessions: AgentSessionMeta[] }` | — |
| GET | `/agent/sessions/:id` | `?limit=2000` | `{ meta, events }` | 404 |
| PATCH | `/agent/sessions/:id` | `{ title }` | `{ meta }` | 404 / 400（空标题）/ 409（运行中） |
| DELETE | `/agent/sessions/:id` | — | `{ ok: true }` | 404 / 409（运行中） |
| POST | `/agent/sessions` | `{ goal, mode?: 'new'\|'resume'\|'replan' }` | `{ run, meta }` | 409（已有运行中会话） |
| POST | `/agent/sessions/:id/messages` | `{ text }` | `{ run }` | 404 / 409（不可续接）/ 400（空消息） |

保留现有 run 级接口不变：`GET /agent/runs/:id`、`POST /agent/runs/:id/stop|review|resume`、`GET /agent/runs/:id/events`。

兼容：`POST /agent/sessions` 内部复用 `startAgentRun`；旧 `POST /agent/runs` 保留（前端不再调用，测试仍可用）。

---

## 10. 测试

### 单测

（沿用项目现状：web 层没有组件渲染测试，可测逻辑一律抽成纯函数）

- `compactMessages`：预算裁剪、最近 8 条、toolResult 截断、首条 user 保留、system 剥离
- `toTrace`：每个事件类型的 span、子体 children、partial → warning、多 run 合并、未知事件兜底
- `session-store`：meta 读写、legacy 会话补录、重命名、删除
- `runSubagent`：触顶有文本 → ok+partial；触顶无文本 → fail；超时有文本 → partial
- `delegate`：partial 返回文案含「不完整」与原因

### 集成

- `sessions` API：列表（含 legacy）/ 回放 / 重命名 / 删除 / 续接（含 409 分支）
- 续接：伪造 messages 快照 → 续接 → 新 run 的 prompt 含历史（用 FakeAgent 断言 `initialState.messages`）

### 真机验收（书《七霞》）

1. 新建会话 → 派研究员（12 步内完成）→ span 树里主/子层级与配色可辨；右栏 Output 读到完整结论
2. 造一个必定触顶的任务（如「查 10 个不同朝代的驿传」）→ 子体 `partial` 收尾（琥珀），主 Agent 继续，不中断
3. 刷新页面 → 左栏会话列表仍在；点开历史会话可回放完整 span 树
4. 重启 API → 历史会话仍可回放；点「基于此会话继续」发一句「把刚才的结论写成一条世界规则」→ 子体/工具能引用上文（真续接生效）
5. 门禁：计划待批准时顶部横幅可批准/打回，trace 形态下仍能推进
6. 截图 `docs/screenshots/accept-trace-viewer.png`

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| AgentPrism 是 Alpha，源码入库后由我们维护 | 上游修 bug 我们收不到 | NOTICE 记录 commit 与改动清单；只依赖 4 个组件的稳定 API |
| Tailwind 4 与组件预期不一致（视觉偏差） | 界面错位 | 先做一个 `SpanCard` + `TreeView` 的最小渲染验收，再铺开；`@theme inline` 全量映射 |
| Trace 形态损失「读对话」体验 | 作者不习惯 | 右栏 Output/Input 保留自然语言；span 标题用中文；工具/子体默认折叠 |
| 真续接把上下文撑爆 | 请求失败/变慢 | `transformContext` 硬预算 120k 字符 + 单测锁死 |
| messages 快照体积大 | 磁盘增长 | 保存前压缩（>8MB）、最多保留每会话 1 份 |
| 多 run 合并后 seq 不连续 | SSE 去重失效 | 事件加 `runId`；SSE 仍 per-run 去重；回放按文件行序 |
| 旧 journal 无法续接 | 用户困惑 | meta 里 `resumable=false`，前端明确标注「历史记录，只读」 |

---

## 12. 文件清单

### 新增

- `apps/api/src/agent/history.ts` — `compactMessages`、messages 快照读写
- `apps/api/src/agent/session-store.ts` — `AgentSessionMeta` 读写、索引、legacy 补录
- `apps/api/src/routes/sessions.ts` — 六个会话接口
- `apps/web/src/components/agent-prism/**` — 复制源码（76 文件）
- `apps/web/src/components/agent-prism/NOTICE.md`
- `apps/web/src/agent-trace/to-trace.ts` — 事件 → `TraceViewerData`
- `apps/web/src/agent-trace/to-trace.test.ts`
- `apps/web/src/agent-trace/SessionList.tsx` — TraceList 的封装（重命名/删除）
- `apps/web/src/pages/CocreatePage.tsx` — 新的共创页（替换 `AgentPage`）
- `apps/web/src/agent-trace/plan-view.ts` — 从 `plan.updated` 事件提取任务列表（供「计划」tab）

### 修改

- `apps/api/src/agent/subagent.ts` — `partial`、`text`、提示词注入
- `apps/api/src/agent/roles.ts` — 步数纪律段落
- `apps/api/src/agent/tools.ts` — delegate 的 partial 文案
- `apps/api/src/agent/run-service.ts` — `sessionId`、事件 `runId`、meta/快照写入、续接入口
- `apps/api/src/agent/book-snapshot.ts` — 复用 `agentRunDir`
- `apps/api/src/routes/agent.ts` — 保留 run 级接口，挂载 sessions
- `apps/web/src/api/types.ts` — `AgentSessionMeta`、事件新字段、`partial`
- `apps/web/src/index.css` — `@theme inline` + theme.css
- `apps/web/src/App.tsx` — 共创 module 指向 `CocreatePage`
- `apps/web/package.json` — 8 个依赖
- `README.md` — 共创章节改写（trace 视图、会话续接、partial）
- `.gitignore` — 忽略 `.tmp-spike/`

### 删除

- `apps/web/src/pages/AgentPage.tsx`（迁移完成后删除）
