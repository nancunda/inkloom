# inkloom · 系统设计

> 版本：v0.1（2026-10-25）
> 状态：待 review
> 需求依据：[`REQUIREMENTS.md`](../../../REQUIREMENTS.md)
> 证据来源：Pagekin / Biz Novel Studio / OpenFic / Denova 四项目源码实测（详见附录 A）

---

## 1. 设计原则

### 1.1 四条硬原则

| 原则 | 含义 | 强制手段 |
|---|---|---|
| **core 零 IO** | 领域逻辑不依赖 DB、网络、文件，全是纯函数 | ESLint `no-restricted-imports` 禁用 `fs`/`fetch`/`prisma` |
| **append-only** | 一切可变对象永不 UPDATE，只新增 revision | 仓储层不暴露 update 正文的方法 |
| **降级必须留痕** | 任何上下文裁剪、模型降级、截断都写入 run 记录 | `generation_run.degradedReason` 非空校验 |
| **能力层稳定、编排层可换** | `capabilities` 签名统一，可被任意框架消费 | 每个 capability 必有单测 + 固定 Zod schema |

### 1.2 刻意不做的事（YAGNI）

- 不做 Agent 循环（MVP 是 1–3 次确定性 LLM 调用）
- 不做 RAG（`deepseek-flash` 有 1M 窗口）
- 不引入 DeepSeek Harness（`dsh-tools@0.0.1-rc.1`，且不提供领域价值）
- 不做多用户 / 鉴权 / 在线发布

---

## 2. 系统架构

### 2.1 分层与依赖方向

```
┌──────────────────────────────────────────────────────────────┐
│  apps/web        React 19 + Vite + TS                        │
│                  职责：UI、编辑器、diff 展示、确认交互          │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP (SSE 流式)
┌───────────────────────────▼──────────────────────────────────┐
│  apps/api        Hono + Prisma                               │
│                  职责：唯一有副作用的地方（DB / LLM / 文件）     │
│                  组成：路由 / 仓储 / 生成服务 / 事务            │
└──────┬────────────────────┬──────────────────────────────────┘
       │                    │
┌──────▼──────────┐  ┌──────▼──────────────────────────────────┐
│ packages/prompt │  │ packages/core                          │
│ 装配 messages    │  │ 领域模型 + 纯函数 + capabilities        │
│ 预算裁剪         │  │ 零 IO，覆盖率 >80%                      │
└──────┬──────────┘  └──────▲──────────────────────────────────┘
       │                    │
       └────────────────────┘
              │
┌─────────────▼──────────────┐
│ packages/shared            │
│ Zod schema（前后端单一来源）│
└────────────────────────────┘
```

**依赖铁律（ESLint 强制，违反 CI 失败）：**

| 包 | 允许依赖 | 禁止依赖 |
|---|---|---|
| `core` | 仅 `shared` | `prompt`、`api`、`web`、`prisma`、`fs`、`fetch` |
| `prompt` | `core`、`shared` | `api`、`web` |
| `shared` | 无（仅第三方 zod） | 任何内部包 |
| `api` | `core`、`prompt`、`shared` | `web` |
| `web` | `shared` | `core` 内部路径、`prompt`、`api` 内部路径 |

> `web` 不直接依赖 `core`：前端需要的纯逻辑（如字数统计、diff）通过 `shared` 暴露，避免前端打进整个领域层。

### 2.2 目录结构

```
inkloom/
├── apps/
│   ├── api/                      后端
│   │   ├── src/
│   │   │   ├── routes/           HTTP 路由（薄）
│   │   │   ├── services/         生成、装配调度、事务
│   │   │   ├── repositories/     数据访问（唯一的 prisma 使用者）
│   │   │   ├── llm/              DeepSeek / SiliconFlow 适配
│   │   │   └── jobs/             长任务（生成、切分）
│   │   └── prisma/schema.prisma
│   └── web/                      前端
│       ├── src/
│       │   ├── routes/           页面路由
│       │   ├── features/         按功能域组织
│       │   │   ├── project/      书籍与锚点
│       │   │   ├── characters/   角色卡
│       │   │   ├── world/        力量体系与世界规则
│       │   │   ├── blueprint/    章节蓝图与张力曲线
│       │   │   ├── writing/      正文、diff、确认
│       │   │   └── history/      版本与回退
│       │   ├── components/       跨域组件
│       │   ├── stores/           Zustand（按域拆分）
│       │   └── lib/              API client、工具
│       └── e2e/                  Playwright
├── packages/
│   ├── shared/                   Zod schema + 共享类型
│   ├── core/                     领域模型 + 纯函数 + capabilities
│   │   └── src/
│   │       ├── entities/         实体类型与不变量
│   │       ├── context/          上下文推导（状态/线索/规则）
│   │       ├── quality/          张力曲线、一致性校验、反AI检测
│   │       ├── text/             分段、diff、字数、token 估算
│   │       ├── capabilities/     ★ 对外能力（可被任意编排器消费）
│   │       └── index.ts          唯一公开出口
│   └── prompt/                   Prompt 装配器
│       └── src/
│           ├── blocks/           各上下文块的渲染函数
│           ├── assemble.ts       主装配流程
│           ├── budget.ts         预算分配与裁剪
│           └── templates/        prompt 模板（含快照基线）
├── fixtures/qixia/               玄幻示例项目（一物三用）
├── docs/
│   ├── REQUIREMENTS.md
│   └── superpowers/specs/
└── package.json                  pnpm workspace
```

### 2.3 模块职责（高内聚）

| 模块 | 只做一件事 | 明确不做 |
|---|---|---|
| `core/entities` | 定义实体形状与不变量（如 tensionLevel ∈ 1..5） | 不查库、不调 AI |
| `core/context` | 给定 `chapterNo`，推导"该章需要哪些要素" | 不渲染成文本 |
| `core/quality` | 张力曲线校验、一致性检查、反 AI 规则检测 | 不修改数据 |
| `core/text` | 分段、diff、字数、token 估算 | 不决定用什么模型 |
| `core/capabilities` | 把上述能力包装成统一签名的可调用单元 | 不含业务编排 |
| `prompt/blocks` | 把单个实体渲染成一个文本块 | 不决定顺序 |
| `prompt/assemble` | 决定顺序与结构，产出 messages | 不调用 LLM |
| `prompt/budget` | 按优先级裁剪，返回裁剪日志 | 不抛异常中断流程 |
| `api/services` | 编排：装载 → 装配 → 调用 → 切分 → 落库 | 不实现领域算法 |
| `api/repositories` | 数据存取与事务 | 不含业务规则 |

---

## 3. 数据模型

### 3.1 版本机制（append-only 的地基）

```prisma
/// 一切可变对象的版本快照。永不 UPDATE，永不 DELETE。
model EntityRevision {
  id               String   @id @default(cuid())
  entityType       String   // project | character | world_rule | power_tier
                            // | blueprint | draft_segment | plot_thread
                            // | style_asset | story_arc
  entityId         String
  version          Int
  parentRevisionId String?  // 形成链，可追溯"从哪一版改来"
  payload          String   // 完整 JSON 快照（不做 diff，自解释）
  changeSource     String   // human | ai | import | rollback
  changeReason     String?
  generationRunId  String?  // 若由 AI 改，可追溯到哪次生成
  createdAt        DateTime @default(now())

  @@unique([entityType, entityId, version])
  @@index([entityType, entityId, createdAt])
  @@index([generationRunId])
}
```

**为什么存完整快照而非 diff**：diff 需重放才能还原，中间一条损坏则后续全废；快照任一版本可独立还原。成本可控——角色卡 JSON ≈ 2KB，改 100 次 = 200KB。

### 3.2 书籍与创意锚点

```prisma
model Project {
  id              String   @id @default(cuid())
  name            String
  genre           String   // 玄幻
  subGenre        String?
  targetAudience  String?
  totalChapters   Int?
  wordsPerChapter Int?
  narrativePov    String?

  // ===== 锚点层：锁定后 AI 无权修改 =====
  coreIdea        String?  // 最初那个点，一句话
  premise         String?  // 故事前提
  theme           String?  // 主题/母题
  toneContract    String?  // 语调契约：冷峻 / 诙谐 / 悲怆
  anchorLocked    Boolean  @default(false)

  createdAt       DateTime @default(now())
  archivedAt      DateTime?

  characters      Character[]
  worldRules      WorldRule[]
  powerSystems    PowerSystem[]
  blueprints      Blueprint[]
  plotThreads     PlotThread[]
  styleAssets     StyleAsset[]
  storyArcs       StoryArc[]
  assets          Asset[]
  runs            GenerationRun[]
}
```

**锚点的不变量**（在 `core/entities` 断言）：`anchorLocked = true` 时，任何 `changeSource = 'ai'` 的 revision 不得写入锚点四字段。

### 3.3 角色：静态设定 + 动态状态 + 字段级溯源

```prisma
model Character {
  id            String   @id @default(cuid())
  projectId     String
  name          String
  role          String   // protagonist | antagonist | supporting | minor

  // ===== 静态设定（跨章不变）=====
  gender        String?
  age           String?
  appearance    String?
  personality   String?
  background    String?
  abilities     String?
  motivation    String?
  relationships String?  // 文本描述（关系图谱见 3.4）
  arc           String?  // 人物弧光
  notes         String?

  // ===== 动态状态（按章演进）=====
  curLocation   String?
  curTierId     String?  // 关联 PowerTier，level 可比
  curPhysical   String?  // 断臂 / 中毒
  curMental     String?
  curItems      String?  // JSON: 关键道具
  curEvents     String?  // 最近事件
  stateChapter  Int?     // 状态更新于第几章

  /// 字段级溯源：{ "curTierId": { "chapter": 12, "runId": "run_x" }, ... }
  stateProvenance String?

  /// 人工改正文后标脏，提示用户确认，不自动同步
  stateStale      Boolean @default(false)
  stateStaleSince Int?

  deletedAt        DateTime?
  currentRevisionId String?
}
```

### 3.4 角色关系（结构化图谱）

> 回应未决问题 Q2：**需要独立表**。玄幻的"师徒/血亲/宿敌"直接决定行为逻辑，纯文本无法校验。

```prisma
model CharacterRelation {
  id            String @id @default(cuid())
  projectId     String
  fromId        String
  toId          String
  kind          String // master | disciple | kin | ally | enemy | rival | lover
  strength      Int    @default(3) // 1-5，影响行为优先级
  sinceChapter  Int?
  untilChapter  Int?   // 关系在第几章结束（如师父身死）
  note          String?
}
```

### 3.5 力量体系与世界规则

```prisma
model PowerSystem {
  id        String @id @default(cuid())
  projectId String
  name      String  // 九转玄功
  tiers     PowerTier[]
}

model PowerTier {
  id           String  @id @default(cuid())
  systemId     String
  name         String  // 练气 / 筑基 / 金丹
  level        Int     // ★ 整数可比，硬校验的基础
  description  String?
  breakthrough String? // 突破条件
  @@unique([systemId, level])
}

model WorldRule {
  id        String   @id @default(cuid())
  projectId String
  category  String   // power | faction | geography | item | taboo
  name      String
  content   String
  priority  String   // hard（违背即 OOC）| soft（建议）
  deletedAt DateTime?
}
```

### 3.6 结构层：卷 / 章节蓝图 / 张力

```prisma
model StoryArc {
  id            String @id @default(cuid())
  projectId     String
  name          String  // 第一卷 · 入道
  startChapter  Int
  endChapter    Int
  purpose       String? // 本卷戏剧功能
  turningPoint  Int?    // 卷末大转折章号
  order         Int
}

model Blueprint {
  id           String @id @default(cuid())
  projectId    String
  chapterNo    Int
  title        String?
  goal         String   // 主角本章目标
  conflict     String   // 冲突
  turn         String?  // 转折
  hook         String   // 章末钩子
  castIds      String   // JSON: 出场角色 id
  beatType     String   // setup|rising|climax|twist|falling|resolution
  tensionLevel Int      // ★ 1-5，节奏曲线的数据基础
  userGuidance String?
  status       String   @default("planned") // planned | drafting | finalized
  @@unique([projectId, chapterNo])
}
```

**张力曲线校验**（`core/quality`，纯函数）：
- 连续 ≥5 章 `tensionLevel` 相同 → `flat_run` 告警
- 高潮章（`beatType='climax'`）`tensionLevel` < 4 → `weak_climax` 告警
- 相邻两章张力跳变 > 3 → 提示确认是否为有意反转

### 3.7 剧情线索与未兑现清单

```prisma
model PlotThread {
  id               String  @id @default(cuid())
  projectId        String
  kind             String  // setup | payoff | foreshadow | callback | running_gag
  title            String
  description      String?
  plantedChapter   Int?    // 埋设章
  advancedChapters String? // JSON: [5, 9, 14]
  resolvedChapter  Int?    // 回收章
  status           String  // planned | active | resolved | abandoned
  payoffHint       String? // 期望如何回收
  /// ★ 期望回收章号。用于区分「长线伏笔」与「忘了收」：
  ///   currentChapter >= payoffWindow 则升级为 overdue
  payoffWindow     Int?
  deletedAt        DateTime?
}
```

**未兑现清单生成算法**（`core/context/getUnresolvedSetups`，纯函数）：

```
输入：plotThreads[], currentChapter, threshold
输出：UnresolvedItem[]（按紧迫度排序）

规则：
1. status = 'active' 且 resolvedChapter 为空
2. 距最近一次提及（advancedChapters 末项 或 plantedChapter）超过 threshold 章
3. 紧迫度 = 未提及章数 / threshold
4. running_gag 与 foreshadow 单独分组展示
```

默认 `threshold = 5`，可在项目设置调整。

### 3.8 文风资产

```prisma
model StyleAsset {
  id             String @id @default(cuid())
  projectId      String
  name           String
  description    String  // 文风描述
  samples        String? // JSON: 示例文本片段
  bannedWords    String? // JSON: 禁用词表
  bannedPatterns String? // JSON: 禁用句式正则
  quantLimits    String? // JSON: {"仿佛": 3, "犹如": 3} 全章上限
  isDefault      Boolean @default(false)
  deletedAt      DateTime?
}
```

### 3.9 正文：场景 / 段落

```prisma
model DraftSegment {
  id          String @id @default(cuid())
  projectId   String
  chapterNo   Int
  sceneNo     Int     // 场景号 = 确认单位
  seq         Int     // 场景内段序
  content     String
  wordCount   Int?
  status      String  // candidate | accepted | rejected | superseded
  sourceRunId String?
  acceptedAt  DateTime?
  deletedAt   DateTime?
  currentRevisionId String?
  @@index([projectId, chapterNo, sceneNo, seq])
  @@index([projectId, chapterNo, status])
}
```

**不变量**：`status='accepted'` 的段落集合构成该章的"当前正文"。定稿 = 该章无 `candidate` 段落。

### 3.10 生成记录（可复现的唯一凭据）

```prisma
model GenerationRun {
  id              String   @id @default(cuid())
  projectId       String
  chapterNo       Int?
  purpose         String   // draft | blueprint | review | repair | segment_split | vision

  provider        String   // deepseek | siliconflow
  model           String   // deepseek-flash | deepseek-v4-pro | ...
  params          String?  // JSON: temperature / max_tokens / effort / seed
  /// ★ 使用的 PromptTemplate（可追溯到具体版本）
  promptTemplateId String?

  /// ★ 装配后的完整 messages，原样存档。可复现 + 可做对照组
  assembledPrompt String
  tokenEstimate   Int?

  output          String?
  usageInput      Int?
  usageOutput     Int?
  cacheHitTokens  Int?
  costCents       Int?

  status          String   // running | success | failed | aborted | partial
  errorMessage    String?
  /// ★ 降级留痕：{"kind":"trim","dropped":["history_raw"],"reason":"budget"}
  degradedReason  String?
  warnings        String?  // JSON: 场景切分降级等

  startedAt       DateTime @default(now())
  finishedAt      DateTime?
  @@index([projectId, chapterNo])
}

model QualityReview {
  id           String  @id @default(cuid())
  runId        String
  chapterNo    Int
  score        Int     // 1-5
  issues       String? // JSON: ["personality","rhythm"]
  note         String?
  promptVersion String?
  createdAt    DateTime @default(now())
}
```

### 3.11 视觉资产

```prisma
model Asset {
  id           String @id @default(cuid())
  projectId    String
  ownerType    String // character | world_rule | blueprint | project
  ownerId      String
  assetType    String // portrait | scene | map | cover | reference

  prompt       String?
  provider     String? // siliconflow
  model        String? // Tongyi-MAI/Z-Image-Turbo | Kwai-Kolors/Kolors | Qwen/Qwen-Image-Edit
  params       String? // JSON: seed / image_size / steps

  filePath     String
  width        Int?
  height       Int?
  mimeType     String?

  /// ★ 从图提取的视觉锚点，参与文本生成（不是装饰）
  visualAnchor String?
  anchorSource String? // ai_vision | human

  createdAt    DateTime @default(now())
  deletedAt    DateTime?
}
```

### 3.12 章节聚合根与摘要

> ⚠️ 自检补漏：原设计只有 `Blueprint`（计划）和 `DraftSegment`（正文），缺一个「章节」聚合根，
> 导致章节状态、字数统计、L3 摘要无处存放。

```prisma
model Chapter {
  id           String   @id @default(cuid())
  projectId    String
  chapterNo    Int
  title        String?
  /// planned(仅规划) | drafting(在写) | review(待确认) | finalized(已定稿)
  status       String   @default("planned")
  wordCount    Int      @default(0)   // accepted 段落字数缓存

  /// L3 压缩层的章节摘要（约 200 字），由 LLM 生成
  summary      String?
  /// 生成摘要时的正文指纹；正文变化则标脏重算
  summaryHash  String?
  summaryStale Boolean  @default(true)

  finalizedAt  DateTime?
  @@unique([projectId, chapterNo])
  @@index([projectId, status])
}
```

**章节状态机（唯一合法转换）：**

```
planned ──(生成或手写首个场景)──> drafting
   ↑                                  │
   │                                  │(全部场景确认完毕)
   └────(撤销定稿)──── review <───────┘
                         │
                         └──(用户点定稿)──> finalized
```

**不变量**：
- 只有 `finalized` 章节才计入「已有正文」；`drafting` 章节可被任意重写
- `summaryStale=true` 时不得用于装配（L3 层跳过并降级）

### 3.13 项目配置

> ⚠️ 自检补漏：阈值、模型默认值、预算上限此前散落在正文里，没有落点。

```prisma
model ProjectSetting {
  projectId            String  @id

  // 未兑现清单阈值
  unresolvedThreshold  Int     @default(5)   // 超过 N 章未提及即告警
  unresolvedMaxItems   Int     @default(10)
  runningGagThreshold  Int     @default(8)   // running_gag 复用提醒阈值

  // 预算分档
  budgetWarnRatio      Float   @default(0.70)
  budgetPromptRatio    Float   @default(0.85)
  budgetForceRatio     Float   @default(0.95)

  // 模型默认
  defaultTextModel     String  @default("deepseek-flash")
  defaultImageModel    String  @default("Tongyi-MAI/Z-Image-Turbo")

  // 成本上限（分）；null = 不限
  dailyCostLimitCents  Int?
  runCostLimitCents    Int?
}
```

### 3.14 Prompt 模板版本

> ⚠️ 自检补漏：`QualityReview.promptVersion` 引用了版本号，但没有版本表；快照测试也需要它。

```prisma
model PromptTemplate {
  id          String   @id @default(cuid())
  key         String   // draft_chapter | gen_blueprint | gen_arc | summarize_chapter | check_consistency
  version     Int
  content     String   // 完整模板文本
  /// 模板内容的 sha256，用于快照比对与变更追踪
  contentHash String
  isActive    Boolean  @default(false)
  note        String?  // 本版本改了什么、为什么改
  createdAt   DateTime @default(now())
  @@unique([key, version])
}
```

**约束**：同一个 `key` 同时只能有一条 `isActive=true`。`GenerationRun` 需记录使用的 `promptTemplateId`。

### 3.15 地理与距离（可计算的事实）

> 设计依据：用户提出“从 A 地到 B 地间隔多久”。**这类问题不能让 AI 估，必须由系统算。**

```prisma
model Location {
  id          String   @id @default(cuid())
  projectId   String
  name        String
  type        String   // city | mountain | sect | secret_realm | ruin | plain
  region      String?  // 所属区域
  description String?
  x           Float?   // 地图坐标（可选，用于世界地图视图）
  y           Float?
  deletedAt   DateTime?
}

model Route {
  id            String  @id @default(cuid())
  projectId     String
  fromId        String
  toId          String
  mode          String  // walk | ride | fly | teleport | boat | caravan
  /// ★ 标准行进天数，可确定计算。AI 不得自行更改
  days          Int
  condition     String? // “需过魔渊关，冬季封闭三个月”
  bidirectional Boolean @default(true)
  @@unique([fromId, toId, mode])
}
```

**注入形式**（Prompt Assembler 的 L1 强约束块）：

```
【地理硬约束 · 不可违背】
- 当前位置：青云宗
- 本章目标：抵达魔渊
- 系统计算：步行需 7 天（Route#12）
- ★ 本章时间跨度不得少于 7 天；若需更短，必须写明借助传送/飞行等手段
```

**“可计算事实”清单（全部不能让 AI 编）：**

| 事实 | 数据来源 | 注入时机 |
|---|---|---|
| 两地距离/耗时 | `Route.days` | 场景含地点转换时 |
| 角色当前年龄 | 出生年 + 章节时间轴 | 每章 |
| 闭关/炼药耗时 | 对应设定表 duration | 涉及该类行为时 |
| 战力强弱 | `PowerTier.level` | 涉及对抗时 |
| 势力强弱 | Faction.powerLevel | 涉及势力交锋时 |
| 资源余额 | 物品表 + 消耗规则 | 涉及获取/消耗时 |

### 3.16 角色签名（出场诗 / 口头禅 / 标志动作）

> 设计依据：用户提出“出场/退场时吟诗、做诗，加深印象”。这是仙侠/玄幻的核心手法，原设计完全缺失。

```prisma
model CharacterSignature {
  id          String   @id @default(cuid())
  characterId String
  kind        String
  /// entrance_verse  出场诗号（“十步杀一人，千里不留行”）
  /// exit_verse      退场诗
  /// catchphrase     口头禅
  /// verbal_tick     语言习惯（只回一个字 / 每句带“某”字）
  /// signature_action 标志动作（抚剑 / 转佛珠）
  /// motif            意象道具（白衣 / 酒葫芦 / 断剑）
  /// epithet          江湖称号（“剑魔” / “活阎王”）
  content     String   // 诗号全文 / 台词 / 动作描述
  trigger     String   // entrance | exit | battle | anger | death | first_meet | always
  /// ★ 频率控制——“手法”与“滥用”的边界
  frequency   String   // once(仅首次) | key_moment(关键时刻) | every_scene(高频口头禅)
  examples    String?  // JSON: 使用示例
  isActive    Boolean  @default(true)
  deletedAt   DateTime?
}
```

**为什么 `frequency` 是必需的**：若不控制，每次出场都吟诗会变成尴尬的套路。`once` 只用于首次正式出场；`key_moment` 留给生死关头；口头禅才用 `every_scene`。

### 3.17 写作手法库

```prisma
model WritingTechnique {
  id        String   @id @default(cuid())
  projectId String
  name      String   // 欲扬先抑 / 三幕式 / 反差萌 / 留白 / 悬念前置
  category  String   // rhythm | description | dialogue | foreshadow | emotion | entrance
  content   String   // 具体怎么做
  scope     String   // global | arc | chapter | character
  examples  String?  // JSON: { good, bad }
  priority  Int      @default(3)
  isActive  Boolean  @default(true)
}
```

**三个“写法”概念的分工（易混淆，必须分清）：**

| 概念 | 管什么 | 层级 | 例 |
|---|---|---|---|
| `StyleAsset` | **整体语感**（用词/句式/节奏） | 书级 | “冷硬短句，少形容词” |
| `WritingTechnique` | **具体手法**（可开关、可测效果） | 书/卷/章/角色 | “欲扬先抑”、“留白” |
| `CharacterSignature` | **角色专属标记** | 角色级 | 出场诗、口头禅 |

**注入策略按 `scope`：** `global` → 每次进 system；`chapter` → 只在该 `beatType` 的章注入；`character` → 只在该角色出场时注入。

### 3.18 参考资料（联网搜索）

> 设计依据：用户要求小说有现实背景时能联网搜资料，且不造轮子。Tavily key 已实测可用。

```prisma
model Reference {
  id           String   @id @default(cuid())
  projectId    String
  query        String
  provider     String   // tavily | bocha | searxng
  title        String?
  url          String?
  snippet      String?
  content      String?  // 清洗后的正文
  fetchedAt    DateTime @default(now())
  /// JSON: 被哪些 generation_run 引用过（可追溯）
  usedInRunIds String?
}
```

**三条硬规则：**
1. **L3 级别**：不经用户显式授权，不得进 prompt
2. **绝不自动每章搜**：只在用户手动触发或蓝图标记了考证点时搜（否则烧钱且引入噪声）
3. **入库可复用**：同一查询不重复调用

---

## 4. 核心流程：单章共创

### 4.1 九步时序

```
[1] 用户点击「写第 N 章」
        │
[2] 装载（core/context/loadChapterContext）
    ├─ Project（含锚点）
    ├─ Blueprint(chapterNo=N)          —— 必须存在，否则拒绝
    ├─ Characters[castIds]             —— 只取出场角色
    │   └ 每个：静态 + 当前状态(chapterNo<N) + visualAnchor
    ├─ CharacterRelation[参与角色之间]
    ├─ PowerTier[涉及角色当前 tier 及对手 tier]
    ├─ WorldRule[hard 全量 + soft 相关]
    ├─ PlotThread[active 且 plantedChapter<N]
    ├─ UnresolvedSetups                —— 自动计算
    ├─ Summary[最近 3 章]
    ├─ PreviousEnding[上章结尾 800 字]
    └─ StyleAsset[默认 + 本章绑定]
        │
[3] 装配（prompt/assemble + prompt/budget）
    ├─ 按固定顺序渲染 blocks
    ├─ 按优先级裁剪，产出 degradationLog
    └─ 输出 { messages, tokenEstimate, degradationLog }
        │
[4] 建 GenerationRun(status=running, assembledPrompt=JSON.stringify(messages))
        │
[5] 调用 LLM（流式）
    ├─ SSE 推送前端
    ├─ AbortSignal 支持中断 → status=partial
    └─ 完成后写 usage / cost / status
        │
[6] 切分（core/text/splitScenes）
    ├─ 优先按 ===场景N=== 标记
    ├─ 失败降级：空行 + 长度启发式，记 warnings
    └─ 产出 DraftSegment[](status=candidate)
        │
[7] 前端逐场景展示（新建 / 重写 / 局部）
        │
[8] 用户逐场景操作
    ├─ accept  → status=accepted + 写 EntityRevision
    ├─ reject  → status=rejected
    └─ edit    → 用户改后 accept
        │
[9] 定稿
    ├─ 校验：该章无 candidate
    ├─ Blueprint.status = finalized
    ├─ 可选：标记角色 stateStale
    └─ 可选：写 QualityReview
```

### 4.2 Prompt 的固定顺序（稳定性 = 缓存命中率）

顺序一旦变化，DeepSeek 的缓存前缀就失效。**顺序是设计的一部分，不是实现细节。**

```
system:
  [S1] 角色身份与职责
  [S2] 文风契约（styleAsset.description + samples）
  [S3] 反 AI 规则（bannedWords / bannedPatterns / quantLimits）
  [S4] 世界 hard 规则          ← 稳定
  [S5] 力量体系（用到的 tier）  ← 较稳定
  [S6] 角色静态设定（出场角色）  ← 较稳定
  [S7] 角色关系
  [S8] 输出格式约定（===场景N=== / 空行分段 / 字数 / 纯文本）

user:
  [U1] 全书进度（蓝图时间线）   ← 每章+1，前段稳定
  [U2] 未兑现清单
  [U3] 近期 3 章摘要
  [U4] 上章结尾 800 字
  [U5] 本章蓝图（JSON）
  [U6] 后续 2 章蓝图（禁止提前写）
  [U7] 作者本章额外指导

system（末尾追加，首尾夹击）:
  [S9] 【不可偏离的作者事实】锚点四字段
```

> **为什么把锚点放在最后**：应对 lost-in-the-middle。开头说一次、结尾再说一次，中间放易变内容。
> **为什么 S4–S7 在前、U 段在后**：稳定内容前置才能命中缓存（DeepSeek 缓存命中 ¥0.04/M vs 未命中 ¥2/M）。

### 4.3 预算分配与分档降级

| 优先级 | 块 | 预算 | 超预算动作 |
|---|---|---|---|
| P0 | 本章蓝图、hard 规则、锚点 | 15% | **不裁剪**，触发分档流程 |
| P1 | 出场角色卡 + visualAnchor、文风 | 30% | **不裁剪**，触发分档流程 |
| P2 | 近期 3 章摘要 | 15% | 3→2→1 章 |
| P3 | 未兑现清单 | 10% | 只保留 running_gag + 最紧迫 5 条 |
| P4 | soft 世界规则 | 10% | top 5 |
| P5 | 上章结尾 800 字 | 10% | 800→400→0 |
| P6 | 后续 2 章蓝图 | 5% | 2→1→0 |
| P7 | 全书蓝图时间线 | 5% | 压缩为每 5 章一条 |

**分档规则：**

| 使用率 | 行为 |
|---|---|
| < 70% | 正常，无提示 |
| 70–85% | 正常 + 前端黄条提示"已用 78%，建议精简角色卡" |
| 85–95% | 弹窗三选一：`自动精简后生成` / `照原样生成（可能截断尾部）` / `取消` |
| > 95% | 强制精简向导（勾选保留哪些角色/规则） |

**强制契约**：任何 P2–P7 的裁剪都必须追加到 `degradationLog`；用户点"照原样生成"时，直接把该状态写入 `generation_run.degradedReason`。

### 4.4 上下文压缩策略（与 Agent 对话压缩的区别）

OpenFic 的参数（`AUTO_TRIGGER_RATIO=0.8`、`TAIL_TOKEN_BUDGET=20_000`）适用于**对话轮次**压缩。inkloom 的历史是**章节**，不应照搬。

| 层 | 内容 | 策略 | 原文保留 |
|---|---|---|---|
| L0 | 锚点 / 角色静态 / hard 规则 | **永不压缩** | ✅ 结构化 |
| L1 | 蓝图时间线 | **永不压缩**（每章一条，50 字） | ✅ |
| L2 | 上章结尾 | 800 字固定 | ✅ |
| L3 | 近 3 章摘要 | 每章 200 字，LLM 生成，带 `sourceHash` 可重建 | ⚠️ 可重建 |
| L4 | 更早章节 | 由 L1 时间线覆盖，**不做 LLM 全书摘要** | ✅ 原文在库 |

**核心决策：用结构化数据替代文本摘要。**
依据：Pagekin 的 `global_summary` 定义为"章节要点时间线（**从蓝图按序拼装**）"，而非 LLM 总结。20 章后你不需要 20 段摘要，你需要 20 条蓝图要点。

### 4.5 检索策略（大部分不需要 RAG）

| 内容 | 取法 | RAG |
|---|---|---|
| 出场角色 | `blueprint.castIds` 精确取 | ❌ |
| hard 规则 | `priority='hard'` 全取 | ❌ |
| soft 规则 | 名称/内容关键词匹配 top 5（SQLite `LIKE` 或 FTS5） | ❌ |
| 活跃线索 | `status='active' AND plantedChapter<N` | ❌ |
| 历史细节 | 若启用：FTS5（v2）→ 向量（v3） | ✅ 最后手段 |

**v1 不做任何检索。** 1M 窗口 + 精确过滤已足够。

### 4.6 场景切分协议

```
system 中约定输出格式：

===场景1===
（300–800 字，段间用空行分隔）

===场景2===
（…）
```

- **不用 JSON**：中文长文本经 JSON 转义后语感显著下降
- **降级链**：标记切 → 空行+长度启发式切 → 整章作为单场景（记 warning）
- **段落边界**：场景内以空行分段；段落是编辑单位，场景是确认单位

### 4.7 diff 规则

| 情况 | 展示 |
|---|---|
| 空章节 | 全文直出 + 逐场景「接受 / 重写」 |
| 有内容重写 | 左旧右新，场景级 diff |
| 局部重写 | 仅该段 diff |

- 中文用**字符级** diff（`jsdiff` 的 `diffChars`），行级对中文无意义
- diff 只做展示，**不参与落库决策**：落库以"用户接受哪个版本"为准

### 4.8 状态推导算法（`core/context/resolveCharacterState`）

> ⚠️ 自检补漏：原设计只说“取第 N 章的状态”，没给算法。

```
resolveCharacterState(characterId, chapterNo):
  1. 从 entity_revision 取该角色的所有 revision
  2. 过滤：payload.stateChapter != null 且 payload.stateChapter <= chapterNo
  3. 按 payload.stateChapter 降序取第一条 → 即为第 N 章时的状态
  4. 若无匹配（角色尚未“入场”）→ 返回静态设定 + stateChapter=null
  5. 边界：若该 revision 的 stateStale=true → 在上下文中标注「状态待确认」
```

**关键点：以 `stateChapter` 排序，不是以 `version` 排序。** 因为人可能回头补写第 3 章，此时最新的 version 对应的却是第 3 章的状态，不能用于第 10 章。

### 4.9 未兑现清单算法（`core/context/getUnresolvedSetups`）

> ⚠️ 自检重构：原设计只有一行公式，不足以实现。

```
输入: threads[], currentChapter, settings{threshold, maxItems, gagThreshold}

步骤:
 1. 过滤 deletedAt 为空、status 属于 {active, planned}
 2. 计算 lastMentioned:
      lastMentioned = max(plantedChapter, advancedChapters 中所有章节号)
      ↑ 注意 advancedChapters 可能是乱序数组，必须取 max 而非末项
 3. gap = currentChapter - lastMentioned
 4. 定级:
      overdue  : 有 payoffWindow 且 currentChapter >= payoffWindow   （过窗）
      due      : gap >= threshold
      normal   : 其余
      gag_due  : kind=running_gag 且 gap >= gagThreshold
 5. 排序: overdue > due > gag_due > normal；同级按 gap 降序
 6. 截断: 最多 maxItems 条；overdue 不参与截断（必须全部列出）
 7. 输出分组: { overdue[], due[], runningGags[] }
```

**补字段**：`PlotThread` 需新增 `payoffWindow Int?`（期望回收章号），否则无法区分“长线伏笔”与“忘了收”。

### 4.10 场景切分算法（`core/text/splitScenes`）

> ⚠️ 自检补漏：原设计只说“空行 + 长度启发式”，没给规则。

```
输入: text, targetWords(=wordsPerChapter / 预估场景数，默认 600)

1. 若文本匹配 /^===\s*场景\s*\d+\s*===\s*$/m
     → 按标记切分，degraded = false
2. 否则降级:
   a. 按 /\n\s*\n/ 切成段落
   b. 按顺序累积段落，满足任一条件则截止一个场景:
        - 累计字数 >= targetWords * 0.6
        - 遇到场景转换信号词（次日/翌日/与此同时/另一边/三天后/回到…）
   c. 若单段字数 > targetWords * 1.5 → 按句号（。/！/？）二次切分
   d. 若全文 < targetWords * 0.5 → 整章作为单场景
   e. degraded = true
3. 返回 { scenes: [{ sceneNo, paragraphs[], words }], degraded }
```

### 4.11 一致性校验算法（`core/quality/checkConsistency`）

> ⚠️ 自检补漏：原设计只列了规则名，未给判定逻辑。

| 规则 | 判定方式 | 严重度 |
|---|---|---|
| `power_gap` | 场景中识别到两个 `castIds` 角色的对抗动词（战/击败/压制/击败 等），且 A.level - B.level <= -2 且 A 占优 | warn |
| `dead_appears` | 角色 `curPhysical` 含“死”/“身亡”，但名字在该场景出现且有动作 | **error** |
| `location_jump` | 角色 `curLocation` 与蓝图指定地点不同，且场景未出现移动描写 | warn |
| `banned_word` | 命中 `styleAsset.bannedWords` | warn |
| `quant_limit` | 某词全章出现次数 > `quantLimits[词]` | warn |
| `unknown_cast` | 场景中出现了 castIds 且不在全角色表的姓名 | warn |

**v1 定位：只告警不阻断。** 因为“越级挑战”在玄幻里是常态（金手指/阵法/偷袭），硬阻断会误杀。

### 4.12 蓝图生成流程

> ⚠️ 自检补漏：原设计假定蓝图已存在，但 100 章蓝图不可能手填。

```
[生成蓝图] 入口：蓝图页 → “生成本卷蓝图”

前置：项目锚点已填（coreIdea/premise/theme/toneContract）

步骤:
 1. 若尚无 StoryArc → 先生成卷结构（建议 3–5 卷）
    输入：锚点 + 目标总章数
    输出：卷名/起止章/本卷目标/卷末转折章
 2. 选定一卷 → 生成该卷章节蓝图（每批 5–8 章）
    输入：锚点 + 本卷目标 + 已有蓝图要点 + 已定稿章节摘要
    输出：每章 goal/conflict/turn/hook/beatType/tensionLevel
 3. 生成后立即跑 `validateTensionCurve` → 张力曲线告警
 4. 用户逐章审阅修改（表格编辑，非弹窗）
 5. 确认后方可开写该章

输出格式：结构化 JSON（非正文，可以用 JSON）
   —— 与正文场景不同，蓝图不是小说文本，JSON 不影响语感
```

### 4.13 界面设计（交互蓝图）

> ⚠️ 自检补漏：这是原设计最大的缺口。你说“交互式”是核心，但此前只有数据流，没有界面。

#### 主布局：三栏

```
┌──────────┬────────────────────────────┬────────────────┐
│ 左栏 240  │ 中栏（主工作区）              │ 右栏 320       │
│          │                            │                │
│ ▼ 本书    │ ┌─ 第 4 章 · 雾钟 ────────┐  │ ▼ 本章蓝图      │
│   角色(5)│ │ 目标：⋯               │  │  冲突：⋯        │
│   世界    │ │ 张力：●●●●○ 4         │  │  钩子：⋯        │
│   线索    │ ├─────────────────────────┤  │                 │
│   文风    │ │ 已定稿正文（只读）      │  │ ▼ 出场角色      │
│          │ │                        │  │  林岚 ● 金丹    │
│ ▼ 章节    │ │ ┌ 场景 3 ── 候选 ─────┐│  │  ⚠ 状态可能过时 │
│   1 ✓    │ │ │ (diff 视图)         ││  │                 │
│   2 ✓    │ │ └─────────────────────┘│  │ ▼ 未兑现        │
│   3 ✓    │ │                        │  │  🔴 青铜钥匙     │
│ ▶ 4 在写 │ └─────────────────────────┘  │  🟡 老者身份     │
└──────────┴────────────────────────────┴────────────────┘
```

#### 写作模式（核心屏）

场景卡片是确认单元，每张卡片右上角两个动作：

```
┌ 场景 2 ──────────────────── [✓ 接受] [✗ 拒绝] [↻ 重写] ┐
│ 雾气在剑冢上缓缓散开，林岚抬脚向前一步。                     │
│                                                         │
│ “你来得比我想的早。”碑后传来一个苍老的声音。              │
└────────────────────────────────────────────────────────┘
```

**状态视觉：**
- `candidate`：白底 + 左侧蓝色竖线
- `accepted`：灰底 + 淡化，不可编辑（除非点“编辑”解锁）
- `rejected`：折叠为一行“已拒绝 · 重写”，可展开看原文
- diff 模式：删除为红删除线，新增为绿底

**键盘流（写作者效率重点）：**

| 键 | 动作 |
|---|---|
| `J` / `K` | 下一个 / 上一个场景 |
| `Enter` | 接受当前场景 |
| `Esc` | 拒绝当前场景 |
| `R` | 重写当前场景 |
| `Ctrl+Enter` | 生成整章 |
| `Ctrl+S` | 手动保存（正常情况下自动保存） |

#### 张力曲线屏

```
张力
 5 │          ●                    ●
 4 │      ●       ●   ●        ●
 3 │  ●       ●       ●    ●
 2 │●
 1 │
   └─────────────────────────────
     1  2  3  4  5  6  7  8  9  10 章

  ⚠ 第 6–8 章连续 3 章张力为 3（flat_run）
  ⚠ 第 9 章为 climax 但张力仅 4（weak_climax）
```

点击任一数据点 → 跳转对应蓝图表单。

#### 回退入口

| 位置 | 能力 |
|---|---|
| 场景卡右键 | “回到此场景的上一版” |
| 章节页顶栏 | “本章历史” → 时间线列表 |
| 左侧栏底部 | “项目时间机器” → 选任意时间点 |

### 4.14 AI 信息供给分层（给 AI 什么、谁批准）

> 设计依据：用户提出“可视化是给人看的，那给 AI 的是哪些？哪些必须给、哪些可选、哪些必须人批准”。

**按“缺了会怎样”分级：**

| 级别 | 内容 | 给不给 | 谁批准 | 缺了会怎样 |
|---|---|---|---|---|
| **L0 强制** | 锚点（coreIdea/theme/tone）、本章蓝图、hard 世界规则、出场角色状态 | **必须全给** | 建书时一次性 | 必然写崩 |
| **L1 强约束** | 力量体系 tier、角色签名、角色关系、地理距离、未兑现清单 | **必须全给** | 创建要素时 | 一致性崩坏 |
| **L2 上下文** | 前 3 章摘要、上章结尾 800 字、soft 规则 | 尽量给 | 不需批准（可降级但留痕） | 衔接生硬 |
| **L3 参考** | 联网搜索结果、久远章节细节 | 按需 | **必须显式授权** | 可能引入噪声、跑偏 |
| **L4 可选** | 视觉锚点、写作手法、文风样本 | 可选 | 需 | 影响风格，不影响正确性 |

**三条与审批相关的硬规则：**

1. **L0/L1 绝不静默裁剪** — 超预算走 4.3 的分档流程，由用户显式选择
2. **L3 必须显式授权** — 搜索结果先入库展示，用户勾选后才进 prompt
3. **所有降级写入 `degradedReason`** — 事后可归因

**一个关键认知：同一份数据，两个投影。**

```
                 ┌───────────────┐
                 │  数据模型      │  ← 唯一事实源
                 └──────┬────────┘
               ┌────────┴────────┐
               ▼                 ▼
   ┌────────────────────┐  ┌──────────────────┐
   │ 人的视图（可视化）   │  │ AI 的视图（装配） │
   │ 叙事地图/关系网络   │  │ 结构化文本        │
   │ React Flow         │  │ prompt assembler │
   └────────────────────┘  └──────────────────┘
```

**在关系图上拉一根线** → 写入 `CharacterRelation` → **prompt 装配读同一张表**。
图形化不是另一套数据，是同一套数据的不同呈现。这就是整体不“分散”的原因。

### 4.15 可视化视图设计（图形化创作，而非“文字换皮”）

> 设计依据：用户批评“你出的都是文字，跟网页上跟 AI 对话没区别”。
> → 真正的图形化不是把文字画成图，而是**图本身就是操作界面**。

#### 视图 1：叙事地图（主视图，P1）

横轴章节、纵轴张力，**块是章，颜色是节拍类型**。

```
张力
 5 │                              ┌────┐
   │                        ┌────┐│ 12 │
 4 │                  ┌────┐│ 9  ││    │
   │            ┌────┐│ 7  ││    │└────┘
 3 │      ┌────┐│ 5  ││    │└────┘
   │┌────┐│ 3  ││    │└────┘
 2 ││ 1  ││    │└────┘
   │└────┘└────┘
 1 │
   └─────────────────────────────────
    第1章  第3章  第5章  第7章  第9章  第12章
    ├──── 入道卷 ────┼──── 试炼卷 ────┤
```

**操作（关键：图即操作）：**
- **上下拖块** = 直接改 `tensionLevel` 并保存
- **看到塌陷** = 一眼看出节奏问题，不需读文字告警
- **块颜色** = `beatType`（setup 灰 / rising 蓝 / climax 红 / twist 紫）
- **点击块** = 展开该章场景列表

#### 视图 2：关系网络（P1）

```
               ┌─ 苏婉 ●
              ╱  盟友(4)
    ● 林岚 ──┤
              ╲  师徒(5)
               └─ 玄阳子 ●

         [时间滑块: ◀──●──────▶ 第 12 章]
```

- 节点 = 角色（大小 = 出场次数，颜色 = 阵营）
- 边 = 关系（金=师徒 / 红=敌对 / 绿=盟友；粗细=强度）
- **拖两个节点连线** = 直接建立关系（不用写文字）
- **拖时间滑块** = 看到第 N 章时的关系状态（利用 `sinceChapter/untilChapter`）

> 滑块是杀手功能：盟友变敌人的过程，一拖就看出来。

#### 视图 3：人物轨迹（P2）

```
林岚
 ●─────●─────●─────●─────●─────●─────●
 第1章  第3章  第5章  第8章  第12章 第15章 第20章
        └──────── 青铜钥匙（未回收，5章未提）──────┘
                              └───苏婉（盟友，第8章起）────┘
```

- 纵向节点 = 关键事件；横向线 = 伏笔/关系的生命周期
- **线断了 = 还没回收**，一眼看出这个角色悬着几条线索

#### 视图 4：章节场景地图（P2）

```
时间 ──────────────────────────────────▶
[场景1 山门·晨] ──▶ [场景2 后山·午] ──▶ [场景3 密道·夜]
      冲突:质问          转折:发现          钩子:黑影出现
```

块之间的箭头 = 场景转换。**两个场景之间没有箭头 = 衔接断了**，这是 AI 最容易写崩的地方。

#### 视图 5：世界观地图（P4+）

地点节点 + `Route` 边（标注天数）+ 势力范围。玄幻刚需，但可后置。

#### 视图联动

```
叙事地图 ──点章──▶ 章节页（写作）
   ▲                  │
   │            点角色名
   │                  ▼
   └──── 人物轨迹 ◀── 关系网络（拖滑块）
              │
          点事件
              ▼
           回到那一章
```

#### 技术选型（全部现成，不手搓）

| 需求 | 库 | 说明 |
|---|---|---|
| 节点-边画布、拖拽、连线、缩放 | **`@xyflow/react`**（React Flow） | 事实标准 |
| 力导向布局（关系图） | **`d3-force`** | 不自写物理引擎 |
| 分层布局（叙事地图坐标系） | **`dagre`** | 自动排布 |
| 图表 | **`recharts`** | — |

React Flow 的 `custom node` 机制使得“章节块”可以直接把拖拽事件绑到 `tensionLevel` 更新，**不需自己实现拖拽逻辑**。

#### P0/P1 做哪两个（已确认）

**叙事地图 + 关系网络先做**（前者解决“结构可见”，后者解决“关系可编辑”），人物轨迹放 P2。

### 4.16 判断层（JEV）与多智能体演进

> 设计依据：用户提出未来要做多智能体分工，甚至每个角色配一个 agent 做推演。
> 实测依据：JEV（TypeSafe System One Model）三种原语 Choice/Score/Noul，
> 70–500ms，$0.042/M 输入，输出免费；已有小说专用模型 `jev-novel-3-27b`。

#### 三层分工（按“需要什么能力”切，不是按阶段堆）

```
┌───────────────────────────────────────────┐
│ L3 生成层   写正文 / 生成诗号 / 生成蓝图      │  LLM
│             只有一个，不需要多智能体          │  慢、贵、需创造力
├───────────────────────────────────────────┤
│ L2 判断层   一致性 / 反AI味 / 节奏 / 行为推演  │  ★ JEV
│             大量、并行、需确定性              │  快、便宜、结构化
├───────────────────────────────────────────┤
│ L1 计算层   距离/时间/年龄/战力比较/张力曲线   │  纯函数（core）
│             零成本、零延迟、100% 确定         │  不算 LLM
└───────────────────────────────────────────┘
```

#### JEV 在 inkloom 的具体用法（P2 起）

| 问题 | 原语 | 用途 |
|---|---|---|
| 这段是否拖沓？ | `Score(1-5)` | 节奏诊断 |
| 这句像不像 AI 写的？ | `Score(1-5)` | 反 AI 味检测 |
| 角色 X 在此情境会怎么做？ | `Choice([强攻,退让,观察,求援])` | **角色级推演** |
| 本场景是否应引出出场诗？ | `Noul` | 签名触发 |
| 这条伏笔是否该回收？ | `Noul` | 伏笔提醒 |
| 本段是否与角色状态冲突？ | `Noul` | 一致性检查 |

**成本算给你看**：20 个角色 × 4 个判断 = 80 次调用，**一次请求并行可发**，几百毫秒，成本几分钱。
这直接把“角色级 agent 推演”从幻想变成可落地。

#### 演进路径（每步可独立验证）

| 阶段 | 做什么 | 新增成本 |
|---|---|---|
| **MVP** | 只有 L1 + L3（单次调用） | 0 |
| **P2** | 加 L2：先做“反 AI 味打分”+“一致性检查” | 一个 JEV provider（可接 TypeSafe API 或自部署 Laya） |
| **P3** | 角色级推演：20 个角色各问一次 Choice | 并发调用 |
| **P4** | 多智能体分工：规划者/写作者/审稿者 | 角色分离 |

**关键决策：L2 判断层不进 MVP。** 因为它的前提是“有东西可判断”——得先能生成，才谈得上判断。

---

## 5. 质量机制

### 5.1 结构维度

| 机制 | 位置 | 说明 |
|---|---|---|
| 蓝图必填校验 | `core/entities` | `goal/conflict/hook/beatType/tensionLevel` 不可为空 |
| 张力曲线告警 | `core/quality/validateTensionCurve` | `flat_run` / `weak_climax` / `jump` |
| 后续蓝图防越界 | `prompt/blocks` | 注入后续 2 章但明令禁止提前写 |

### 5.2 人物维度

| 机制 | 说明 |
|---|---|
| 状态按章取值 | `core/context/resolveCharacterState(char, N)` 返回第 N 章时的状态 |
| 境界硬校验 | `core/quality/checkPowerConsistency`：若 A 的 tier.level < B 且场景为正面战斗，告警"战力不符" |
| 死亡/离场校验 | `curPhysical` 含"死亡"或关系 `untilChapter < N` 的角色不应出现在 `castIds` |
| 溯源可查 | 任一状态字段可回溯到 chapter + runId |
| 人工改动不回写 | 只标 `stateStale`，由用户确认 |

### 5.3 文风维度

| 机制 | 说明 |
|---|---|
| 量化上限 | `quantLimits: {"仿佛": 3}` → 生成后统计，超限告警 |
| 禁用词/句式 | 正则匹配，命中即告警（v1 不自动重写） |
| 示例注入 | `samples` 作为 few-shot 片段注入 S2 |

### 5.4 伏笔维度

| 机制 | 说明 |
|---|---|
| 未兑现清单 | 每章生成前自动计算并注入 U2 |
| running_gag 复用提醒 | 单独分组，超过 8 章未复用则提示 |
| 回收校验 | 定稿时检查 `resolvedChapter` 是否被填入 |

---

## 6. 可插拔设计（capabilities）

### 6.1 统一签名

```ts
export interface Capability<I, O> {
  name: string
  description: string
  inputSchema: ZodType<I>
  run(input: I, ctx: ReadContext): Promise<O>
}
```

### 6.2 能力清单（v1）

| name | 作用 |
|---|---|
| `get_chapter_context` | 装载第 N 章所需全部要素 |
| `get_character_state` | 取角色在第 N 章的状态 |
| `get_unresolved_setups` | 未兑现清单 |
| `get_tension_curve` | 全书张力曲线 + 告警 |
| `get_world_rules` | hard 全量 + soft 相关 |
| `check_consistency` | 一致性检查（战力/生死/地点） |
| `assemble_chapter_prompt` | 装配 messages + 预算 + 降级日志 |

### 6.3 三种消费方式

| 场景 | 消费方 | 成本 |
|---|---|---|
| v1 | `apps/api` 直接调用 | 0 |
| 未来 | 包装为 DeepSeek Harness 插件 | ~30 行 |
| 未来 | 包装为 MCP server | ~50 行 |

```ts
// 未来接入 dsh 时的全部代码（示意）
import { defineTool } from '@deepseek-ai/dsh-tools'
import { capabilities } from 'inkloom-core'
export const name = 'inkloom'
export const inject = ['tools']
export function apply(ctx: any) {
  for (const cap of Object.values(capabilities)) {
    ctx.tools.register(defineTool({
      name: cap.name,
      description: cap.description,
      parameters: cap.inputSchema,
      execute: (args: unknown) => cap.run(args as never, ctx),
    }))
  }
}
```

**这就是"可插拔"：能力层稳定，编排层随意换。**

---

## 7. 错误处理与成本

### 7.1 错误矩阵

| 场景 | 处理 | 重试 |
|---|---|---|
| 网络超时 | 指数退避 | ✅ 3 次 |
| 401 鉴权失败 | 立即停，提示检查 `.env` | ❌ |
| 429 限流 | 读 `retry-after` | ✅ 最多 3 次 |
| 流中断 | 保留已生成，`status=partial` | 手工续 |
| 空输出 | `failed`，不落候选 | ✅ 1 次 |
| 场景切分失败 | 启发式降级 + `warnings` | — |
| Zod 校验失败 | 重试 1 次，仍失败则 `failed` | ✅ 1 次 |
| DB 写失败 | 事务回滚，`failed` | — |

### 7.2 写操作幂等（抄 Pagekin 的 `commitState`）

```
not_committed → 确定未写，可重试
committed     → 确定已写
unknown       → 超时且已开始写 → 绝不自动重试，标「待人工确认」
```

**规则**：写库前先置 `commitState='pending'`，事务提交后置 `committed`；超时则置 `unknown` 并**禁止自动重试**。

### 7.3 成本控制

| 机制 | 实现 |
|---|---|
| 单次预算 | 装配后若 `tokenEstimate > 阈值`，需用户确认 |
| 项目/日预算 | 累计 `costCents`，超限拒跑 |
| 缓存优化 | 稳定内容前置（见 4.2） |
| 记账 | 每次 run 写 usage / cacheHit / cost |

**参考单价**（2026-10 实测）：

| 模型 | 输入 | 输出 | 缓存命中 |
|---|---|---|---|
| `deepseek-flash`（官方） | — | — | — |
| `deepseek-ai/DeepSeek-V4.1-Flash`（硅基流动） | ¥2/M | ¥8/M | **¥0.04/M** |
| `Tongyi-MAI/Z-Image-Turbo` | — | — | ¥0.10/张 |
| `Kwai-Kolors/Kolors` | — | — | **免费** |
| `Qwen/Qwen-Image-Edit` | — | — | ¥0.30/张 |

---

## 8. 测试体系

### 8.1 六类测试

| # | 类型 | 工具 | 范围 | 门槛 |
|---|---|---|---|---|
| 1 | 单元 | Vitest | `core` 全部纯函数 | **覆盖率 >80%** |
| 2 | 快照 | Vitest snapshot | `prompt` 装配输出 | 变更须人工 review |
| 3 | 契约 | Vitest | AI 不听话的各种情况 | 全部通过 |
| 4 | 录制回放 | 自定义录放器 | LLM 响应重放 | CI 零 API 调用 |
| 5 | 集成 | Vitest + 临时 SQLite | 事务/幂等/并发/回滚 | 全部通过 |
| 6 | E2E | Playwright | 4 条关键旅程 | 全部通过 |

### 8.2 契约测试用例（模拟"AI 一定会犯的错"）

| 用例 | 断言 |
|---|---|
| 无场景标记 | 降级切分生效 + `warnings` 记录 |
| 非法 JSON | Zod 失败 → 重试 1 次 → 仍失败则 `failed` |
| 空 content | `failed`，无候选落库 |
| 5 万字超长 | 按目标字数截断 + 标记 |
| 出场了 castIds 外的角色 | 一致性检查告警 |
| 违反 hard 世界规则 | 告警 |

### 8.3 E2E 四条旅程

| # | 旅程 | 断言 |
|---|---|---|
| 1 | 建书 → 建 3 角色 → 建蓝图 | 数据落库可见 |
| 2 | 生成 → 接受场景1 → 拒绝场景2 → 定稿 | 定稿只含场景1 |
| 3 | 回退到上一版 | 正文恢复 + 多一条 revision |
| 4 | 时间点回退 | 所有实体指向旧版本 |

**E2E 不测"AI 写得好不好"**——无法自动断言。

### 8.4 夹具一物三用

`fixtures/qixia/`（玄幻示例：5 角色、5 章蓝图、5 境界、3 线索、前 3 章正文）同时作为：单测输入、集成数据、E2E 种子、人工评估样本。

### 8.5 CI 策略

```yaml
PR:      biome check → tsc --noEmit → test(unit+snapshot) → test:int → knip
不执行:  任何真实 LLM 调用、test:record
nightly: test:e2e（仍使用录制 fixture）
```

**成本红线：CI 中零 API 花费。**

---

## 9. 工程约定

### 9.1 工具链

| 用途 | 选择 | 理由 |
|---|---|---|
| 包管理 | pnpm workspace | 已在用，workspace 原生 |
| 后端框架 | Hono | 轻，TS 原生，SSE 友好 |
| ORM | Prisma + SQLite | 类型安全，迁移成熟 |
| 校验 | Zod | 前后端共 schema |
| LLM | Vercel AI SDK | 流式/多 provider 现成 |
| 前端 | React 19 + Vite | — |
| 状态 | Zustand（按域拆分） | 轻，无 provider 嵌套 |
| 数据请求 | TanStack Query | 缓存/重试现成 |
| 编辑器 | Tiptap | 生态大，单人项目查资料方便 |
| 样式 | Tailwind + shadcn/ui | 不手搓 UI 原语 |
| Lint/Format | **Biome** | 一个工具替代 ESLint+Prettier |
| 单测 | Vitest | 与 Vite 同源 |
| E2E | Playwright | — |
| diff | jsdiff | 不手搓算法 |

### 9.2 质量门禁

```bash
pnpm biome check        # lint + format
pnpm tsc --noEmit       # typecheck (strict)
pnpm test               # 单元 + 快照
pnpm test:int           # 集成
pnpm knip               # 未使用依赖/导出
pnpm depcheck           # 依赖卫生
```

**代码量告警**：单文件 >300 行 → warning；>500 行 → CI failure。

### 9.3 "不手搓"的验证机制

**PR 模板必填三问：**
1. 这个功能查过哪些现成库/方案？为什么不用？
2. 影响哪些 `capabilities`？
3. 是否新增了对 `core` 的 IO 依赖？

**自动化**：`knip` + `depcheck` + 依赖变更需在 PR 中说明理由。

### 9.4 Git 约定

| 项 | 约定 |
|---|---|
| 主分支 | `main`，保护，禁直推 |
| 分支 | `feat/` `fix/` `chore/` `docs/` |
| Commit | Conventional Commits |
| PR | 一 PR 一主题，小而频 |
| 版本 | `0.0.x` 起步 |

### 9.5 各阶段 DoD

| 阶段 | DoD（可验证） |
|---|---|
| P0 | `prisma migrate` 通过；`core` 覆盖率 >80%；可建书/角色/蓝图；任意要素可回退且留痕 |
| P1 | `prompt` 快照锁定；`generation_run` 存完整 `assembledPrompt`；能生成并切场景 |
| P2 | 场景接受后落 `EntityRevision`；拒绝不落库；定稿章节可导出 |
| P3 | `visualAnchor` 出现在装配结果中（快照可证） |
| P4 | 生成图落本地；`Asset` 记录 prompt/provider/seed 可复现 |

### 9.6 性能与规模分析

> ⚠️ 自检补漏：此前未做规模测算。

**典型规模（一本 300 章玄幻）：**

| 实体 | 估算行数 | 影响 | 应对 |
|---|---|---|---|
| `Chapter` | 300 | 小 | — |
| `DraftSegment` | 300 章 × 8 场景 × 5 段 ≈ **12,000** | 中 | 按章加载，不跨章取正文 |
| `EntityRevision` | 每段改 3 次 ≈ **36,000** + 要素版本 | **大** | 索引 + 定期归档 |
| `PlotThread` | 50–200 | 小 | — |
| `Asset` | 20–50（图） | 文件为主 | 路径存库，文件存本地 |
| `GenerationRun` | 300 章 × 3 次 ≈ 900 | 中（`assembledPrompt` 大） | 超过 90 天的 `output` 可压缩 |

**三条硬约束：**

1. **正文永不全部加载** — 任何接口必须带 `chapterNo`；全书导出走流式
2. **避免 N+1** — 装配一次需要角色/规则/线索/摘要，必须用 `IN` 批量查询，否则 10 次往返
3. **`EntityRevision` 归档** — 超过 180 天且已被覆盖的版本，`payload` 压为 gzip 存储

**搜索**：v1 用 SQLite `LIKE`（够用），v2 上 FTS5。全文 90 万字下 FTS5 索引约 30MB，可接受。

### 9.7 首次使用流程（空状态）

> ⚠️ 自检补漏：原设计没有“从零到第一句正文”的路径。

```
[1] 欢迎 → “创建你的第一本书”
[2] 基本信息：书名 / 题材（默认玄幻）/ 目标章数 / 每章字数
[3] 创意锚点（可跳过，但强烈建议）：
      一句话创意 / 主题 / 语调契约
[4] 力量体系：从模板选（练气→筑基→金丹→元婴→化神）或自定义
[5] 主角卡：至少姓名 + 一句身份描述
[6] 生成前 3 章蓝图（可选，可跳过）
[7] 进入第 1 章写作页，空状态提示：
      “先写蓝图，或直接让 AI 写一个开头”
```

**空状态设计原则**：每个空列表都要有一个“向下一步”的行动按钮，而不是一片白。

### 9.8 书籍生命周期

```
draft（创作中） ──→ completed（完结） ──→ archived（归档，只读）
     ↑                    │
     └───(重新开启)────────┘
```

| 状态 | 允许的操作 |
|---|---|
| `draft` | 全部 |
| `completed` | 可读可导出；新增章节需先“重新开启” |
| `archived` | 只读；可导出、可恢复 |

**归档不是删除。** 删除书籍是另一项高危操作，需二次确认 + 自动备份。

### 9.9 密钥与运行时安全

| 项 | 做法 |
|---|---|
| 密钥存储 | `.env`（不入库）+ 启动时读取；`.env.example` 只有占位符 |
| 密钥校验 | 启动时探测各 provider 可用性，失败则只禁用对应功能，不阻止启动 |
| 本地服务绑定 | 默认 `127.0.0.1`，**不监听 `0.0.0.0`** |
| 日志脱敏 | 日志中 `Authorization` / `sk-` 前缀一律星号化 |
| 导出脱敏 | 导出 JSON 时制除密钥字段（本来就不在库里） |

---

## 10. 交付计划

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 地基：schema + 版本机制 + `core` 纯函数 + 基础 CRUD | 2–3 周 |
| P1 | 单章共创：装配 + 生成 + 切分 | 2 周 |
| P2 | 确认流程：diff + 接受/拒绝 + 定稿 + 回退 UI | 1–2 周 |
| P3 | 视觉锚点：`Asset` + `visualAnchor` 注入 | 2–3 天 |
| P4 | 人物卡生成 + 识图填锚点 | 2–3 天 |

---

## 11. 风险与未决

### 11.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **平台价值被高估** | 写第 1 章时与裸模型无差异，用户失望 | 已在需求文档明确写出；差异从第 3 章后显现 |
| **prompt 越调越乱** | 质量无声退化 | 快照测试强制人工 review |
| **模型 API 变动** | 生成中断 | LLM 层单独抽象，可换 provider |
| **过度设计** | P0 做太久 | 严格 YAGNI；每阶段 DoD 可验证 |
| **中文 diff 体验差** | 逐段确认难用 | 用字符级 diff；场景粒度而非段落粒度 |

### 11.2 未决问题

见 `REQUIREMENTS.md` 第 7 节（Q1–Q6），需在对应阶段开始前回答。

---

## 附录 A：设计决策记录（ADR）

| # | 决策 | 理由 | 否定方案 |
|---|---|---|---|
| ADR-1 | 选 TS 全栈而非 Python | Pagekin/Biz Novel 均为 TS 全栈；单语言降低维护成本 | Python + FastAPI（LangGraph 生态更成熟但双语言） |
| ADR-2 | 不 Fork 任何现有项目 | 23–36 万行存量，改造量超重写；且它们的交互范式无差异化 | Fork OpenFic（Apache-2.0 可商用） |
| ADR-3 | 不引入 DeepSeek Harness | `dsh-tools@0.0.1-rc.1`；且不提供领域价值 | 用 dsh 做 Agent 底座 |
| ADR-4 | append-only 存全量快照 | 快照自解释，diff 需重放易失效 | 存 diff |
| ADR-5 | 场景级确认为主，段落为编辑单位 | 段落太碎（一章 40 次确认），整章太粗 | 整章确认（Pagekin 做法） |
| ADR-6 | 用 `===场景N===` 标记而非 JSON | JSON 转义损伤中文语感 | 结构化 JSON 输出 |
| ADR-7 | 上下文压缩靠「蓝图时间线」而非 LLM 摘要 | 结构化比摘要更准、更省、更可控 | LLM 逐章总结 |
| ADR-8 | v1 不做 RAG | 1M 窗口 + 精确过滤已足够 | 直接上向量库 |
| ADR-9 | 写操作按 `commitState` 三态处理 | 超时后自动重试可能写出重复草稿 | 无脑重试 |
| ADR-10 | 不做 A/B 对比测试，改人工评分+留痕 | A/B 最终仍由人判断，无额外信息量 | 严格 A/B |
| ADR-11 | 蓝图生成用 JSON，正文生成用文本标记 | 蓝图是结构数据，JSON 无副作用；正文是文学文本，JSON 转义会损伤语感 | 统一用 JSON |
| ADR-12 | 一致性校验只告警不阻断 | 越级挑战/金手指/阵法在玄幻中是常态，硬阻断会误杀 | 硬拦截 |
| ADR-13 | 角色状态按 `stateChapter` 排序，不按 `version` | 人可能回头看写第 3 章，最新 version 对应的是旧章状态 | 按 version 取最新 |
| ADR-14 | `overdue` 项不参与数量截断 | 当已过回收窗口的伏笔不列，等于放任烂尾 | 统一截断 |
| ADR-15 | 蓝图生成必须走“卷→章”两级 | 直接生成 100 章蓝图会失去起伏节奏 | 一次性生全书 |
| ADR-16 | 距离/时间/年龄等事实由系统算，不让 AI 估 | AI 估算每次不同，必然前后矛盾 | 让 AI 自由发挥 |
| ADR-17 | 可视化用 React Flow，不自写拖拽引擎 | 拖拽/连线/缩放/布局均有成熟实现 | D3 手写 / Canvas 自绘 |
| ADR-18 | L2 判断层用 JEV 而非 LLM | 20 角色×4 判断用 LLM 既慢又贵（JEV 几百毫秒、几分钱） | 全部用 LLM 推演 |
| ADR-19 | L2 判断层不进 MVP | 前提是“有东西可判断”，得先能生成 | MVP 就上判断层 |
| ADR-20 | 角色签名必须带 `frequency` 控制 | 每次出场都吟诗会变成尴尬套路 | 只要有签名就每次都注入 |

---

## 附录 B：参考项目证据索引

| 结论 | 来源 | 具体位置 |
|---|---|---|
| 三级上下文注入 L0/L1/L2 | Pagekin | `src/services/agent/context-builder.ts` |
| 写操作 `commitState` 三态 | Pagekin | `src/services/agent/agent-engine.ts` L280–330 |
| 角色字段级溯源 `cs_provenance` | Pagekin | `electron/migrations/baseline-schema.ts` L89 |
| `global_summary` 从蓝图拼装 | Pagekin | `src/services/builtin-prompt-templates.ts` L798 |
| 后续蓝图防提前写 | Pagekin | 同上 L803, L823 |
| 反 AI 味量化约束 | Pagekin | 同上 L859（"仿佛/犹如/宛如不超过3次"） |
| 分级审批策略 | Biz Novel | `server/src/agents/approvalPolicy.ts` |
| gate 门禁 | Biz Novel | `server/src/modules/director/domain/gateOrchestrator.ts` |
| 压缩触发参数 0.8/20K | OpenFic | `backend/app/agent_runtime/context/compaction/config.py` |
| 工具契约与恢复 | Denova | `agent/tool/tool_contract.go`、`tool_recovery.go` |
| 回合检定与确定性种子 | Denova | `internal/interactive/orchestration.go` |
| 图文一致性可行 | 实测 | `Qwen/Qwen-Image-Edit` 跨场景保留面部/服饰/道具 |
| 中文文字渲染不可靠 | 实测 | 5 个模型均无法准确渲染"剑冢" |
