# inkloom

**单用户、本地优先的长篇小说创作工作台。**

AI 起草，人确认。要素结构化，过程可回退。

> 反目标：**不做**"一键生成整本小说"的批量流水线。
> 平台不提升 AI 的文笔天花板；它提供的是**可靠性**（跨章不崩）、**可控性**（每步可审可退）、**可视化**（结构看得见）。

---

## 四条设计铁律

| 铁律 | 含义 | 强制手段 |
|---|---|---|
| **文件是唯一事实源** | 一本书 = 一个文件夹，正文是 `.md`。删掉软件，稿子还在 | `pnpm check-deps` + 单一事实源契约（见 `docs/.../design.md` §2.6） |
| **`core` 零 IO** | `packages/core` 不碰文件/网络/数据库，全是纯函数 | `scripts/check-deps.mjs` 扫描 import，违规 CI 直接红 |
| **要素 append-only** | 永不 UPDATE，只追加版本。回退 = 产生新版本 | JSONL 历史 + `version` 单调（由单一写队列保证） |
| **正文不进 revision** | 正文历史只归 Git，两套版本系统会互相打架 | `EntityRevision` 的类型里没有 `draft_segment` |

---

## 快速开始

```bash
pnpm install

# 建一本书
pnpm cli create ./my-novel --name 七霞 --genre 玄幻

# 写一个角色（append-only，每次写入产生新版本）
pnpm cli element set ./my-novel --type character --id c1 \
  --rel characters/c1.json \
  --json '{"id":"c1","name":"林岚","role":"protagonist"}'

# 看看它的历史
pnpm cli element history ./my-novel --type character --id c1

# 回退到第 1 版（产生 v3，历史不改）
pnpm cli element rollback ./my-novel --type character --id c1 \
  --rel characters/c1.json --to 1

# 建检查点（Git + 要素历史同点快照）
pnpm cli checkpoint ./my-novel --label "第 1 章定稿"

# 导出整本书
pnpm cli export ./my-novel --format json --out ./backup.json
```

---

## 一本书长什么样

```
my-novel/
├── novel.json                 项目元数据 + 创意锚点
├── world/                     力量体系 / 世界规则 / 地点 / 路线
├── characters/                角色卡 / 关系 / 签名（出场诗、口头禅）
├── story/                     卷 / 章节蓝图 / 剧情线索 / 写作手法
├── chapters/
│   ├── ch-001.md              ← 定稿正文（用户可直接打开）
│   └── ch-001/scenes/         ← 候选稿（含段标记，供单段回退）
│       ├── s1.v1.md
│       └── s1.v2.md
├── styles/                    文风资产（禁用词 / 量化上限）
├── assets/                    人物形象 / 参考资料
└── .inkloom/                  内部数据（用户不需要看）
    ├── project-id             ★ 身份锚：路径变了也不会认错书
    ├── index.sqlite           ✅ 可删，`inkloom reindex` 可完全重建
    ├── revisions/*.jsonl      ❌ 要素的真实历史（append-only）
    └── checkpoints.jsonl      时间点快照（Git ref + JSONL 行号）
```

### 正文里的两个标记

```markdown
<!-- scene:1 v:3 -->      候选稿的场景头（场景号 + 版本）
<!-- seg:a3f7 -->         段 ID：4 位 base36，全书唯一且永不复用
林岚踏上山道，风从袖口灌进来。
```

- **候选稿保留段标记** → 支持单段回退（精确定位到某一段）
- **定稿只保留场景边界** → 成品干净可读
- 撤销定稿时按 `<!-- scene:N -->` 反解，段 ID 重新分配（正文一字节不丢）

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `inkloom create <dir> --name --genre` | 建书（目录树 + 身份锚 + Git 初始提交） |
| `inkloom reindex <dir>` | 从文件完全重建索引（索引删了也能救回来） |
| `inkloom element set/rollback/delete/history` | 要素的写入、回退、软删除、历史 |
| `inkloom checkpoint <dir> --label` | 建检查点（Git ref + 要素历史行号） |
| `inkloom rollback <dir> --to <ck-id>` | 时间点回退（**两个事实源同点**） |
| `inkloom export <dir> --format json\|md\|txt` | 导出整书 / 正文 / 纯文本 |

---

## 四种回退（P0-10）

| 粒度 | 载体 | 命令 |
|---|---|---|
| 单段 | 段标记 `<!-- seg:XXXX -->` + 历史版本文件 | `rollbackSegment` |
| 单场景 | 场景文件 `sX.vY.md`（永不覆盖旧版本） | `saveScene` 写新版本 |
| 要素 | `revisions/*.jsonl` | `inkloom element rollback --to N` |
| 时间点 | Git ref + JSONL 行号（必须同点） | `inkloom rollback --to <ck>` |

> **为什么时间点回退必须同时动两个源**：只回 Git 会出现"正文回到第 7 章、角色状态还在第 12 章"。

---

## 开发

```bash
pnpm verify      # biome + tsc + check-deps + 单元测试 + 集成测试
pnpm verify:p0   # P0 验收：11 条 DoD 逐条跑
pnpm fixture     # 重新生成 fixtures/qixia（玄幻示例书）
pnpm test:cov    # 覆盖率（core 门槛 >80%）
```

| 包 | 职责 | 约束 |
|---|---|---|
| `packages/shared` | 15 个实体 Zod schema + 统一错误类型 | 零内部依赖 |
| `packages/core` | 段标记解析、版本计算、状态推导、回退 | **零 IO**（`check-deps` 强制） |
| `apps/api` | 存储（文件 / 索引 / Git）+ 服务层 | 唯一有副作用的地方 |
| `apps/cli` | 命令行入口 | 复用 api 的服务层 |

---

## 状态

**P0（数据底座）已完成**：105 单元 + 138 集成测试 / core 行覆盖 100% / `pnpm verify:p0` 11-11 通过。

**P1-a（生成链路）已完成**：Prompt 装配（S1–S5 缓存友好 + U9 锚点压尾）+ DeepSeek fetch 适配 + 场景切分降级链 + `inkloom write`。`pnpm verify:p1a` 6-6 通过。

P1-b 计划：逐场景 accept/reject + 字符级 diff + 定稿与状态提案。
P1-c 计划：写作页 + 场景卡片 + 叙事地图（React Flow）。

### 生成一章

```bash
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
pnpm fixture                # 生成七霞示例书
pnpm cli write fixtures/qixia --chapter 4 --guidance "这一章让林岚少说话"
```

生成结果在 `fixtures/qixia/chapters/ch-004/scenes/`，每次生成的**完整 prompt** 存在 `.inkloom/index.sqlite` 的 `GenerationRun` 表里（可复现、可对照）。

### Prompt 的段序（为什么这么排）

```
system（跨章不变，才能命中前缀缓存）
  S1 身份职责  S2 文风契约  S3 反AI规则  S4 hard规则  S5 输出格式

user（每章变化）
  U1 场地设定（角色/关系/地点/路程/soft规则）
  U2 全书进度（只到本章，不泄露后续）
  U3 未兑现清单  U4 近3章摘要  U5 上章结尾800字
  U6 本章蓝图  U7 后续2章（禁止提前写）  U8 作者指导
  U9 ★锚点：不可偏离的作者事实（必须最后）
```

- **S1–S5 跨章完全一致** → 命中 DeepSeek 缓存（¥0.04/M vs ¥2/M，50 倍）
- **U9 压尾** → 与 S1 首尾夹击，对抗 lost-in-the-middle

完整设计见 [`docs/superpowers/specs/2026-10-25-inkloom-design.md`](docs/superpowers/specs/2026-10-25-inkloom-design.md)，需求基线见 [`REQUIREMENTS.md`](REQUIREMENTS.md)。

---

## License

MIT
