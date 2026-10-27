# S1 世界模型与图谱（本体 + 事件）：设计

日期：2026-10-27
范围：S1 / 三个 spec 中的第一个
状态：待用户审阅（本文只定 S1；S2 沙盘、S3 技能包只给边界）

## 0. 一句话

把「故事」从散落的实体表升级成**类—实例—边—事件**的世界模型：作者在图谱上看世界，Agent 按问题查图与事件；所有推导可解释，所有图变更都要人批准。

## 1. 背景：现在缺什么

| 现有 | 缺口 |
|---|---|
| 人物、关系、签名、世界规则、力量体系、地点、路线、线索、卷、蓝图 | 实体各住各的文件，**边只覆盖人物↔人物、地点↔地点** |
| 角色按章动态状态（`stateChapter` + provenance） | **没有事件对象**：因果、推演、时间线、世界线都无处落脚 |
| 关系网络、线索轨迹、世界地图 | 三张图各画各的，**没有统一的节点/边模型** |
| `writingTechnique` + Agent 技能注册表 | 规则只是提示词文本，**不可执行、不可校验** |
| Agent `read_book` / `read_element` | 只能取整表，**不能按问题查图** |

四个用户体验诉求（本体、推演、模块因果、强制技能）里，S1 负责前三个的地基；S3 负责第四个。

## 2. 已确认决策

1. **一条正史 + 多条沙盒分支**：推演结果可逐颗「采纳为正史」；正文只读正史。
2. **本体 = 实例图 + 类层级**：不是纯标签，类上可挂属性定义与规则。
3. **推理只做三层**：继承与写入校验、查询期推导（传递闭包 / 逆关系 / 子类匹配）、每条推导可解释。不做 OWL 式全量一致性推理。
4. **沙盘主循环 = 事件链**（S2）：心理状态是事件的输入输出，时间步进与世界线分别是它的批处理与对比。
5. **图维护 = AI 提议 + 作者批准 + 作者可直接编辑**，共用一份追加式变更日志。
6. **技能包 = 方法 + 分级校验**（`deterministic` / `judge` / `human`，S3）。
7. **图存储 = 混合模式（C）**：实例仍住原文件；**类、附加节点、跨类型边、正史事件**是新增真相；节点在构建图时自动聚合。

### 2.1 本文额外的两个实现决策（与上一轮讨论不同，已标出）

- **D1：v1 不新增 Prisma 表**。图用文件直读 + 按 mtime 的进程内缓存构建。理由：典型书 < 1000 节点 / < 5000 边，构建 < 100ms；新增三张表要走迁移、改 reindex，收益不匹配。触发条件：单书边数 > 5000 或构建 > 150ms 时，再引入索引表，HTTP/工具签名不变。
- **D2：既有实体数据以「虚拟节点/虚拟边」进入图，不复制成新文件**。人物/地点/规则/线索/卷 → 虚拟节点；人物关系、路线 → 虚拟边（只读，改要去源模块改）。这样一开始就有图可看，且不会出现两份真相。

## 3. 范围

### 做

- `world/ontology/classes.json`：类 + 谓词注册表
- `world/ontology/nodes.jsonl`：**原文件没有对应实体**的附加节点（势力、物品、概念）
- `world/ontology/edges.jsonl`：跨类型边（append-only）
- `story/events.jsonl`：正史事件（append-only）
- 纯函数图引擎（`packages/core`）：构建、校验、推导、解释、模式匹配
- Agent 工具：`query_graph`、`query_events`、`propose_graph_edit`
- 新模块「图谱」：类树 + 画布 + 详情 + 待批变更
- 变革日志：提案 / 批准 / 驳回，追加式

### 不做

- OWL 类表达式、存在/全称限制、自动一致性证明
- 后台自主运行的世界模拟（S2 由作者驱动）
- 技能包格式与校验执行（S3）
- 从正文自动抽取并直接写正史（只能作为提案，且 S1 不实现抽取器）
- 向量库 / RAG
- 新 Prisma 表（见 D1）
- 改写既有 12 个实体文件的格式（一个字段都不加，见 D2）

## 4. 数据模型

所有文件都在书内，遵循「文件是真相」。写入一律走 `writeQueue` + `atomicWrite`；批准提案后 `git commit`。

### 4.1 类与谓词：`world/ontology/classes.json`

```json
{
  "version": 1,
  "classes": [
    { "id": "cls-character", "name": "人物", "parentId": null, "kind": "character" },
    {
      "id": "cls-cultivator",
      "name": "修士",
      "parentId": "cls-character",
      "kind": "character",
      "properties": [{ "key": "realm", "range": "string", "cardinality": "one" }],
      "rules": [
        {
          "id": "rule-cultivator-path",
          "severity": "hard",
          "kind": "requiresEdge",
          "predicate": "cultivates",
          "message": "修士必须有一条 cultivates 边（功法/体系）"
        }
      ]
    },
    { "id": "cls-group", "name": "组织", "parentId": null, "kind": "group" },
    { "id": "cls-sect", "name": "宗门", "parentId": "cls-group", "kind": "group" },
    { "id": "cls-place", "name": "地点", "parentId": null, "kind": "place" },
    { "id": "cls-rule", "name": "规则", "parentId": null, "kind": "rule" }
  ],
  "predicates": [
    { "id": "instanceOf", "label": "属于类", "domain": "any", "range": "class", "directed": true },
    {
      "id": "belongsTo",
      "label": "隶属于",
      "domain": ["cls-character", "cls-group"],
      "range": ["cls-group"],
      "directed": true,
      "transitive": true
    },
    {
      "id": "controls",
      "label": "控制",
      "domain": ["cls-group"],
      "range": ["cls-place"],
      "directed": true
    },
    {
      "id": "violates",
      "label": "违反",
      "domain": ["cls-character"],
      "range": ["cls-rule"],
      "directed": true
    },
    {
      "id": "mentorOf",
      "label": "师父",
      "domain": ["cls-character"],
      "range": ["cls-character"],
      "directed": true,
      "inverseOf": "apprenticeOf"
    },
    {
      "id": "apprenticeOf",
      "label": "徒弟",
      "domain": ["cls-character"],
      "range": ["cls-character"],
      "directed": true,
      "inverseOf": "mentorOf"
    }
  ]
}
```

约束：

- **单继承**：`parentId` 只能一个；多继承在小说里只会制造歧义。
- 类规模上限：v1 ≤ 20 个类、≤ 20 个谓词；超了先拆 spec，不在文件里堆。
- `kind` 枚举：`character | group | place | rule | item | concept`，与节点 `NodeType` 对齐（事件不进图节点，单独存）。
- 规则 `kind` 仅五种：`range`（数值/长度范围）、`requires`（必填属性）、`requiresEdge`、`forbidsEdge`、`disjointWith`。不做自由表达式。
- `domain` / `range` 写 `"any"` 或类 id 数组；校验时按**子类闭包**匹配。

### 4.2 附加节点：`world/ontology/nodes.jsonl`

一行一个 JSON，append-only。仅用于**没有对应实体文件**的节点：

```json
{"id":"grp-qingyun","type":"group","name":"青云宗","aliases":["青云"],"summary":"北境第一剑宗","attrs":{"founded":"永昌元年"},"createdAt":"2026-10-27T10:00:00.000Z"}
{"id":"itm-broken-sword","type":"item","name":"断水","summary":"林岚的断剑","attrs":{},"createdAt":"2026-10-27T10:05:00.000Z"}
```

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 小写 kebab，前缀按类型：`grp-` / `itm-` / `cpt-` |
| `type` | `group \| item \| concept` | 允许的附加节点类型 |
| `name` | string | 显示名 |
| `aliases` | string[] | 检索用 |
| `summary` | string | 一句话 |
| `attrs` | Record<string, string> | 结构化属性（值只允许字符串，避免任意嵌套） |
| `createdAt` | ISO | 创建时间 |

约束：id 不得与既有实体 id 冲突；`type=place/character/rule` 的节点必须来自原文件，不允许在此文件里重复定义。

### 4.3 边：`world/ontology/edges.jsonl`

```json
{"id":"ed-7f3c91","from":"c1","predicate":"belongsTo","to":"grp-qingyun","sinceChapter":1,"source":{"kind":"author","ref":"手动整理"},"confidence":4,"createdAt":"2026-10-27T10:10:00.000Z"}
{"id":"ed-8a02de","from":"grp-qingyun","predicate":"controls","to":"l2","sinceChapter":3,"untilChapter":9,"source":{"kind":"chapter","ref":"ch-003"},"confidence":3,"createdAt":"2026-10-27T10:11:00.000Z"}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `ed-` + 6 位 hex |
| `from` / `to` | string | 节点 id（实体 id 或附加节点 id 或类 id） |
| `predicate` | string | 谓词注册表里的 id |
| `sinceChapter` | number? | 从第几章起为真 |
| `untilChapter` | number? | 到第几章为止（含） |
| `source` | `{kind:'chapter'\|'author'\|'agent', ref?:string}` | 边从哪来；`chapter` 的 `ref` 形如 `ch-012` 或 `evt-...` |
| `confidence` | 1–5? | 只对 `agent` 来源有意义；UI 低置信度加虚线 |
| `retracts` | string? | 被废止边 id（见 4.6）；带此字段的行不参与推导 |
| `createdAt` | ISO | 追加时间 |

约束：

- **append-only**：不改行；失效靠 `untilChapter`，撤销靠追加「废止边」的提案（写 `retracts: <edgeId>` 到新行，见 4.6）。
- 同一 `(from,predicate,to,sinceChapter)` 只能有一条；重复直接拒绝。
- 时间语义：`sinceChapter` / `untilChapter` 都为空 = 全书为真。

### 4.4 事件：`story/events.jsonl`

正史事件，append-only。一行一个：

```json
{"id":"evt-3f9a1c02d1","timeOrder":120,"inWorldTime":"永昌七年 三月初九","chapterRef":12,"type":"decision","title":"林岚拒绝接掌宗门","summary":"她在长老会上当众拒绝，并交回掌门令牌。","participants":["c1","c3"],"locationId":"l2","causes":["evt-91bb0a7c33"],"effects":[{"kind":"relation","from":"c1","predicate":"apprenticeOf","to":"c3"},{"kind":"mental","entityId":"c1","note":"从敬畏转为戒备"}],"rulesTouched":["r2"],"provenance":{"source":"sandbox","runId":"sbx-6c1e","adoptedAt":"2026-10-27T10:20:00.000Z"}}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | `evt-` + 10 位 hex |
| `timeOrder` | number | **书内时间序**，整数，作者/推演给定；排序唯一依据 |
| `inWorldTime` | string | 展示用「永昌七年 三月初九」 |
| `chapterRef` | number? | 已写进哪一章；为空 = 正史里已发生但尚未落笔 |
| `type` | enum | `decision \| encounter \| battle \| loss \| reveal \| travel \| ritual \| state_change` |
| `title` / `summary` | string | 标题与三句以内摘要 |
| `participants` | string[] | 角色 id |
| `locationId` | string? | 地点 id |
| `causes` | string[] | 前置事件 id（因果） |
| `effects` | Effect[] | 见下 |
| `rulesTouched` | string[] | 触碰的世界规则 id |
| `provenance` | `{source:'sandbox'\|'author'\|'agent', runId?:string, planId?:string, adoptedAt?:ISO}` | 来源 |

`Effect` 仅两种：

```ts
type Effect =
  | { kind: 'relation'; from: string; predicate: string; to: string }
  | { kind: 'mental'; entityId: string; note: string }
```

- `relation` 效果在采纳时**同时追加一条边**（同一事务），所以事件与边不会互相打架。
- `mental` 是**记录，不自动改角色状态**；状态变更仍走现有「状态提案」流程（S2 才把两者接起来）。UI 必须标注这一点，避免作者以为心理状态已经改了。
- 事件不可删。撤销 = 追加 `type:'state_change'` 的更正事件并在 `causes` 里引用被更正事件，或直接用检查点回退（项目既有能力）。

### 4.5 提案与决策日志：`.inkloom/ontology/log.jsonl`

不在 git（派生/过程数据）。append-only，当前状态靠折叠：

```json
{"id":"prp-1a2b3c","type":"propose","op":"add_edge","payload":{"from":"c1","predicate":"belongsTo","to":"grp-qingyun"},"evidence":{"kind":"chapter","chapterNo":7,"excerpt":"林岚稽首："弟子愿归青云门下。""},"rationale":"第 7 章拜入青云","source":{"runId":"ar_123"},"createdAt":"2026-10-27T10:30:00.000Z"}
{"id":"prp-1a2b3c","type":"approve","by":"author","createdAt":"2026-10-27T10:31:00.000Z"}
{"id":"prp-4d5e6f","type":"propose","op":"add_node","payload":{"id":"grp-qingyun","type":"group","name":"青云宗"},"evidence":{"kind":"manual"},"rationale":"整理势力","source":{"runId":null},"createdAt":"2026-10-27T10:32:00.000Z"}
{"id":"prp-4d5e6f","type":"reject","by":"author","reason":"名字不对，应叫青云剑宗","createdAt":"2026-10-27T10:33:00.000Z"}
```

`op` 仅三种：`add_edge`、`add_node`、`assign_class`（等价于追加一条 `instanceOf` 边）。修改类/谓词只允许作者在 UI 直接编辑 `classes.json` 并提交，不进提案（v1 收敛）。

约束：

- `evidence` 必填；`chapter` 的 `excerpt` ≤ 200 字。
- 每个 agent run 最多 20 条提案；超出的直接拒绝并回一句说明。
- 批准 = 追加 `approve` + 写 canon 文件 + `git commit`（一个提案一个 commit，消息 `ontology: <op> <id>`）。
- 驳回 = 追加 `reject`；agent 下轮通过 `read_book` 摘要里的「最近驳回」看到理由（见 8 末尾的注入说明）。

### 4.6 废止边

追加一条带 `retracts` 的边记录，`from`/`predicate`/`to` 填被废止边：

```json
{"id":"ed-9c11d0","from":"c1","predicate":"belongsTo","to":"grp-qingyun","retracts":"ed-7f3c91","source":{"kind":"author"},"createdAt":"2026-10-27T10:40:00.000Z"}
```

构建图时，被 `retracts` 指向的边标 `retracted`，默认不参与推导；UI 可切换显示。

## 5. 图引擎（`packages/core`，零 IO）

新增目录 `packages/core/src/ontology/`。全部纯函数，输入输出都是普通对象。

### 5.1 入口

```ts
export interface GraphSource {
  characters: Character[]
  relations: CharacterRelation[]
  locations: Location[]
  routes: Route[]
  rules: WorldRule[]
  threads: PlotThread[]
  arcs: StoryArc[]
  nodes: OntologyNode[]        // nodes.jsonl
  edges: GraphEdge[]           // edges.jsonl
  events: StoryEvent[]         // events.jsonl
  classesFile: ClassesFile
}

export function buildGraph(src: GraphSource): GraphSnapshot
export function validateGraph(snap: GraphSnapshot): GraphIssue[]
export function inferEdges(snap: GraphSnapshot): InferredEdge[]
export function explainFact(
  snap: GraphSnapshot,
  fact: { from: string; predicate: string; to: string },
): EvidenceChain[]
export function matchPattern(snap: GraphSnapshot, p: GraphPattern): GraphMatch[]
export function queryEvents(events: StoryEvent[], q: EventQuery): StoryEvent[]
```

`GraphSnapshot`：

```ts
type NodeType = 'character' | 'group' | 'place' | 'rule' | 'item' | 'concept' | 'class'

interface GraphNode {
  id: string
  type: NodeType
  name: string
  aliases?: string[]
  attrs: Record<string, string>
  /** 虚拟节点标记：来自原文件、不可在这里编辑 */
  virtual: boolean
  sourceFile?: string
}

interface GraphSnapshot {
  nodes: ReadonlyMap<string, GraphNode>
  edges: GraphEdgeView[]     // canon + 虚拟边；虚拟边没有 createdAt
  classOf: ReadonlyMap<string, string[]>   // 节点 → 类闭包（含 instanceOf 推导）
  subclasses: ReadonlyMap<string, string[]>
  classes: ClassDef[]        // 类定义（GET /classes 直接用）
  predicates: PredicateDef[]
  issues: GraphIssue[]
  builtFrom: { files: string[]; mtimeMax: number }
}

/** 虚拟边来自实体投影，没有作者写入时间 */
type GraphEdgeView = Omit<GraphEdge, 'createdAt'> & {
  createdAt?: string
  virtual: boolean
  undirected?: boolean     // 双向路线：匹配忽略方向
  retracted?: boolean      // 被别的边 retracts 指向，不参与推导
  tombstone?: boolean      // 废止记录行本身（带 retracts）：只用于吊销
  sourceFile?: string
}

interface GraphMatch {
  from: string
  predicate: string
  to: string
  inferred: boolean
  evidence: EvidenceChain
}

interface InferredEdge {
  from: string
  predicate: string
  to: string
  evidence: EvidenceChain
}
```

### 5.2 虚拟节点与虚拟边（D2）

| 源 | 变成 |
|---|---|
| `characters/index.json` | 节点 `type=character`，属性取 name/personality/motivation 等 |
| `world/locations.json` | 节点 `type=place` |
| `world/rules.json` | 节点 `type=rule`（`priority=hard` 的规则在图上描边加粗） |
| `story/threads.json` | 节点 `type=concept`，`attrs.kind=thread` |
| `story/arcs.json` | 节点 `type=concept`，`attrs.kind=arc` |
| `characters/relations.json` | **虚拟边** `rel:<kind>`（kind = master/kin/…），带 since/until，**只读** |
| `world/routes.json` | **虚拟边** `route`，双向按 `bidirectional` |

虚拟边不可被提案或编辑；UI 上颜色略浅，点开提示「去关系网络/地图修改」。

### 5.3 推导规则（只有三条）

1. **子类闭包**：`instanceOf` + `parentId` 链，用于类匹配与 domain/range 校验。
2. **闭包推导**：谓词标 `transitive:true` 的边做传递闭包，深度上限 4，每个结果带路径。
3. **逆关系**：谓词标 `inverseOf` 时生成反向边，带原边 id。

不做：属性继承默认值的自动写回（继承只用于校验与匹配）、否定推理、基数推导。

### 5.4 解释

```ts
type Evidence =
  | { kind: 'direct'; edgeId: string }
  | { kind: 'inverse'; edgeId: string; predicate: string }
  | { kind: 'transitive'; edgeIds: string[] }
  | { kind: 'subclass'; classIds: string[] }

interface EvidenceChain {
  fact: { from: string; predicate: string; to: string }
  steps: Evidence[]
  text: string   // 人话，如「青云宗 →隶属→ 北境联盟 →控制→ 寒山关」
}
```

UI 与 Agent 工具都直接展示 `text`，同时保留 `steps` 供点开逐条核对。

### 5.5 模式匹配

```ts
interface GraphPattern {
  from?: { id?: string; type?: NodeType; class?: string; name?: string }
  to?: { id?: string; type?: NodeType; class?: string; name?: string }
  predicate?: string
  maxDepth?: 1 | 2 | 3 | 4      // 默认 1，>1 时允许推理边
  includeInferred?: boolean       // 默认 true
  limit?: number                  // 默认 20，上限 50
}
```

匹配顺序：显式边优先，推导边其次；同分按节点度数降序。每条命中带 `evidence`。

### 5.6 事件查询

```ts
interface EventQuery {
  chapterFrom?: number
  chapterTo?: number
  timeFrom?: number
  timeTo?: number
  participants?: string[]
  types?: StoryEvent['type'][]
  limit?: number   // 默认 20，上限 50
}
```

排序：`timeOrder` 升序，同序按 `id`。返回事件时附带 `causes` 里被引用的标题（一次 join，不递归）。

## 6. 校验

`validateGraph` 输出：

```ts
interface GraphIssue {
  severity: 'error' | 'warning'
  code: 'DUP_NODE' | 'DUP_EDGE' | 'EDGE_ENDPOINT_MISSING' | 'EDGE_BAD_PREDICATE'
      | 'EDGE_DOMAIN_RANGE' | 'CLASS_CYCLE' | 'CLASS_PARENT_MISSING'
      | 'EVENT_CAUSE_MISSING' | 'EVENT_PARTICIPANT_MISSING' | 'EVENT_LOCATION_MISSING'
      | 'PROPOSAL_EVIDENCE_MISSING' | 'PROPOSAL_CAP_EXCEEDED'
  subject: string
  message: string
  evidence?: string
}
```

行为：

- `error` 阻断提案落盘；`warning` 只显示（如悬空边、未分类节点过多）。
- 悬空边不自动删；图谱页给「待修复」筛选。
- 坏 JSON / 坏行：跳过该行，记 `warning`，不中断构建（沿用 reindex 的容错策略）。
- 类环、父类缺失：`error`，图仍可渲染（该分支标红）。

## 7. API

全部挂在 `/api/ontology`，沿用现有 Hono 路由与错误类型。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/graph?class=&q=&includeInferred=1&limit=` | 返回 `{ nodes, edges, issues, builtAt }`；默认最多 400 节点 |
| GET | `/nodes/:id` | 节点详情 + 关联边 + 证据 + 影响它的提案 |
| GET | `/search?q=` | 名称/别名检索，返回 ≤ 20 |
| GET | `/classes` | 类与谓词注册表 + 每类实例数 |
| GET | `/events?chapterFrom=&chapterTo=&participant=&type=&limit=` | 正史事件 |
| GET | `/proposals?status=pending\|all` | 折叠后的提案列表 |
| POST | `/proposals/:id/approve` | 落盘 + commit；失败回滚不动 canon |
| POST | `/proposals/:id/reject` | 记录理由 |
| POST | `/reload` | 清缓存并重建（测试与调试用，仅本机） |

缓存：按（书根 + 各文件 mtime 最大值）缓存 `GraphSnapshot`；任一文件变化自动失效。切书时清空（与 `closeContext` 一起）。

## 8. Agent 工具

新增三个，原 `read_book` / `read_element` 保留。

### 8.1 `query_graph`

```ts
{
  from?: { name?: string; id?: string; type?: NodeType; class?: string }
  to?: { name?: string; id?: string; type?: NodeType; class?: string }
  predicate?: string
  maxDepth?: 1 | 2 | 3 | 4
  includeInferred?: boolean
}
```

返回：命中的路径（≤20）+ 每条 `evidence.text` + 未解析的提醒。名称解析失败时返回候选（≤5），不猜。

### 8.2 `query_events`

```ts
{ chapterFrom?, chapterTo?, timeFrom?, timeTo?, participants?, types?, limit? }
```

返回事件摘要 + 前因标题 + 涉及规则；`chapterRef` 为空的事件标「尚未落笔」。

### 8.3 `propose_graph_edit`

```ts
{
  op: 'add_edge' | 'add_node' | 'assign_class'
  payload: AddEdgePayload | AddNodePayload | AssignClassPayload
  evidence: { kind: 'chapter'; chapterNo: number; excerpt: string } | { kind: 'existing'; ref: string }
  rationale: string
}
```

- 只写日志，不直接改 canon；返回 `proposalId` 与「等作者批准」。
- 每人每个 run 20 条上限。
- 提示词纪律：涉及设定/关系写作前，先用 `query_graph`；提出边必须带章节证据；不要编 id。

**注入**：`read_book` 末尾追加一段「图谱摘要」：节点数/边数/未分类节点数/未解决 issue 数/最近 5 条事件标题/最近 3 条被驳回提案及理由。控制在 300 字内，不改变原有上下文预算。

## 9. UI

新模块 `ontology`，标签「图谱」，加在「故事」之后。三栏，沿用现有布局规范：

- **左（240）**：类树 + 筛选（只看正史 / 含推导 / 只看未解决 issue）+ 搜索框
- **中**：画布（复用 React Flow）。节点按类着色，边标注谓词；虚拟边浅色；低置信度虚线；推导边点状。默认布局按类分簇（简单分层），节点 > 200 时默认只显示被引用最多的 120 个并提示。
- **右（320）**：选中节点详情（属性、类闭包、关联边、证据链、涉及提案）；底部「待批变更」抽屉，显示计数与最新一条。

事件视图：模块内切页签「事件」，时间轴（按 `timeOrder`）+ 表格；未落笔事件（`chapterRef` 为空）加标记。

可操作：

- 作者可直接拉边（从节点拖到节点 → 选谓词 → 填证据）→ 立即写 canon + commit（作者操作不走提案）。
- 作者可改类归属（右键节点 → 分配类）→ 写 `instanceOf` 边。
- 提案：批准 / 驳回（带理由）。

空态：没有任何类文件时，展示「图谱由现有实体自动生成」+ 三个可点的问题示例（谁控制某地、某规则被谁违反、某人的心理由哪些事件造成）。

## 10. 与 S2 / S3 的接口（只定边界）

### S2 沙盘

- 沙盒事件使用同一 `StoryEvent` schema，写 `.inkloom/sandbox/<runId>.jsonl`（不进 git），带 `branchId`。
- 「采纳」调用 S1 的 `adoptEvents(ids)`：同一事务内追加 canon 事件 + `relation` 效果边 + commit。
- S2 新增页面「沙盘」；S1 不实现推演逻辑。

### S3 技能包

- 技能包的 `deterministic` 检查可以调用 `query_graph` / `query_events` 与 `validateGraph`；S1 只保证这些函数是纯函数、可被外部调用。
- S3 新增 `skills/` 目录与门禁；S1 不实现。

## 11. 验收

### 11.1 功能验收（七霞书上跑）

1. **谁控制某地（含间接）**：`query_graph({from:{class:'cls-group'}, predicate:'controls', to:{name:'寒山关'}})` → 结果带传递路径证据。
2. **某条硬规则被谁违反过**：`query_graph({predicate:'violates', to:{id:'r2'}})` + `query_events({types:['state_change']})` → 列出角色与章节。
3. **某人第 12 章的心理与动机从哪些事件来**：`query_events({participants:['c1'], chapterTo:12})` → 事件链 + `mental` 效果，明确标「记录，不自动改状态」。
4. **提案门禁**：Agent 提议一条边 → 图谱页出现待批 → 批准后文件追加且产生 commit → 驳回后留下理由且 canon 不变。
5. **回退**：用检查点回退到批准前，图恢复且不报错（文件是真相）。
6. **跨书隔离**：切书后 `GET /graph` 不返回上一本的任何节点；提案队列同样隔离。
7. **坏文件容错**：手工把 `edges.jsonl` 某行截断 → 图仍能打开，issue 列表报该行。

### 11.2 测试

| 层 | 内容 |
|---|---|
| `core` 单测 | `buildGraph`（虚拟节点/边、类闭包）、`inferEdges`（传递/逆关系/深度上限）、`explainFact`、`matchPattern`、`queryEvents`、全部校验码 |
| 存储集成 | JSONL 追加、原子写、坏行跳过、日志折叠（propose/approve/reject） |
| API 集成 | 图查询、节点详情、提案批准/驳回、事件过滤、缓存失效、跨书隔离 |
| 脚本 | 新增 `pnpm verify:ontology`：8 条（建类→建节点→建边→推导→解释→提案→批准→回退） |
| 手工 | 第 11.1 的 7 条 + 截图存档 `docs/screenshots/` |

覆盖率：`core/src/ontology/**` 分支覆盖 100%（纯函数，成本低）。

## 12. 实施切片

每片独立可验收，不合并成一次大改。

**切片 1：只读图谱（无提案、无事件）**

- `shared/ontology.ts`：Zod schema（类、节点、边、事件、提案）
- `storage/ontology.ts`：读文件 + 追加 + 容错
- `core/ontology`：`buildGraph` + 虚拟节点/边 + `validateGraph`（前 5 个 issue 码）
- `GET /graph`、`GET /nodes/:id`、`GET /classes`
- 图谱页（只读画布 + 类树 + 详情）
- 测试：core 单测 + API 集成 + 七霞真实书手工

**切片 2：事件与提案**

- `story/events.jsonl` 读写 + `queryEvents` + `inferEdges` + `explainFact` + `matchPattern`
- 提案日志 + 批准/驳回 + commit + 20 条上限
- Agent 三个工具 + `read_book` 图谱摘要 + 提示词纪律
- 图谱页：待批抽屉、事件页签
- 测试：提案门禁、事件查询、跨书隔离、`verify:ontology` 前 6 条

**切片 3：推导与解释收口**

- 子类匹配、domain/range、类环、悬空边的完整校验
- 解释链 UI（点推导边看路径）
- 性能基准（500 节点 / 2000 边 < 100ms）
- 三个验收问题跑通 + 截图 + README 增「图谱」一节
- `pnpm verify` 接入 `verify:ontology`

## 13. 风险与取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| 图建了没人填 | 变成空壳 | 虚拟节点/边先给即视价值；提案由 Agent 在日常写作中自然产生；空态给三个可点问题 |
| 类层级过度设计 | 作者看不懂、Agent 不会用 | v1 上限 20 类 / 20 谓词 / 单继承；规则只五种 |
| 提案噪音 | 批准疲劳 | 每 run ≤ 20 条；必须带章节证据；低置信度不进队列（<3 直接拒） |
| 推导不可信 | 作者不敢用 | 每条推导带证据链；可一键关闭推导只看显式边 |
| 图文件膨胀 | 加载慢 | append-only + mtime 缓存；> 5000 边改索引（D1 触发条件） |
| 与既有三张图重复 | 两套真相 | 关系网络/线索轨迹/地图改造成「图谱预设视图」放到 S1.1；S1 先并存，不改旧页面 |
| 事件与角色状态脱节 | 作者以为状态已改 | `mental` 效果显式标「记录，不自动改状态」；S2 再接状态应用 |

## 14. 兼容与迁移

- 老书没有 `world/ontology/`：图为空但可用（虚拟节点/边照常生成），issue 为 0。
- 首次批准提案时创建目录与文件；不做批量迁移。
- 既有 `relations.json` / `routes.json` 继续是各自模块的真相；图谱只读投影。
- 切书：`closeContext` 时清图缓存；后续请求按新书根重建。
- 版本：`classes.json` 带 `version:1`；未来不兼容变更时升级版本号并提供只读兼容。

## 15. 自审记录

- 占位符：无 TBD/TODO；未决项均给出默认值（D1 的索引触发条件、类上限、20 条提案上限、推导深度 4）。
- 一致性：事件 `relation` 效果与边同事务写入，其他效果不写状态；推导不落盘；提案只写日志。
- 范围：S1 不包含沙盘、技能包、自动抽取、索引表；三者都有明确接口。
- 歧义：`timeOrder` 明确为唯一排序键（`inWorldTime` 仅展示）；`instanceOf` 是普通边，类归属不需要改实体 schema。
