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
| `core/context` | 接收**已装载**的要素数组，计算派生结果（状态/清单/曲线） | 不查库、不读文件（IO 在 api 层） |
| `core/quality` | 张力曲线校验、一致性检查、反 AI 规则检测 | 不修改数据 |
| `core/text` | 分段、diff、字数、token 估算 | 不决定用什么模型 |
| `core/capabilities` | 把上述能力包装成统一签名的可调用单元 | 不含业务编排 |
| `prompt/blocks` | 把单个实体渲染成一个文本块 | 不决定顺序 |
| `prompt/assemble` | 决定顺序与结构，产出 messages | 不调用 LLM |
| `prompt/budget` | 按优先级裁剪，返回裁剪日志 | 不抛异常中断流程 |
| `api/services` | 编排：装载 → 装配 → 调用 → 切分 → 落库 | 不实现领域算法 |
| `api/repositories` | 数据存取与事务 | 不含业务规则 |

### 2.4 前端信息架构（七个模块 + 四层递进）

> 设计依据：用户要求“把前端模块展示给用户、说明用户怎么协作、是不是一层一层”。

#### 七个主模块

```
inkloom
├─ 书架 Bookshelf
│   └─ 书卡：封面 / 进度 / 最后编辑
│
└─ 书籍工作区 Workspace
    ├─ ① 概览 Overview     进度・张力曲线・未兑现清单・成本
    ├─ ② 世界 World        力量体系・世界规则・地点/路线・势力
    ├─ ③ 角色 Cast         角色卡・动态状态・签名・关系网络
    ├─ ④ 故事 Story        卷・章节蓝图・叙事地图・剧情线索
    ├─ ⑤ 写作 Write        章节列表・正文编辑器・场景确认
    ├─ ⑥ 素材 Assets       人物形象・场景图・参考资料
    └─ ⑦ 设置 Settings     模型・规则・Skills・MCP・项目配置
```

| 模块 | 回答什么问题 | 核心交互 | 阶段 |
|---|---|---|---|
| ① 概览 | “这本书现在怎么样？” | 看张力曲线、点未兑现项跳转 | P1 |
| ② 世界 | “这个世界的规则是什么？” | 表格编辑 + 图 | P0 |
| ③ 角色 | “这个人是谁、现在什么状态？” | 卡片 + 关系图拖连线 | P0/P1 |
| ④ 故事 | “接下来要发生什么？” | 蓝图表格 + 叙事地图拖块 | P0/P1 |
| ⑤ 写作 | “这一章怎么写？” | 生成 → 逐场景确认 | P1 |
| ⑥ 素材 | “他长什么样？用了什么资料？” | 图廊 + 搜索引用 | P3/P4 |
| ⑦ 设置 | “怎么调它的行为？” | 表单 + 规则编辑 | P2 |

#### 四层递进（渐进式披露）

> 用户问“是不是先完成第一个再第二个”——是，但不是模块顺序，而是**使用深度**的顺序。
> ❗命名修正：此处用 **Stage 1–4**，避开与“信息供给分级 L0–L4”“压缩层 C0–C4”的冲突。

| 层 | 用户阶段 | 实际只用到的 | 界面上可见的按钮数 |
|---|---|---|---|
| **Stage 1 起步** | 第一次写 | 书架 → 建书 → 写作页 | ~3 个 |
| **Stage 2 成形** | 写到第 3 章 | + 角色卡 + 章节蓝图 | ~8 个 |
| **Stage 3 规模化** | 写到第 10 章 | + 世界规则 + 概览（张力/伏笔） | ~15 个 |
| **Stage 4 精修** | 追求质量 | + 素材 + 设置（规则/Skill/MCP） | 全部 |

**实现机制**：后层模块默认折叠在侧边栏“更多”里，当数据出现时才提醒。例：
- 建了第 2 个角色 → 提示“要不要看看关系图？”
- 蓝图超过 5 章 → 提示“张力曲线可以看了”

#### 用户协作主流程

```
[首次] 书架 → 新建书 → 填锚点 → （可选）选力量体系模板 → 进写作页
                                                    ↓
[日常] 写作页：看蓝图 → 点“生成”→ 流式输出 → 逐场景 ✓/✗ → 定稿
                                                    ↓
[维护] 概览看告警 → 跳回对应模块修 → 回来继续
                                                    ↓
[调整] 叙事地图拖块改张力 / 关系图拉线建关系 / 角色卡改签名
```

### 2.5 项目文件系统（一本书 = 一个文件夹）

> 设计依据：用户要求“一部书以一个文件夹形式，用户能看到资产在哪，崩溃也不丢”。

#### 目录结构

```
my-novel/                          ← 一本书的根目录，用户可自由移动/备份/压缩
├── novel.json                     ← 项目元数据（锚点、配置、阶段）
├── world/
│   ├── power-system.json          ← 力量体系（含 tiers）
│   ├── rules.json                 ← 世界规则（hard/soft）
│   ├── locations.json             ← 地点
│   └── routes.json                ← 路线（天数）
├── characters/
│   ├── index.json                 ← 索引（名字/角色类型）
│   ├── lin-lan.json               ← 单个角色（静态设定 + 动态状态）
│   ├── relations.json             ← 关系图数据
│   └── signatures.json            ← 角色签名（诗号/口头禅）
├── story/
│   ├── arcs.json                  ← 卷
│   ├── blueprints/ch-001.json     ← 每章一份
│   ├── threads.json               ← 剧情线索
│   └── techniques.json            ← 写作手法
├── chapters/
│   ├── ch-001.md                  ← ★ 正文用 Markdown，用户可直接打开看
│   ├── ch-002.md
│   └── ch-003/
│       └── scenes/                ← 未定稿的场景候选
│           ├── s1.v1.md
│           └── s1.v2.md
├── styles/default.json            ← 文风资产
├── assets/
│   ├── characters/lin-lan-portrait.png
│   └── references/                ← 搜索结果缓存
├── .inkloom/                      ← 内部数据（用户不需要看）
│   ├── index.sqlite               ← ★ 索引/查询缓存，可随时重建
│   ├── runs/                      ← 生成记录（assembledPrompt 等）
│   └── backups/                   ← 自动快照
└── README.md                      ← 自动生成的书目说明（人可读）
```

#### 三个关键决策

**1. 正文用 Markdown 文件，不用数据库**

| 好处 | 说明 |
|---|---|
| 用户可直接看 | 用任何编辑器打开都能读 |
| 不被软件绑架 | 就算 inkloom 删了，稿子还在 |
| Git 友好 | 可天然用版本管理 |
| 崩溃不丢 | 文件系统是最可靠的存储 |

**2. SQLite 降级为索引**

以前设计把 SQLite 当主存储，现在降为**查询缓存**：
- 可从文件重建（`inkloom reindex`）
- 丢了不影响数据
- 删了重新生成

**这是架构上的重要修正**——数据主权交还给用户。

**3. 版本用 Git，不自研 revision**

| 场景 | 做法 |
|---|---|
| 接受场景 / 定稿 | 自动 `git commit`（有意义的节点才提交）|
| 回退 | `git revert` 或 `git checkout <hash> -- <file>` |
| 对比 | `git diff`（可直接展示在 UI）|
| 备份 | 推送到私有 remote（可选）|

**取舍**：如果用户不想用 Git，仍保留 `.inkloom/backups/` 自动快照作为保底。
两种模式在设置里切换：`versionMode: git | snapshot`。

> 这使 `EntityRevision` 表的角色变为“查询加速器”，而非唯一版本源。

#### 导入与导出

| 操作 | 说明 |
|---|---|
| 导入 | 选文件夹 → 校验 → 加载；或从 txt/md 导入（P2）|
| 导出·备份 | 复制文件夹即可（含 .inkloom/revisions 与 Git 仓库）|
| 导出·整书 JSON | `inkloom export --format json` → 合并 novel.json + 全部要素 + revisions 为单文件 |
| 导出·正文 Markdown | `inkloom export --format md` → 合并所有 `ch-NNN.md` 为单文件 |
| 导出·正文 TXT | `inkloom export --format txt` → 纯文本，去 Markdown 标记与 HTML 注释 |
| 迁移 | 换电脑 = 拷贝文件夹 |

> ❗二次审查修正：P0-12 要求「导出整本书为 JSON」与「正文导出 Markdown / TXT」，
> 原设计只写了“复制文件夹 / 导出单文件 .md”，**JSON 与 TXT 无对应功能**，P0 验收无法执行。

### 2.6 数据一致性与并发契约

> ⚠️ 审查后新增。原设计留下三个阻塞级问题：正文三份共存、revision 与 Git 双版本系统、并发无控制。

#### 单一事实源（铁律）

| 层 | 角色 | 可丢弃？ |
|---|---|---|
| **文件**（`.md` / `.json`） | **唯一事实源** | ❌ |
| SQLite `index.sqlite` | 派生查询缓存 | ✅ 可删除后 `reindex` |
| `revisions/*.jsonl` | 结构化要素的历史 | ❌ |
| Git 仓库 | 正文文件的历史 | ❌（若启用） |

**修正**：`REQUIREMENTS.md` 原写“全部数据存本地 SQLite”已作废；正确表述是“**全部数据存本地文件，SQLite 仅为索引**”。

#### 职责切分（解决 revision 与 Git 双轨）

| 管什么 | 谁管 | 粒度 |
|---|---|---|
| **正文 `.md`** 的历史/回退/diff | **Git** | 文件级 |
| **结构化要素**（角色/蓝图/规则/线索/签名/手法）历史 | **`revisions/*.jsonl`** | 字段级 JSON 快照 |
| 正文的逐场景版本 | **Git**（每次用户动作一次 commit） | 不写 revision |

**铁律：正文不进 revision。** 一句话消除两套版本系统。

#### `.inkloom/` 目录结构（修正）

```
.inkloom/
├── index.sqlite              ← ✅ 可删，可 reindex 重建
├── revisions/                ← ❌ 不可删，要素的真实历史
│   ├── character__lin-lan.jsonl
│   ├── blueprint__ch-004.jsonl
│   └── plot_thread__t-001.jsonl
├── runs/                     ← 生成记录（assembledPrompt）
└── backups/                  ← 自动快照（snapshot 模式保底）
```

JSONL 的好处：append-only、人类可读、损坏可逐行恢复、Git 友好。

#### 写入顺序（原子性）

```
0. 写前 CAS：读目标文件算 contentHash，与索引记录比对
   不一致 → 中止，转「外部修改冲突」流程（见下）
1. 写临时文件 xxx.tmp
2. fsync + rename          ← 原子替换，此刻文件已落盘
3. 追加 revisions/*.jsonl  ← 仅结构化要素需要；必须早于索引
4. 更新 index.sqlite（事务）
5. 若 versionMode=git 且属于“用户动作”节点 → git commit
```

> ❗**二次审查修正**：原顺序把「索引」写在「revisions」之前，然后用补偿事务去回滚一个**本可丢弃**的派生层，
> 去保护一个**必须先写**的事实源——顺序是反的。现在改为 `文件 → 历史 → 索引 → commit`。

| 失败点 | 后果 | 处理 |
|---|---|---|
| 0 | 无副作用 | 转「外部修改冲突」流程，保留两版供用户选择 |
| 1–2 | 无副作用 | 直接报错 |
| 3 | 文件已写，历史缺一条 | 标该要素 `historyGap=true`；下次写该要素时用文件当前值补一条基线 revision |
| 4 | 文件与历史已写，索引旧 | 标记 dirty，下次读取时 reindex（索引本就可丢弃） |
| 5 | 全部已落盘，未提交 | 记 warning，下次动作时补 commit |

#### 并发控制

| 对象 | 机制 |
|---|---|
| 所有写操作 | **单一写队列（in-process mutex）**，强制串行 |
| `version` 取号 | **在单一写队列内**读该要素 JSONL 末行的 `version` +1。文件系统无唯一约束可冲突，单调性由串行队列保证 |
| Git 子进程 | 独立串行队列，同一时刻只允许一个 |
| SQLite | `PRAGMA journal_mode=WAL` + `busy_timeout=5000` |

**硬约束：即使将来恢复并行生成，写入必须串行。** 生成可并行，落库不可。

#### `commitState` 与写入顺序的对齐（幂等依据）

> ❗二次审查修正：`commitState` 上一轮定义了却**没有任何流程使用**，且 §7.2 冒出了集合外的 `pending`。现在把两者对齐。

```
[建 run]  GenerationRun.commitState = 'pending'
            ↓
步骤 0–4  全部落盘（文件 → JSONL → 索引）
            ↓
步骤 5    git commit 完成
            ↓
          commitState = 'committed'

崩溃恢复：启动时扫 commitState='pending' 且超过 60s 的 run
  ├─ 校验文件与 JSONL 是否已到位
  ├─ 已到位  → 补 commit，置 'committed'
  └─ 不确定  → 置 'unknown'，在任务中心标红提醒用户人工确认
```

**三态封闭**：`pending | committed | unknown`。任何其他值都是 bug。

> ⚠️ `commitState` 只挂在 `GenerationRun` 上，但 §2.6 保护的是四类写入
> （文件 / JSONL / 索引 / Git），其中「用户手工改要素」不产生 run。
> 此类写入的幂等由**单一写队列 + 写前 CAS** 保证，不依赖 `commitState`。

#### 外部编辑检测（两道防线，缺一不可）

**防线 1：写前 CAS —— 唯一能真正防丢的手段**

```
写任何文件前：
  1. 读目标文件，算 contentHash
  2. 与索引里记录的 contentHash 比对
  3. 不一致 → 中止写入，进入冲突流程：
     a. 生成冲突副本 <name>.conflict.<timestamp>.md
     b. UI 并排展示两版差异，由用户选「保留我的」/「保留外部」/「手工合并」
  4. 一致 → 允许写入
```

**防线 2：写后轮询 —— 只用于 UI 同步，不用于保护数据**

```
每 2s 轮询 mtime（或用 chokidar watch）：
  if 文件 mtime > 上次读取时间:
    if contentHash 变化:
      1. 重新读取，更新索引
      2. 若该文件存在未确认的候选 → 提示“外部修改覆盖了候选稿”
      3. 强制刷新 UI
```

> ❗**二次审查修正**：原设计只有防线 2。轮询有 2 秒窗口，而 `rename` 是无条件替换——
> 窗口内的手动编辑会被静默吞掉，正是本项要消灭的失败模式。必须有写前 CAS。

#### 索引重建

```bash
inkloom reindex <book-dir>
# 扫描三类文件 -> 重建 index.sqlite
#   .md    -> Chapter / DraftSegment / 字数 / 场景边界
#   .json  -> Project / Character / WorldRule / Blueprint / Location / Route ...
#   .jsonl -> EntityRevision（要素历史：是事实源，但同时作为索引的输入）
# 幂等：可重复执行；以文件内容为准，索引里的一切都可丢弃
```

> ❗**二次审查修正**：原 reindex 只扫 `.md`/`.json` 且明写「不碰 .jsonl」，
> 导致 `EntityRevision` 表无法从事实源重建——append-only 的唯一防线落在了一个不可重建的派生表上。

---

### 2.7 正文文件格式契约

> ⚠️ **二次审查后新增，本节优先级最高。**
> 它是 P0-10（四种回退）、P0-18（reindex）、撤销定稿、单场景重生成、字数统计的**共同前置**。
> 缺了它，定稿就是一次不可逆合并——用户第一次点「撤销定稿」时数据已无法还原，
> 而那时整本正文都已以不可解析的形态落盘。**这个问题无法用后续补丁修。**

#### 一、候选稿（场景级文件）

路径：`chapters/ch-NNN/scenes/s{sceneNo}.v{version}.md`

```markdown
<!-- scene:1 v:3 -->
<!-- seg:a3f -->
林岚踏上山道，风从袖口灌进来。

<!-- seg:b71 -->
她按住腰间玉牌，指节泛白。

<!-- seg:c02 -->
“再往上，就是剑冢了。”老仆的声音从身后传来。
```

| 规则 | 说明 |
|---|---|
| 场景头 | 首行 `<!-- scene:N v:M -->`，`N`=场景号，`M`=该场景版本号（同场景递增） |
| 段标记 | 每段前一条 `<!-- seg:XXX -->`，`XXX` = 3 位 base36 段 ID |
| 段 ID 唯一性 | **全书范围内唯一且永不复用**；删除段时 ID 进墓碑表 |
| 新段分配 | 系统分配；用户在编辑器插入新段 → 编辑器分配新 ID |
| 段内容边界 | 标记之间的内容即该段正文（段内可含软换行，不含标记） |
| 渲染 | HTML 注释在 Markdown 渲染时不可见；纯文本打开可见但不干扰阅读 |

#### 二、定稿文件（章级）

路径：`chapters/ch-NNN.md`

```markdown
# 第四章 剑冢

<!-- scene:1 -->
林岚踏上山道，风从袖口灌进来。

她按住腰间玉牌，指节泛白。

“再往上，就是剑冢了。”老仆的声音从身后传来。

<!-- scene:2 -->
……
```

| 规则 | 说明 |
|---|---|
| 场景边界 | **保留** `<!-- scene:N -->`，它是场景边界的唯一载体 |
| 段标记 | **不保留** —— 定稿是成品，此层回退粒度降为场景级 |
| 章节标题 | `# 第N章 <title>` 一级标题 |

**这是有意的不对称**：候选稿需要段粒度（支持单段回退），定稿只保留场景粒度。
理由：定稿后的编辑走「打开文件直接改 + Git」，不再走应用的段级操作。

#### 三、反解规则（撤销定稿）

```
撤销定稿（finalized → review）：
  1. 读 ch-NNN.md，按 <!-- scene:N --> 切分为 M 个场景块
  2. 每个场景块新建候选文件 s{N}.v{lastVer+1}.md
     └ 段落按空行切分，重新分配段 ID（旧 ID 已随定稿丢弃）
  3. Chapter.status = 'review'
  4. git commit（message 含「撤销定稿」）
```

**代价（必须让用户知情）**：撤销定稿后段落身份是**新分配**的，旧的段级回退记录失效。
这是可接受的——撤销定稿是罕见操作，且**正文内容一字节不丢**。

#### 四、单段回退

```
把段落 P 回退到版本 V：
  1. 读 s{sceneNo}.v{V}.md，取出 seg ID == P 的段内容
  2. 读当前最新 s{sceneNo}.v{latest}.md，替换 seg ID == P 的段内容
  3. 写 s{sceneNo}.v{latest+1}.md（不覆盖旧版本）
  4. 更新 DraftSegment.contentHash；记 changeSource='rollback' 的 revision
```

**关键：回退 = 产生新版本，绝不改写旧版本。** 旧版本永远在 Git 里。

#### 五、时间点回退（Checkpoint）

`.inkloom/checkpoints.jsonl`：

```json
{"id":"ck-0007","label":"第 4 章定稿","createdAt":"2026-10-25T10:00:00Z",
 "gitRef":"a1b2c3d","revisionsOffsets":{"character__lin-lan.jsonl":42,"plot_thread__t-001.jsonl":7}}
```

```
回到检查点 K：
  1. git checkout <K.gitRef> -- chapters/ characters/ world/ story/ styles/
  2. 每个 revisions/*.jsonl 截断到 K.revisionsOffsets[file] 行
  3. reindex
  4. 追加一条 changeSource='rollback' 的 checkpoint（回退本身也留痕）
```

> ❗**为什么必须同时截断 JSONL**：只回 Git 会出现「正文回到第 7 章、角色状态还在第 12 章」。
> 两个事实源必须同点回退，这就是 P0-10「时间点回退」的原子性方案。

#### 六、字数统计口径（三处必须一致）

| 层 | 算法 |
|---|---|
| 段字数 | 去掉标记与空白后的汉字数 + 英文按字母计 |
| 场景字数 | 该场景所有段字数之和 |
| 章字数 | `Chapter.wordCount` = 定稿文件字数（缓存）；未定稿时 = 该章 accepted 段之和 |

---

## 3. 数据模型

### 3.1 版本机制（append-only 的地基）

```prisma
/// 一切可变对象的版本快照。永不 UPDATE，永不 DELETE。
model EntityRevision {
  id               String   @id @default(cuid())
  entityType       String   // project | character | world_rule | power_tier
                            // | blueprint | plot_thread | style_asset | story_arc
                            // ❗不含 draft_segment：正文不进 revision（见 ADR-27）
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
  /// ★ 书文件夹的绝对路径。移动文件夹后需重新绑定
  rootPath        String
  /// ★ 书文件夹内的身份锚（.inkloom/project-id），防止路径变更后认错书
  folderId        String   @unique
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
  /// ★ 书籍生命周期状态：draft | completed | archived
  /// ❗二次审查修正：原设计只说了三态但 Project 无字段可落，P0-1「归档」无法验收
  status          String   @default("draft")
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
  /// ★ 本章发生地点（一致性校验的 location_jump 依赖它）
  locationId   String?
  /// ★ 故事内时间（如“第 12 日 · 辰时”），供时间线校验
  storyTime    String?
  beatType     String   // setup|rising|climax|twist|falling|resolution
  tensionLevel Int      // ★ 1-5，节奏曲线的数据基础
  userGuidance String?
  // ❗已删除 status 字段：章节状态以 Chapter.status 为唯一真相
  @@unique([projectId, chapterNo])
}
```

**张力曲线校验**（`core/quality`，纯函数）：
- 连续 ≥5 章 `tensionLevel` 相同 → `flat_run` 告警
- 高潮章（`beatType='climax'`）`tensionLevel` < 4 → `weak_climax` 告警
- 相邻两章张力跳变 **|Δ| >= 3** → 提示确认是否为有意反转（原写 `> 3` 在 1–5 区间内几乎永不触发）

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

**未兑现清单**：算法统一见 §4.9，本节不再重复定义（原两套规则已合并）。

默认 `unresolvedThreshold = 5`，可在 `ProjectSetting` 调整。

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

> ❗**二次审查修正**：原设计下 `DraftSegment` 是段级行但 `filePath` 指向场景级文件，
> 同一场景的所有段行共享同一个 `filePath`/`contentHash`——`seq` 在文件里没有落点，
> **段落根本无法寻址**，P0-10「单段回退」的回退对象不存在。现已按 §2.7 的段标记方案修复。

```prisma
model DraftSegment {
  id          String @id @default(cuid())
  projectId   String
  chapterNo   Int
  sceneNo     Int     // 场景号 = 确认单位
  /// ★ 段 ID：对应文件里的 <!-- seg:XXX -->，全书唯一、永不复用
  /// (filePath, segId) 唯一定位一段 —— 这是单段回退的唯一凭据
  segId       String
  seq         Int     // 场景内段序（冗余，仅用于排序；位置可变，不作身份）
  /// ❗已删除 content 字段：正文在 .md 文件里，此处只存指纹
  /// 候选稿在 chapters/ch-NNN/scenes/sX.vY.md（含段标记，见 §2.7）
  filePath    String  // 相对书根目录的路径（场景级文件）
  contentHash String  // ★ 该**段**的哈希，非整个文件的哈希
  wordCount   Int?
  status      String  // candidate | accepted | rejected | superseded
  sourceRunId String?
  acceptedAt  DateTime?
  deletedAt   DateTime?
  @@unique([projectId, segId])
  @@index([projectId, chapterNo, sceneNo, seq])
  @@index([projectId, chapterNo, status])
}
```

**不变量（已修正，消除两个“当前正文”定义打架）：**

| 概念 | 由谁表示 |
|---|---|
| **工作稿** | `status='accepted'` 的段落集合 |
| **定稿正文** | `chapters/ch-NNN.md`（存在即已定稿） |
| **装配读取** | **只读 `ch-NNN.md`**，不读 accepted 集合 |
| **定稿条件** | 该章无 `candidate` 段落 |

> 原设计写“accepted 集合构成该章的当前正文”，与 §3.12“只有 finalized 章节才计入已有正文”矛盾。
> 装配到底读哪份直接决定跨章衔接内容，必须二选一——现在选**读定稿文件**。

### 3.10 生成记录（可复现的唯一凭据）

```prisma
model GenerationRun {
  id              String   @id @default(cuid())
  projectId       String
  chapterNo       Int?
  /// ★ 场景号（当 purpose 为场景级时必填）
  sceneNo         Int?
  /// ★ 父 run（并行/多阶段生成时形成树，便于失效传播）
  parentRunId     String?
  /// ★ commitState：写操作幂等的状态机
  /// pending（已开始写，结果未知）| committed | unknown（进程崩溃后发现不确定）
  /// 合法集合封闭为这三态；不得出现第四种
  commitState     String   @default("pending")
  purpose         String   // draft | blueprint | review | repair | segment_split | vision
                          // | scene_skeleton | scene_fill | state_proposal | judge

  provider        String   // deepseek | siliconflow | typesafe-jev
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

  /// ★ 二次审查修正：加 queued——P1-18 任务中心要求展示「排队」态，原集合无此值
  status          String   // queued | running | success | failed | aborted | partial
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
> 导致章节状态、字数统计、C3 摘要无处存放。

```prisma
model Chapter {
  id           String   @id @default(cuid())
  projectId    String
  chapterNo    Int
  title        String?
  /// planned(仅规划) | drafting(在写) | review(待确认) | finalized(已定稿)
  status       String   @default("planned")
  wordCount    Int      @default(0)   // accepted 段落字数缓存

  /// C3 压缩层的章节摘要（约 200 字），由 LLM 生成
  /// ❗命名为 C3 而非 L3：L 专用于信息供给分级（L0–L4）
  summary      String?
  /// 生成摘要时的正文指纹；正文变化则标脏重算
  summaryHash  String?
  summaryStale Boolean  @default(true)

  finalizedAt  DateTime?
  @@unique([projectId, chapterNo])
  @@index([projectId, status])
}
```

**章节状态机（唯一合法转换，已修正）：**

```
planned ──(首个场景产出)──> drafting ──(全部场景 accepted)──> review
                                ▲                              │
                                │                        ┌─────┴─────┐
                           (继续编辑)                 (用户定稿)  (退回编辑)
                                │                        ▼           │
                                └────────────────── finalized         │
                                                          │          │
                                                    (撤销定稿)       │
                                                          ▼          │
                                                        review ◀─────┘
```

**合法边（穷举）：**

| from | to | 触发 |
|---|---|---|
| `planned` | `drafting` | 产出首个场景 |
| `drafting` | `review` | 该章无 `candidate` 段落 |
| `review` | `drafting` | 用户点“继续编辑” |
| `review` | `finalized` | 用户点“定稿” |
| `finalized` | `review` | 用户点“撤销定稿” |

❗ 移除了原设计里 `review → planned` 的错误边（丢失“已有正文”语义）。

**不变量**：
- 只有 `finalized` 章节才计入「已有正文」；`drafting` 章节可被任意重写
- `summaryStale=true` 时不得用于装配（C3 层跳过并降级）
- **`chapterNo` 不可变**：只允许末尾追加，不支持中间插入（写进 P0 验收）；若必须插入，需执行重编号迁移，列入 YAGNI

### 3.12.1 场景骨架 ScenePlan

> ⚠️ 审查后新增。原设计只说了“并行填充”，但没有可审阅的场景单元，也无法做失效传播。

```prisma
model ScenePlan {
  id          String  @id @default(cuid())
  projectId   String
  chapterNo   Int
  sceneNo     Int
  summary     String   // 一句话场景目标
  locationId  String?
  castIds     String?  // JSON
  transition  String?  // 与上一场景的转换（时间/地点/因果）
  wordBudget  Int?
  status      String   @default("planned") // planned | filling | filled
  /// ❗二次审查修正：删去 accepted / rejected——确认态一律归 DraftSegment.status，
  /// 两套状态同时表示“已确认”会互相打架（失效传播时静默降级了用户的确认）
  latestRunId String?
  @@unique([projectId, chapterNo, sceneNo])
}
```

**失效传播规则**：场景 N 被重写时，N+1..M 的 `ScenePlan.status` 回退为 `planned` 并标 `stale=true`，
提示“后续场景可能需重生成”。**已 accepted 的 `DraftSegment` 不被静默降级**——由用户决定是否重生成。

### 3.12.2 模型注册表 ModelProfile

> ⚠️ 审查后新增。原设计说了“70%/85%/95% 分档”但**从未定义分母**，`costCents` 也无价格来源。

```prisma
model ModelProfile {
  id                String  @id          // deepseek-flash
  provider          String  // deepseek | siliconflow | typesafe-jev
  displayName       String
  contextWindow     Int     // 1048576
  maxOutput         Int     // 393216
  /// 价格来源：provider 官方定价页，首次配置时由用户录入并经一次真实调用对账
  /// ❗二次审查修正：原表 deepseek-flash 三列价格均为「—」，
  ///   导致 costCents / dailyCostLimitCents / runCostLimitCents 全部不可计算
  /// ★ 为 null 时：costCents 必须记 null（**不得记 0**），UI 显示「未配置价格」
  inputPricePerM    Float?  // 元/百万 token
  outputPricePerM   Float?
  cacheHitPricePerM Float?
  supportsVision    Boolean @default(false)
  supportsCache     Boolean @default(false)
  isActive          Boolean @default(true)
}
```

**预算分母定义（修正）**：

```
budgetDenominator = min(ModelProfile.contextWindow - ModelProfile.maxOutput,
                        ProjectSetting.budgetTokens)
使用率 = tokenEstimate / budgetDenominator
```

> ❗**重要修正**：`deepseek-flash` 上下文为 1,048,576，30 万字全塞也只占约 30%。
> **因此 70% 告警阈值默认永远不触发**。它真正的价值是：防止未来接入小窗口模型时失控，
> 以及在 `budgetTokens` 被手动调小时生效。_不应再把它宣传为“常规降级机制”。_

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
  /// ★ 手动预算上限（token），null = 用模型上下文窗口
  budgetTokens         Int?

  // 生成模式（已决：默认整章）
  /// whole = 整章一次生成（默认，连贯性最优）
  /// serial_chain = 逐场景串行（上一定稿才生成下一个）
  /// parallel = 两阶段并行（实验，默认关闭）
  generationMode       String  @default("whole")

  // 版本模式
  /// git = 每次用户动作 commit；snapshot = 仅本地快照
  versionMode          String  @default("git")

  // 模型默认
  defaultTextModel     String  @default("deepseek-flash")
  defaultImageModel    String  @default("Tongyi-MAI/Z-Image-Turbo")
  /// ★ 视觉模型（识图用），与文本模型分开
  defaultVisionModel   String? // deepseek-flash（支持 image 输入）

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
  id          String   @id @default(cuid())
  projectId   String
  name        String   // 欲扬先抑 / 三幕式 / 反差萌 / 留白 / 悬念前置
  category    String   // rhythm | description | dialogue | foreshadow | emotion | entrance
  content     String   // 具体怎么做
  scope       String   // global | arc | chapter | character
  /// ★ 作用域指针；scope 决定哪个字段必填，其余为 null
  /// ❗二次审查修正：原设计只有 scope 字符串，arc/chapter/character 三个作用域都无法定位到具体对象
  arcId       String?  // scope=arc 时必填
  chapterNo   Int?     // scope=chapter 时必填（直接指章号，不再用 beatType 推导）
  characterId String?  // scope=character 时必填
  examples    String?  // JSON: { good, bad }
  priority    Int      @default(3)
  isActive    Boolean  @default(true)
}
```

**三个“写法”概念的分工（易混淆，必须分清）：**

| 概念 | 管什么 | 层级 | 例 |
|---|---|---|---|
| `StyleAsset` | **整体语感**（用词/句式/节奏） | 书级 | “冷硬短句，少形容词” |
| `WritingTechnique` | **具体手法**（可开关、可测效果） | 书/卷/章/角色 | “欲扬先抑”、“留白” |
| `CharacterSignature` | **角色专属标记** | 角色级 | 出场诗、口头禅 |

**注入策略按 `scope`：** `global` → 每次进 system；`arc` → 在 `arcId` 对应卷的章范围内进 user；`chapter` → 只在 `chapterNo` 指定的章注入；`character` → 只在该角色出场时注入。

> ❗二次审查修正：原写“`chapter` → 只在该 `beatType` 的章注入”，“该 beatType”指代不明（beatType 是蓝图字段，不是作用域指针），已改为直接给 `chapterNo`。

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
[2] 装载（api/context/loadChapterContext —— 在 api 层做 IO）
    │  ❗core/context 只接收已装载的数组，不读文件
    ├─ ★ Chapter(chapterNo=N)          —— 不存在则创建（status=planned）
    │     ❗二次审查修正：状态机从 planned 起，但原设计全文未定义谁插入该行
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
    ├─ ★ 为每段分配 segId（全书唯一、永不复用）并写入 <!-- seg:ID -->
    └─ 产出 DraftSegment[](status=candidate)
        │
[7] 前端逐场景展示（新建 / 重写 / 局部）
        │
[8] 用户逐场景操作
    ├─ accept  → status=accepted + 原子写 scenes/sX.vY.md + git commit
    │      ❗不写 EntityRevision（正文历史归 Git，见 ADR-27）
    ├─ reject  → status=rejected
    └─ edit    → 用户改后 accept（编辑器按 <!-- seg:ID --> 块编辑，见 §2.7）
        │
[9] 定稿
    ├─ 校验：该章无 candidate
    ├─ ★ Chapter.status = 'finalized'，写 finalizedAt / wordCount
    ├─ 合并场景到 chapters/ch-NNN.md（原子写）→ git commit
    ├─ ★ 状态提案（P1）：LLM 读该章正文 →
    │     输出 [{ field, oldValue, newValue, evidenceQuote }]
    │     用户逐条确认后才写 revisions/ -> 完成后清 stateStale
    ├─ 可选：写 QualityReview
    └─ 可选：标记角色 stateStale（未做状态提案时）
```

### 4.2 Prompt 的固定顺序（稳定性 = 缓存命中率）

顺序一旦变化，DeepSeek 的缓存前缀就失效。**顺序是设计的一部分，不是实现细节。**

```
system（只放跨章不变的内容，否则前缀缓存失效）:
  [S1] 角色身份与职责
  [S2] 文风契约（styleAsset.description + samples）
  [S3] 反 AI 规则（bannedWords / bannedPatterns / quantLimits）
  [S4] 世界 hard 规则
  [S5] 输出格式约定（===场景N=== / 空行分段 / 字数 / 纯文本）

user:
  [U1] 本章场地设定（→ 每章都变，必须放 user）
       ├ 力量体系（用到的 tier）
       ├ 角色静态设定（出场角色）
       └ 角色关系
  [U2] 全书进度（蓝图时间线）
  [U3] 未兑现清单
  [U4] 近期 3 章摘要
  [U5] 上章结尾 800 字
  [U6] 本章蓝图（JSON）
  [U7] 后续 2 章蓝图（禁止提前写）
  [U8] 作者本章额外指导
  [U9] ★【不可偏离的作者事实】锚点四字段
```

> ❗**审查后的重要修正**：原设计把 S5 力量体系 / S6 角色静态 / S7 关系放在 system，
> 但它们**每章都随 castIds 变化**——DeepSeek 是前缀缓存，S5 一变 S6–S9 全部失效。
> 修正后：**S1–S5 真正跨章不变，才能命中缓存；U1 才是每章变化的起点**。
>
> 同时，锚点块必须放在**最后一条 user 消息末尾**（原放在 system 末尾，后面还有 U1–U7，“首尾夹击”实际没成立）。

> **为什么把锚点放在最后**：应对 lost-in-the-middle。开头说一次、结尾再说一次，中间放易变内容。
> **为什么 S1–S5 在前、U 段在后**：S1–S5 跨章不变，才能命中缓存（DeepSeek 缓存命中 ¥0.04/M vs 未命中 ¥2/M）。

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
| **C0** | 锚点 / 角色静态 / hard 规则 | **永不压缩** | ✅ 结构化 |
| **C1** | 蓝图时间线 | **永不压缩**（每章一条，50 字） | ✅ |
| **C2** | 上章结尾 | 800 字固定 | ✅ |
| **C3** | 近 3 章摘要 | 每章 200 字，LLM 生成，带 `summaryHash` 可重建 | ⚠️ 可重建 |
| **C4** | 更早章节 | 由 C1 时间线覆盖，**不做 LLM 全书摘要** | ✅ 原文在库 |

> ❗命名修正：压缩层用 **C0–C4**，不再与“信息供给分级 L0–L4”混用。

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
resolveCharacterState(characterId, chapterNo, revisions[]):
  0. ★ 纯函数：revisions 由 api 层从 .inkloom/revisions/character__<id>.jsonl 读入
     （core 不碰文件系统，只接收数组）
  1. 过滤：payload.stateChapter != null 且 payload.stateChapter <= chapterNo
  2. 按 payload.stateChapter 降序取第一条 → 即为第 N 章时的状态
  3. 若无匹配（角色尚未“入场”）→ 返回静态设定 + stateChapter=null
  4. 边界：若该 revision 的 stateStale=true → 在上下文中标注「状态待确认」
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

 边界（审查后补全）：
   - resolvedChapter != null → 直接排除（已回收）
   - plantedChapter == null（仅 planned 未埋）→ 归入 planned 分组，不参与 gap 计算
   - advancedChapters 解析失败 → 视为空数组，记 warning
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
| `unknown_cast` | 场景中出现**既不在 `castIds`、也不在全角色表**的姓名（需先解析 `castIds` JSON） | warn |

**v1 定位：只告警不阻断。** 因为“越级挑战”在玄幻里是常态（金手指/阵法/偷袭），硬阻断会误杀。

**❗ MVP 范围限定（审查后修正）**：

上表中 **4 条规则需要语义理解**，不可能靠字符串函数完成，依赖 JEV：

| 规则 | MVP 能否实现 |
|---|---|
| `banned_word` / `quant_limit` | ✅ 正则 + 计数，**MVP 可做** |
| `unknown_cast` | ✅ 姓名集合比對，**MVP 可做** |
| `power_gap` / `dead_appears` / `location_jump` | ❌ 需语义判断，**标为 P2（JEV）** |

`dead_appears` 靠 `curPhysical` 含“死”会误中“不死之身”，MVP 不做。

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
| **L0 强制** | 锚点（coreIdea/theme/tone）、本章蓝图、hard 世界规则、出场角色状态、**文风样本（S2）** | **必须全给** | 建书时一次性 | 必然写崩 |
| **L1 强约束** | 力量体系 tier、角色签名、角色关系、地理距离、未兑现清单、**character.visualAnchor（有值时）** | **必须全给** | 创建要素时 | 一致性崩坏 |
| **L2 上下文** | 前 3 章摘要、上章结尾 800 字、soft 规则 | 尽量给 | 不需批准（可降级但留痕） | 衔接生硬 |
| **L3 参考** | 联网搜索结果、久远章节细节 | 按需 | **必须显式授权** | 可能引入噪声、跑偏 |
| **L4 可选** | 写作手法（WritingTechnique） | 可选 | **用户在设置里逐条开启** | 影响风格，不影响正确性 |

> ❗**二次审查修正**：原表 L4 的「谁批准」只有“需”一字且与 S2 强制注入冲突：
> 文风样本既是 L4「可选」又是 system 必需；`visualAnchor` 既是 L4「可选」又是 P1「不裁剪」。
> 现改为：**文风样本归 L0、visualAnchor 归 L1、L4 只留写作手法**。

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

> ❗**命名修正**：本节原用 `L1/L2/L3` 指代计算/判断/生成层，与 §4.14 的信息供给分级 `L0–L4` 撞名
> （`L2` 在信息供给里是“上下文”、在压缩层里是 `C2`）。现统一改为 **Tier 1/2/3**，
> 与 Stage（界面）/ C（压缩）/ L（信息供给）彻底分开。全库只有四个前缀：Stage / C / L / Tier。

```
┌───────────────────────────────────────────┐
│ Tier 3 生成层  写正文 / 生成诗号 / 生成蓝图    │  LLM
│              只有一个，不需要多智能体          │  慢、贵、需创造力
├───────────────────────────────────────────┤
│ Tier 2 判断层  一致性 / 反AI味 / 节奏 / 行为推演 │  ★ JEV
│              大量、并行、需确定性              │  快、便宜、结构化
├───────────────────────────────────────────┤
│ Tier 1 计算层  距离/时间/年龄/战力比较/张力曲线  │  纯函数（core）
│              零成本、零延迟、100% 确定         │  不算 LLM
└───────────────────────────────────────────┘
```

#### JEV 在 inkloom 的具体用法（P2 起）

**接口先行（P1 就把接口定下，不实现）**——P1-17 要求预留 `JudgeProvider`：

```ts
// packages/core/src/judge/types.ts  —— 纯类型，零实现，零依赖
export type JudgePrimitive = 'choice' | 'score' | 'noul'

export interface JudgeRequest {
  primitive: JudgePrimitive
  question: string          // “角色 X 在此情境会怎么做”
  options?: string[]        // choice 必填
  scale?: [number, number]  // score 必填，默认 [1,5]
  context: string           // 判断所依据的情境描述
}

export interface JudgeResult {
  value: string | number | boolean
  confidence: number        // 0–1；★ <0.75 时不得注入 prompt（ADR-29）
  distribution?: Record<string, number>
}

export interface JudgeProvider {
  readonly id: string                      // typesafe-jev | local | mock
  judge(reqs: JudgeRequest[]): Promise<JudgeResult[]>  // 批量并行
}
```

> 实现放 `packages/adapters`，MVP 只提供 `mock` 实现（固定返回 + 单测用）。

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
| **MVP** | 只有 Tier 1 + Tier 3（单次调用） | 0 |
| **P2** | 加 Tier 2：先做“反 AI 味打分”+“一致性检查” | 一个 JEV provider（可接 TypeSafe API 或自部署 Laya） |
| **P3** | 角色级推演：20 个角色各问一次 Choice | 并发调用 |
| **P4** | 多智能体分工：规划者/写作者/审稿者 | 角色分离 |

**关键决策：Tier 2 判断层不进 MVP。** 因为它的前提是“有东西可判断”——得先能生成，才谈得上判断。

### 4.17 JEV 与 LLM 的协作时序（写第 N 章的完整调用链）

> 设计依据：用户追问“JEV 到底做了什么？和主 LLM 怎么分工协作”。

```
[1] 装载上下文                    纯 SQL 查询，无模型
        ↓
[2] ★ JEV 并行判断（一次请求发 N 个问题，~300ms，几厘钱）
    ├─ 每个出场角色：Choice「此情境会怎么做」
    │    林岚 → [强攻, 退让, 观察, 求援] → 观察(0.71)
    ├─ 每条 active 线索：Noul「本章是否该回收」
    │    青铜钥匙 → true(0.83)
    ├─ 每个角色：Noul「是否应引出出场诗」
    └─ 汇总为「行为约束清单」
        ↓
[3] LLM 生成正文（带上述约束）      流式，1 次调用
        ↓
[4] ★ JEV 并行体检（一次请求，~300ms）
    ├─ 逐场景：Score「AI 味」「节奏拖沓度」
    ├─ 逐场景：Noul「与角色状态冲突？」
    └─ 汇总为「体检报告」
        ↓
[5] 人：逐场景确认 / 修改 / 重写
```

**一句话分工：JEV 是“直觉”，LLM 是“文笔”，人是“编辑”。**

> ❗**审查后的重要修正**：
> 1. JEV 的输出默认是**建议**，不是强约束。置信度 < 0.75 时不注入。
> 2. 注入形式必须是“倾向：观察（可被动机/情节推翻）”，而不是“必须观察”。
> 3. JEV 与角色 `motivation` 冲突时，**以设定为准**。
> 4. “不生成字” ≠ “不会写坏”——错误的 Choice 会直接导致情节错误。
> 5. 因此 §4.17 的完整链路**属于 P3/P5**，不在 MVP。

| 职责 | 谁做 | 为什么 |
|---|---|---|
| 算距离/时间/年龄/战力 | **纯函数（L1）** | 100% 确定，零成本 |
| 判断角色会怎么做 | **JEV Choice** | 快、可并发、结果结构化 |
| 判断该不该回收伏笔 | **JEV Noul** | 同上 |
| 判断文笔好坏 | **JEV Score** | 主观但可打分 |
| 写正文 / 写诗号 | **LLM** | 需要创造力 |
| 最终接受还是拒绝 | **人** | 审美判断不可代理 |

**关键边界：JEV 从不生成一个字。** 它只输出选项/分数/是或否，所以它不可能把文本写坏。

### 4.18 借鉴 AI 编程 IDE 的设计（Cursor 3 实测调研）

> 依据：Cursor 3（2026-04）从“文件编辑”转向“智能体优先界面”，并行智能体、任务中心、随时切回 IDE。

| Cursor 3 的设计 | inkloom 的对应 | 价值 |
|---|---|---|
| 智能体优先界面 | **任务中心**（侧边栏统一管生成任务） | 不再“点了等” |
| 并行运行多个智能体 | **并行生成多场景**（⚠️ **实验，默认关闭**，见下方关键借鉴一） | 一章 8 场景可同时跑，但章内因果会丢 |
| 智能体产出成果一目了然 | 场景卡片实时状态 | 知道在干什么 |
| 本地↔云端交接 | **后台任务**（关页面也继续） | 长任务不丢 |
| 差异视图 | 场景级 diff | 已有 |
| 插件应用市场 | **写作 Skill 市场** | 导入别人的手法/文风 |
| 随时切回完整 IDE | **纯编辑模式**（一键全屏、无 AI 干扰） | 写作专注 |
| 命令面板 | `Ctrl+K` 命令面板 | 键盘流 |

#### 关键借鉴一：生成模式的三种选择（已决策：默认整章）

> ❗审查后的重要修正：原设计把“并行场景生成”定为默认，但它在**章内因果上不成立**——
> 8 个场景同时发出时，邻场景正文还不存在，“注入邻场景结尾”**物理上做不到**；
> “场景 3 断臂 → 场景 5 带伤作战”这类因果必然丢失。

| 模式 | 连贯性 | 速度 | 状态 |
|---|---|---|---|
| **`whole`** 整章一次生成 | ✅ 最好 | 慢 | **默认** |
| `serial_chain` 逐场景串行 | ✅ 好 | 中 | 可选 |
| `parallel` 两阶段并行 | ⚠️ 中 | 快 | **实验开关，默认关闭** |

**若启用并行模式，必须同时满足三个前提：**
1. 先落 `ScenePlan[]` 供用户审阅（否则无法判断填充是否合理）
2. 阶段 B 不是纯并行，而是“**并行草稿 + 一次缝合调用**”
3. 场景 N 重写 → N+1..M 的 `ScenePlan.status` 回退为 `planned`（失效传播）

**默认 `whole`——这是用速度换连贯性的取舍，连贯性是本产品的第一价值主张，不能妥协。**

#### 关键借鉴二：任务中心 UI

```
┌─ 生成任务 ─────────────────┐
│ ● 场景 3   生成中… 42%    │
│ ✓ 场景 1   完成（待确认）  │
│ ✓ 场景 2   完成（待确认）  │
│ ○ 场景 4   排队中          │
│ ✗ 场景 5   失败（重试）    │
└──────────────────────────┘
```

#### 关键借鉴三：纯编辑模式

一键（`Ctrl+Shift+E`）切到全屏编辑器：无侧栏、无 AI、无提示。
写得烦了再切回来。这是写作工具最容易被忽略、却最重要的一件事。

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
| 未兑现清单 | 每章生成前自动计算并注入 U3 |
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

| 能力 | 归属 | 说明 |
|---|---|---|
| `get_chapter_context` | **api**（不是 core） | 需查库/读文件，是 IO |
| `assemble_chapter_prompt` | **prompt**（不是 core） | core 禁止依赖 prompt |
| `get_character_state` | core（纯） | 入参为 `revisions[]`，内部计算 |
| `get_unresolved_setups` | core（纯） | 入参为 `threads[]` |
| `get_tension_curve` | core（纯） | 入参为 `blueprints[]` |
| `check_consistency` | core（纯） | 入参为文本 + 上下文对象 |

> ❗审查后的修正：原表把 `loadChapterContext`、`assemble_chapter_prompt` 列为 core 能力，
> 两者分别违反了“core 零 IO”和“core 不依赖 prompt”两条铁律。已按上表重新归属。

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
| **JEV 超时/不可用** | **跳过判断，记 `degradedReason='judge_unavailable'`** | ❌ 不阻塞 |
| **索引与文件不一致** | 标记 dirty，下次读取时 reindex | — |
| **外部修改冲突** | 保留外部版本，候选标 `superseded` | — |

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
| 3 | 回退到上一版 | 正文恢复 + 新增一条 Git commit（正文不进 revision） |
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
| P1 | `prompt` 快照锁定；`generation_run` 存完整 `assembledPrompt`；能生成并切场景；**场景接受后原子写文件 + commit（不写 revision）**；拒绝不落盘；定稿章节可导出 |
| P2 | 局部重写可用；txt/md 导入可用；JEV 判断层可开关 |
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
| 导出脱敏 | 导出 JSON 时剔除密钥字段（本来就不在库里） |

---

## 10. 交付计划

| 阶段 | 内容 | 预估 | 备注 |
|---|---|---|---|
| **P0** | 文件系统 + 索引可重建 + Git 版本 + **22 条 P0 需求** | **5–6 周** | 原估 2–3 周偏乐观（未计 reindex/Git/四种回退/地理/并发/正文契约）|
| **P1** | 单章共创 + 叙事地图 + 关系网络 + 状态提案 | **4–5 周** | 含逐场景确认与 diff |
| **P2** | 体验完善 + JEV 判断层 + 联网搜索 | **3 周** | |
| **P3** | 视觉锚点 | **3 天** | |
| **P4** | 人物形象 + 世界地图 | **1 周** | |
| **P5** | 角色级推演 + 多智能体 | 待定 | 依赖 JEV 稳定性 |

> ❗**审查后的修正**：原 §10 把“确认流程（diff/接受/定稿）”放在 P2，与 REQUIREMENTS 的 P1 定义冲突；
> 且 P0 只有 2–3 周估算，明显低估。上表已与 REQUIREMENTS 对齐。
>
> **工期是估算而非承诺**。实际以每个阶段的 DoD 是否达成为准。

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
| ADR-18 | Tier 2 判断层用 JEV 而非 LLM | 20 角色×4 判断用 LLM 既慢又贵（JEV 几百毫秒、几分钱） | 全部用 LLM 推演 |
| ADR-19 | Tier 2 判断层不进 MVP | 前提是“有东西可判断”，得先能生成 | MVP 就上判断层 |
| ADR-20 | 角色签名必须带 `frequency` 控制 | 每次出场都吟诗会变成尴尬套路 | 只要有签名就每次都注入 |
| ADR-21 | 正文用 Markdown 文件，不用数据库 | 用户可直接看、不被软件绑架、崩溃不丢、Git 友好 | DB 当主存储 |
| ADR-22 | 版本用 Git，不自研 revision | 天然获得 diff/revert/分支/备份；自研成本高且易错 | 自研 revision 表为主 |
| ~~ADR-23~~ | ~~默认并行场景生成~~ **已废弃 → 见 ADR-28** | 审查发现并行下“邻场景正文尚不存在”，章内因果不成立 | 整章一次生成 |
| ADR-24 | 四层渐进式披露 | 新手不被 20 个按钮吓退；高级功能随数据自然出现 | 一次性展示全部功能 |
| ADR-25 | SQLite 降为可重建索引 | 数据主权交还用户；索引丢了不影响创作 | SQLite 作为唯一存储 |
| ADR-26 | 文件是**唯一事实源**，写入必须原子 | 外部编辑不丢、崩溃不丢、可迁移 | DB 为主 + 同步导出 |
| ADR-27 | 正文**不进** revision，只进 Git | 消除两套版本系统；revision 只管结构化要素 | 正文也写 revision |
| ADR-28 | 默认**整章**生成，并行降为实验 | 并行无法保证章内因果（邻场景正文尚不存在）| 并行作为默认 |
| ADR-29 | JEV 输出为**建议**，置信度<0.75 不注入 | 小模型不应替大模型做人物决策 | 硬性强约束 |
| ADR-30 | 四套命名分离：Stage/C/L/Tier | 同一标识符多套含义会导致实现级 bug（实际发现有四套 L） | 统一叫 L |
| ADR-31 | 正文用**场景文件 + 隐藏段标记**（`<!-- seg:ID -->`） | 保住 P0-10 四种回退；文件数可控（≈24 个/章）；标记渲染不可见 | 段级文件（文件爆炸）/ 场景级回退（需求降级）|
| ADR-32 | 定稿文件**只保留场景边界**，不保留段标记 | 定稿是成品，此层回退粒度降为场景级；撤销定稿时重分配段 ID | 段标记一直保留到定稿 |
| ADR-33 | 时间点回退 = Git + JSONL 截断，必须同点 | 只回 Git 会出现“正文回第 7 章、角色状态还第 12 章” | 只回 Git |

---

## 附录 B：参考项目证据索引

| 结论 | 来源 | 具体位置 |
|---|---|---|
| 三级上下文注入（**对方项目叫 L0/L1/L2，与本文 L0–L4 无对应关系**） | Pagekin | `src/services/agent/context-builder.ts` |
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
