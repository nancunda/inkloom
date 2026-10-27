# 共创 Agent 2.0 与图谱 2.0：设计

日期：2026-10-27
范围：切片 1–4（切片 5 推演只留边界）
状态：待用户审阅
前置：[S1 世界模型与图谱设计](./2026-10-27-world-ontology-and-events-design.md)（数据模型不变）
技术核实：[图谱 / 搜索技术栈报告](../research/2026-10-27-graph-and-search-stack.md)

## 0. 一句话

把共创从「单 Agent 按计划跑」升级为「主 Agent + 四个只读专家子智能体 + 可自主联网」，把图谱从「按类分列的静态卡片流」升级为「可拖拽、可折叠、可查路径的本体图」，同时去掉会打断创作的章节 / 图片硬预算。

## 1. 背景与已确认决策

| 用户反馈 | 决策 |
|---|---|
| 图谱不像想象中的知识图谱 | 换 Cytoscape.js 渲染；类作 compound 分组；力导向/层次/同心布局；节点可拖、可框选、可高亮路径。**数据模型不动** |
| 用开源 / 成熟依赖实现本体知识库 | 图渲染用 Cytoscape.js 3.34；投影与查询复用 `packages/core`；**不引 RDF/OWL、不引图数据库、不引 Mastra**（理由见 §3） |
| 图谱要给共创模块调用 | 新增 `query_graph` / `find_path` / `explain_fact` 三个 Agent 工具，与前端共用同一份 snapshot |
| 所有模块边框要能拉 | `react-resizable-panels` 4.15 全站分栏，宽度按书持久化，双击重置 |
| 共创引入多智能体 | 保留 Pi Agent 内核，新增四个**只读**子智能体（researcher / worldbuilder / critic / stylist）+ `delegate` 工具；写操作仍由主 Agent 经 plan 门禁执行 |
| 去掉章节 / Token 预算 | 删除 `maxChapters` / `maxPortraits`；`maxSteps` 提到 `80 + 2×任务数`；耗尽改为 `paused` 可继续，不判失败 |
| 给智能体联网搜索 | `web_search` + `read_url` 工具；多 provider 降级链，零 API key 也能用；结果落资料卡 |
| 世界推演要好好想 | 本 spec 只留边界（§8），事件与沙盘另写 spec |

### 1.1 已确认的四个选择

1. 切片顺序：**共创急救包 → 图谱 2.0 → 多智能体 → 全站布局 → 推演**。
2. 多智能体落地：**Pi Agent + 角色子智能体**，不重写 run-service。
3. 预算：**去章节/图限，留步数保护**（暂停可继续）。
4. Critic 时机：**每个任务 `done` 前自动跑一次**。

## 2. 范围

### 做

- `RunBudget` 瘦身；`AgentRunStatus` 新增 `paused`；暂停/继续闭环
- 搜索 provider 抽象 + 降级链 + 熔断 + 正文提取
- Agent 工具 `web_search`、`read_url`、`read_lore`、`query_graph`、`find_path`、`explain_fact`、`delegate`
- 资料卡：复用现有 `LoreReference` 表与 `loreReferenceSchema`
- Cytoscape 图谱画布、布局切换、过滤、框选、路径高亮、位置持久化
- core 新增 `matchPattern` / `findPath` / `explainFact` 纯函数
- 四个只读子智能体与 `delegate` 编排；Critic 自动门禁
- 全站 `react-resizable-panels` 分栏
- 设置页新增搜索 provider 配置与 Critic 开关

### 不做

- RDF / OWL / SPARQL、图数据库（Kuzu / LadybugDB / Neo4j）
- Mastra / LangGraph 重写编排
- 从正文自动抽取实体并写正史
- 向量库 / RAG / embedding
- 事件、沙盘、世界线（切片 5）
- 技能包分级校验（S3）
- 修改既有 12 个实体文件的格式
- 新增 Prisma 表（`LoreReference` 已存在）
- 重写关系网络与地图页（继续用 React Flow）

## 3. 技术选型与证据

| 选择 | 版本 / 许可 | 依据 | 放弃项与理由 |
|---|---|---|---|
| Cytoscape.js | 3.34.4 / MIT / 137KB gzip / 2026-10-15 | 唯一同时内置 compound 分组、5 类布局、pagerank + 三类中心性 + 连通分量、dijkstra/aStar 且 `.path()` 直接回传元素；官方支持 Node headless | G6 5.1：npm 5.5 个月未发版、算法包 2023 停更、400KB gzip；Sigma：无 compound/无布局/无算法；React Flow：无布局无算法、DOM 节点千级上限 |
| react-resizable-panels | 4.15.0 / MIT / 2026-10-24 | 支持 `autoSaveId` 持久化、键盘拖拽、min/max | allotment 更重、偏 VS Code 风格 |
| @mozilla/readability + linkedom | 0.6.0 / 0.18.14 | Firefox 阅读模式同源正文识别；linkedom 只在 Node 侧（75KB），不进前端包 | cheerio 无 DOM 不能驱动 Readability |
| 搜索降级链 | Tavily / SearXNG / DDG lite | 有 key 用质量最好的，零 key 也有兜底 | 自托管 SearXNG 需要 Python + Redis，与 Windows 便携版冲突；Brave 需绑卡、Firecrawl keyless 端点未核实，本轮都不做 |
| 不引 RDF/OWL | Oxigraph 0.5.13 纯 WASM 4.3MB | 只做内存态、每次变更要重导出；本项目查询是 1–2 跳邻居与路径 | 标准化导出的收益不足以抵消成本 |
| 不引图数据库 | Kuzu 已归档；LadybugDB 有 win32 预编译 | LadybugDB 运行时仍依赖 cmake-js 回退构建，便携包 +15MB，万级内存查询已毫秒级 | 列 P3 观察，不进本轮 |
| 不引 Mastra | @mastra/core 1.79.0 | 生态成熟但会重写 run/审批/流式/检查点；2026 年其生态发生过 npm 投毒事件 | 保留 Pi Agent，角色子智能体在工具层实现 |

## 4. 切片 1：共创急救包

### 4.1 去掉章节 / 图片硬预算

**类型改动**

```ts
// apps/api/src/agent/tools.ts
export interface RunBudget {
  steps: number
  maxSteps: number
  /** 仅统计，用于界面展示；不再拦截 */
  chapterCalls: number
  portraitCalls: number
}
```

**行为改动**

- `run-service.ts`：初始化去掉 `maxChapters` / `maxPortraits`。
- `tools.ts`：删除 `generate_chapter` 与 `generate_portrait` 里的额度检查；仍累加 `chapterCalls` / `portraitCalls` 供 UI 显示。
- `refreshPlanBudget`：`maxSteps = Math.max(80, 80 + 2 * plan.tasks.length)`。
- `AgentRunStatus` 增加 `'paused'`。
- 步数耗尽：`beforeToolCall` 仍 block；`drive` 收尾（现有 `run-service.ts` 291–297 行的 `failRun` 分支）改为 `pauseRun`：状态 `paused`、`error=null`、任务保持 `doing`，不再判失败。
- `resumeAgentRun` 接受 `paused`：重置 `steps=0`，其余同现有逻辑。
- `request_review` 等待作者时仍是 `waiting_review`，不混用 `paused`。

**UI**

- AgentPage 预算行改为：`步数 12/96 · 子智能体 3 次 · 12,540 tokens`。
- `paused` 显示「已暂停 · 继续执行」按钮；`failed` 文案不再出现「额度已用完」。

**测试**

- `run-service.test.ts`：步数耗尽 → `paused` 且任务仍 `doing`；resume 后继续；章节/图片调用超过 2 次不再被拒。
- `plan-tools.test.ts`：`generate_chapter` 连续调用 3 次都成功。

### 4.2 搜索 provider 抽象

**文件**

```
apps/api/src/search/
  types.ts        SearchHit / SearchProvider / SearchOptions
  tavily.ts       已有，适配新类型
  searxng.ts      新增
  duckduckgo.ts   新增
  firecrawl.ts    新增
  service.ts      降级链 + 超时 + 熔断
  extract.ts      read_url 的正文提取
```

**类型**

```ts
export interface SearchHit {
  title: string
  url: string
  snippet: string
  publishedAt?: string
  provider: string
}

export interface SearchProvider {
  readonly id: 'tavily' | 'searxng' | 'duckduckgo'
  search(query: string, maxResults: number): Promise<SearchHit[]>
}

export interface SearchResult {
  hits: SearchHit[]
  provider: string | null
  degraded: boolean
  warnings: string[]
}
```

**降级链**

1. 有 `TAVILY_API_KEY` → Tavily
2. 有 `SEARXNG_BASE_URLS`（逗号分隔）→ 依次尝试
3. 无 key → DuckDuckGo lite

规则：

- 每个 provider 8s 超时；连续 2 次失败熔断 10 分钟（进程内 Map）。
- 成功的 provider 记在 `SearchResult.provider`；走到 DDG 时 `degraded=true`。
- 全部失败返回 `hits=[]`、`warnings` 包含每个 provider 的失败原因（截断到 120 字）。
- 结果不去重（不同 provider 的排序有价值），由调用方决定。

**环境变量**（写入设置页白名单）

```
TAVILY_API_KEY
SEARXNG_BASE_URLS      https://searx.example.com,https://searx2.example.com
```

### 4.3 工具 `web_search` / `read_url`

**`web_search`**

```ts
parameters: {
  query: string            // 必填
  maxResults?: number      // 1..8，默认 5
}
```

返回：

```
找到 5 条（provider=tavily）
1. 剑冢考据 — https://… — 摘要前 160 字（资料卡 lr-1a2b3c4d）
...
```

同时把每条命中写入 `LoreReference`（`approved=false`）。工具返回里带资料卡 id，模型可用 `read_lore` 读取全文。

**`read_url`**

```ts
parameters: {
  url: string              // http/https
  maxChars?: number        // 1000..12000，默认 6000
}
```

流程：URL 校验（拒绝 localhost、127/8、10/8、172.16/12、192.168/16、169.254/16、::1）→ 10s 超时 → 5MB 上限 → 按 `Content-Type` / `<meta charset>` 解码（`gb18030` 走 `TextDecoder`）→ `linkedom` 建 DOM → `Readability.parse()` → 正文。失败时退回 `body.innerText` 前 3000 字，并标注 `extracted=false`。

结果同样落 `LoreReference`（`content` 存正文，`snippet` 存前 300 字）。

**`read_lore`**

```ts
parameters: { id: string }
```

- 读取资料卡正文（≤ 4000 字）。本 run 产生的卡片（`usedInRunIds` 含当前 runId）可直接读；跨 run 的卡片必须 `approved=true`，否则返回 fail 并提示作者批准。
- 只读外部资料，不受 plan 门禁限制；模型调用本身已计步，不额外加步。

**权限**

- 两个工具都是只读外部，不受 plan 批准门禁限制。
- 但计入 `budget.steps`，且单次 `web_search` 只发 1 个请求。
- `read_url` 一次只读 1 个 URL，避免模型批量抓取。

### 4.4 资料卡（LoreReference）

复用现有表与 schema，不新增字段：

```ts
{
  id: 'lr-' + 8 hex,
  projectId,
  query,          // 搜索词；read_url 时填 URL
  provider,       // tavily | searxng | duckduckgo | url
  title, url, snippet, content,
  fetchedAt,
  usedInRunIds,   // JSON 数组，工具返回时追加当前 runId
  approved: false
}
```

- **只有 `approved=true` 的资料卡才允许进 prompt**（沿用现有 L3 规则）。
- 新增 HTTP：
  - `GET /api/lore?q=&approved=&limit=` — 列表
  - `POST /api/lore/:id/approve` — 作者批准
  - `DELETE /api/lore/:id` — 删除（未批准才可删）
- `read_lore` 的读取规则见 §4.3（本 run 直读，跨 run 需批准）。

### 4.5 设置页

新增分组「联网搜索」：`TAVILY_API_KEY`、`SEARXNG_BASE_URLS`；显示只读状态「当前可用 provider：tavily / duckduckgo」。
「任务后一致性检查」开关（`INKLOOM_CRITIC`）随切片 3 一起加，见 §6.3。

## 5. 切片 2：图谱 2.0

### 5.1 投影层：`GraphSnapshot → Cytoscape Elements`

新文件 `apps/web/src/lib/graph-elements.ts`（纯函数，可单测）：

```ts
export interface GraphElementData {
  id: string
  label: string
  kind: 'class' | 'instance'
  nodeType?: NodeType
  classId?: string
  predicate?: string
  virtual?: boolean
  retracted?: boolean
}
```

规则：

- 每个类生成一个 `kind:'class'` 节点，`label` 用类名，样式为分组框。
- 每个实例节点 `parent` = `classIds.at(-1)`（最具体类）；没有类时挂 `cls-concept`。
- `instanceOf` 边不画（它已经用 `parent` 表达），其余边照画。
- 虚拟边 `line-style: dashed`；已废止 `opacity: 0.25` + 灰色虚线。
- 边 `label` 用谓词中文名（沿用现有 `REL_LABEL` + `predicates` 注册表）。

**不做的投影**：不把类层级画成边（类树在左栏表达），避免与 compound 嵌套冲突。

### 5.2 组件拆分

```
apps/web/src/components/graph/
  GraphCanvas.tsx      Cytoscape 封装（约 180 行）
  GraphToolbar.tsx     布局切换 / 过滤 / 搜索 / 路径
  GraphLegend.tsx      节点类型与边型图例
  GraphDetail.tsx      详情栏（从 OntologyPage 抽出）
  useGraphLayout.ts    位置持久化
```

`GraphCanvas` 约束：

- `useRef` 持有 `Core` 实例；`useEffect` 只在挂载时 `cytoscape({...})`，卸载 `destroy()`。
- 数据变化走 `cy.elements().remove()` + `cy.add()`，不重建实例（StrictMode 双挂载安全）。
- 事件：`tap` 选中、`dbltap` 聚焦、`boxselect`、`cxttap` 右键菜单。
- 暴露命令式句柄：`fit()`、`runLayout(name)`、`focus(id)`、`highlightPath(ids)`、`resetHighlight()`。

### 5.3 布局与位置持久化

- 默认 `cose`；可选 `breadthfirst`（层级）、`concentric`（按度）、`grid`。
- 布局完成后把 `{nodeId: {x, y}}` 存 `localStorage`，key = `inkloom:graph-layout:<bookId>:<signature>`。
- 再次打开：先 `preset` 应用已存位置，再保留用户拖拽结果；`signature` 变了（书内容改了）就丢弃旧位置，避免错位。
- 切换布局会覆盖位置（明确提示「重新布局会重置拖拽位置」）。

### 5.4 过滤、搜索、路径

- **过滤**：节点类型多选、谓词多选、类多选（左栏类树点击）、「只看 N 跳邻居」（1/2/3）。
- **搜索**：输入名字/ID，命中的节点高亮并聚焦；无命中提示。
- **路径**：右键「设为起点」/「设为终点」；两端都有时调用 `GET /api/ontology/path?from=&to=&maxDepth=4`，高亮返回的节点与边，其余淡出；详情栏逐跳显示「林岚 —师徒→ 玄真」。
- 清除路径：工具栏「清除高亮」。

### 5.5 core 新增纯函数

`packages/core/src/ontology/query.ts`：

```ts
export interface GraphPattern {
  classId?: string
  nodeType?: NodeType
  predicate?: string
  from?: string
  to?: string
  attr?: Record<string, string>
  limit?: number
}

export interface PatternResult {
  nodes: GraphNode[]
  edges: GraphEdgeView[]
}

export function matchPattern(snap: GraphSnapshot, pattern: GraphPattern): PatternResult
export function findPath(snap: GraphSnapshot, from: string, to: string, maxDepth?: number):
  { nodes: GraphNode[]; edges: GraphEdgeView[]; found: boolean }
export function explainFact(snap: GraphSnapshot, from: string, predicate: string, to: string):
  { found: boolean; direct: boolean; via: string[]; reason: string }
```

规则：

- 只看未废止、非 tombstone 的边；虚拟边参与邻居与路径，但 `explainFact` 会标注 `virtual`。
- `classId` 走类闭包（子类实例也算）。
- `attr` 只匹配字符串属性，相等比较。
- `limit` 默认 50，上限 200。
- `findPath` 用 BFS，`maxDepth` 默认 4、上限 8；返回最短路径（边数最少），同长度取字典序稳定结果。
- 全部纯函数、零 IO，输入 `GraphSnapshot`。

### 5.6 API 变更

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ontology/graph` | 不变；前端用返回的 snapshot 自行投影 |
| GET | `/api/ontology/path?from=&to=&maxDepth=` | 新增，返回 `{found, nodes, edges}` |
| POST | `/api/ontology/query` | 新增，body = `GraphPattern`，返回 `PatternResult` |
| GET | `/api/ontology/explain?from=&predicate=&to=` | 新增，返回 `explainFact` 结果 |

`/graph` 不加 elements，避免后端与前端两套投影。

### 5.7 Agent 工具

- `query_graph(pattern)` → 返回 `matchPattern` 的 JSON + 一句摘要（节点数/边数）。
- `find_path(from, to, maxDepth?)` → 返回 `found` + 逐跳文本 + JSON。
- `explain_fact(from, predicate, to)` → 返回 `reason`（直接边 / 经 N 跳 / 子类推导 / 不存在）。
- 都通过 `getGraphSnapshot()`（已有 service）；工具描述里写明「图谱是只读的，改设定请用 write_element」。

### 5.8 `read_book` 摘要追加图谱概况

`renderSnapshot` 末尾追加一段（≤ 800 字）：

- 节点 / 边 / 类数量
- 每类实例数（前 8 个类）
- `error` 级 issue 数量与前 3 条
- 最近 5 条已批准资料卡（id + 标题）

这段同时给 `worldbuilder` 与 `critic` 用，不额外增加 `read_book` 的体积上限。

### 5.9 页面改造

- `OntologyPage.tsx` 保留三栏结构，但画布换成 `GraphCanvas`；类树、详情、问题面板逻辑抽出。
- 删除 React Flow 专用代码（`flow` useMemo、`col-` 标题节点、`nodeTypes`）。
- 关系网络页（`RelationGraph.tsx`）与地图不改。

## 6. 切片 3：多智能体

### 6.1 角色定义

`apps/api/src/agent/roles.ts`：

```ts
export type AgentRoleId = 'researcher' | 'worldbuilder' | 'critic' | 'stylist'

export interface AgentRole {
  id: AgentRoleId
  label: string
  systemPrompt: string
  tools: string[]
  maxSteps: number
  /** critic 返回结构化 JSON；其余返回自然语言摘要 */
  output: 'text' | 'json'
}
```

| 角色 | 职责 | 工具白名单 | 步数上限 |
|---|---|---|---|
| `researcher` | 联网找资料、读网页、整理资料卡 | `web_search` `read_url` `read_lore` `read_book` | 6 |
| `worldbuilder` | 读现有设定与图谱，给出「该补哪些节点/边/规则」的建议 | `read_book` `read_element` `query_graph` `find_path` | 5 |
| `critic` | 只读一致性检查：本次产物 vs 设定/图谱/事件 | `read_book` `read_element` `query_graph` `find_path` `explain_fact` | 5 |
| `stylist` | 文风与对话建议（不写文件） | `read_book` `read_element` | 4 |

**统一约束**

- 子智能体工具集**不含** `write_element` `write_blueprint` `generate_chapter` `generate_portrait` `write_plan` `update_plan` `update_task` `request_review` `delegate`。
- 因此子智能体天然只读、不能递归派活、不能绕门禁。
- 子智能体的工具调用计入主 `budget.steps`；每个子任务额外有 `maxSteps` 上限。
- 子智能体使用同一模型与 `streamFn`，`thinkingLevel: 'low'`。

### 6.2 `delegate` 工具

```ts
parameters: {
  role: 'researcher' | 'worldbuilder' | 'critic' | 'stylist'
  task: string          // 具体要它做什么，≤ 500 字
  context?: string      // 需要它知道的背景，≤ 2000 字
}
```

- 主 Agent 调用后，服务端 `runSubagent()` 同步跑完再返回；不做并行（保持工具执行顺序，避免写冲突）。
- 返回：

```
[researcher] 用了 3 步，找到 4 条资料，已落资料卡 lr-a1b2c3d4 / lr-e5f6a7b8。
摘要：……
```

- 子智能体的中间事件以 `subagent.*` 推给前端，UI 折叠展示，不打断主对话流。

### 6.3 Critic 自动门禁

`update_task(status='done')` 时，工具内部：

1. 若 `INKLOOM_CRITIC=off` 或没有 `critic` 依赖 → 直接写 `done`。
2. 否则调 `runSubagent('critic', task)`，输入：任务 title/brief、本次 artifacts、`read_book` 摘要、图谱概况。
3. critic 输出 JSON：

```json
{
  "conflicts": [
    { "severity": "error", "message": "第 3 章写到林岚已筑基，但角色卡仍是炼气", "evidence": ["characters/index.json#c1", "chapters/003"] }
  ],
  "suggestions": ["补一条 events 记录"]
}
```

4. `severity='error'` 存在 → `update_task` 返回 `fail`，任务保持 `doing`，附冲突列表与修复建议；主 Agent 必须先修再 `done`。
5. 只有 `warning` / 无冲突 → 写 `done`，把报告摘要放进工具返回。

成本控制：critic 每任务一次，`maxSteps=5`，`thinkingLevel:'low'`；设置页可关。

### 6.4 UI

- 子智能体卡片：角色标签、任务摘要、状态（running/done/failed）、步数、耗时、结果摘要；默认折叠。
- 预算行：`步数 12/96 · 子智能体 3 次 · 12,540 tokens`。
- `paused` 状态：黄色徽标 + 「继续执行」。
- critic 冲突：在任务卡片上显示红色「发现 N 处矛盾」，点开看 evidence。

### 6.5 测试

- `roles.test.ts`：每个角色的工具白名单不含写工具、不含 delegate。
- `subagent.test.ts`：mock LLM，验证步数上限、token 记录、事件序列。
- `plan-tools.test.ts`：`update_task(done)` 在 critic 报 error 时保持 doing；无冲突时写 done。
- 集成：一次 run 里 `delegate('researcher')` 返回资料卡 id；`delegate` 递归被拒。

## 7. 切片 4：全站可拖拽

- 新增 `apps/web/src/components/Split.tsx`：封装 `PanelGroup / Panel / PanelResizeHandle`，统一 2px 手柄 + hover 高亮 + 双击重置。
- 改造：
  - `AppShell`：左导航 ↔ 主工作区（`autoSaveId="inkloom:shell:<bookId>"`）
  - `WritingPage`：章节列表 ↔ 正文 ↔ 右栏
  - `CastPage`：列表 ↔ 详情
  - `OntologyPage`：类树 ↔ 画布 ↔ 详情
  - 素材页与故事页是单列布局，不改
- 尺寸约束：导航 140–280px；章节列 220–420px；正文最小 480px；详情栏 280–560px；画布最小 360px。
- 持久化按书隔离；切书后使用该书上次的宽度。
- 不改业务逻辑与数据流。

## 8. 切片 5：推演（只留边界）

不在本轮实现。研究结论见 [世界推演模式](../research/2026-10-27-world-simulation-patterns.md)，下一份 spec 按以下已定结论展开：

- **正史 = append-only 事件日志 + 纯函数 fold + 章节快照**：`replay(events, rulesVersion) -> {state, stateHash}`；快照只是缓存，不是真相。
- **沙盘 = fork 点 + 差异事件集**：只存 fork 之后的差异，前缀引用 fork 点；不复制正史，也不用「事件子集」（会丢前缀状态与顺序）。
- **提案—硬校验—软校验—作者采纳** 四拍：硬规则用纯函数，软判断用只读 LLM critic，作者唯一 commit。
- **单写者**：v1 最多 1 个世界 agent + 2–3 个角色提案器，不做自治多 agent 自由对话。
- **采纳 = rebase**：逐条追加、重排 `timeOrder`、校验前置、写 `adoptedFrom/supersedes`；冲突默认拒绝。
- 事件字段扩展（`requires` / `invalidates` / `intent` / `ruleTrace` / `evidence` / `confidence`）随下一份 spec 一起改数据模型。

本轮只保证：`query_graph` / `find_path` / `explain_fact` 与资料卡是沙盘的查询底座。

## 9. 验收标准

1. 一个会话连续生成 2 章正文，不再出现「正文额度已用完」。
2. 步数耗尽 → 状态 `paused`、任务仍在 `doing`、点「继续执行」能接着跑。
3. Agent 自主 `web_search`：有 key 返回 `provider=tavily`；无 key 走 DDG/Firecrawl 且 `degraded=true`，页面有提示。
4. `read_url` 能抓中文网页正文（含 gb18030 页面），失败时降级为纯文本并标注。
5. 资料卡落库；未批准的卡片不会出现在 prompt 里。
6. 图谱：默认 cose 力导向；类可折叠；节点可拖；框选可用；两个节点能查路径并逐跳解释；刷新后位置保留。
7. 图谱工具：`query_graph` / `find_path` / `explain_fact` 在对话里能返回正确结果（用七霞真实书核对）。
8. `delegate` 四个角色可用；critic 在任务 `done` 前自动跑；矛盾能阻断 `done`。
9. 全站分隔条可拖、刷新保持、双击重置；最小宽度生效。
10. `pnpm verify` 全绿；现有 332 单元 + 322 集成不回归。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Cytoscape × React 19 StrictMode 双挂载 | 实例放 `useRef`，`useEffect` 只 init 一次，卸载 `destroy()`；数据更新不重建 |
| `@types/cytoscape` 3.31 落后于 3.34 | 局部 `as` 断言；不扩散到业务类型 |
| 搜索源 403 / 429 | 降级链 + 熔断 + 明确 `degraded` 提示；不静默失败 |
| 多智能体成本上升 | 子任务 `maxSteps` 上限 + 主步数保护 + Critic 可关闭 |
| 资料卡污染上下文 | 沿用 `approved=false` 默认，只有作者批准才进 prompt |
| 布局位置错位 | 位置 key 带 `signature`；内容变更即丢弃旧位置 |
| `gb18030` 解码依赖 full-icu | Node 官方发行版已含；便携版构建时验证，失败则退回 utf-8 并标注 |

## 11. 兼容与迁移

- 不新增 Prisma 表；`LoreReference` 已有表与 schema，只需补读写代码。
- 不修改 `characters/`、`world/`、`story/` 既有文件格式。
- `/api/ontology/graph` 响应保持向后兼容；新增 3 个只读端点。
- `RunBudget` 删字段属于内部类型，前端 `AgentRunBudget` 同步删；没有外部消费者。
- `AgentRunStatus` 新增 `paused`；前端 switch 需补分支，旧状态不受影响。
- 搜索 provider 抽象保留 `createTavilySearch` 的导出，现有测试只改类型引用，不改行为。
