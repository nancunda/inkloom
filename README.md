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
- 撤销定稿时按 `<!-- scene:N -->` 反解成场景（段 ID 重新分配、正文文件删除）：内容一字节不丢，但 reindex 不会再把这一章当已定稿

---

## 命令一览

| 命令 | 作用 |
|---|---|
| `inkloom create <dir> --name --genre` | 建书（目录树 + 身份锚 + Git 初始提交） |
| `inkloom import <dir> --from <file.txt\|file.md> [--name --genre]` | 导入已有正文（已是书则追加，否则新建） |
| `inkloom reindex <dir>` | 从文件完全重建索引（索引删了也能救回来） |
| `inkloom element set/rollback/delete/history` | 要素的写入、回退、软删除、历史 |
| `inkloom checkpoint <dir> --label` | 建检查点（Git ref + 要素历史行号） |
| `inkloom rollback <dir> --to <ck-id>` | 时间点回退（**两个事实源同点**） |
| `inkloom export <dir> --format json\|md\|txt` | 导出整书 / 正文 / 纯文本 |

### 生成与审阅

| 命令 | 作用 |
|---|---|
| `inkloom write <dir> --chapter N [--guidance "…"]` | 生成候选场景（DeepSeek，需 `DEEPSEEK_API_KEY`） |
| `inkloom scenes <dir> --chapter N` | 列出本章场景与审阅状态 |
| `inkloom accept <dir> --chapter N --scene M --version V` | 接受某版本（同场景其他版本自动 rejected） |
| `inkloom reject <dir> --chapter N --scene M --version V` | 拒绝（文件保留，可再接受） |
| `inkloom edit <dir> --chapter N --scene M --version V --seg XXXX --text "…"` | 改一段 → 产新版本 |
| `inkloom rewrite <dir> --chapter N --scene M --version V --seg XXXX [--guidance "…"]` | 模型重写这一段（其余段不动） |
| `inkloom diff <dir> --chapter N --scene M --from V1 --to V2` | 字符级 diff |
| `inkloom finalize <dir> --chapter N` | 定稿（还有 candidate 时拒绝，409） |
| `inkloom unfinalize <dir> --chapter N` | 撤销定稿（正文保留） |
| `inkloom propose <dir> --chapter N` | 提取状态变更提案（不落库） |
| `inkloom apply-proposals <dir> --chapter N --accept all\|1,3` | 应用确认的提案 |

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
pnpm verify:p0   # P0 验收：建书 / 索引 / 回退 / 导出，11 条
pnpm verify:p1a  # P1-a 验收：装配 → 生成 → 落盘，6 条
pnpm verify:p1b  # P1-b 验收：确认 / diff / 定稿 / 提案，11 条
pnpm verify:p1c  # P1-c 验收：HTTP 接口 + 启动自愈，18 条
pnpm verify:p2a  # P2-a 验收：局部重写，7 条
pnpm verify:p2c  # P2-c 验收：判断层开关 / 降级 / 只读 / 并行，7 条
pnpm fixture     # 重新生成 fixtures/qixia（玄幻示例书）
pnpm test:cov    # 覆盖率（core 门槛 >80%）
```

| 包 | 职责 | 约束 |
|---|---|---|
| `packages/shared` | 15 个实体 Zod schema + 统一错误类型 | 零内部依赖 |
| `packages/core` | 段标记解析、版本计算、状态推导、回退 | **零 IO**（`check-deps` 强制） |
| `apps/api` | 存储（文件 / 索引 / Git）+ 服务层 + HTTP 路由 | 唯一有副作用的地方 |
| `apps/cli` | 命令行入口 | 复用 api 的服务层 |
| `apps/web` | React 19 写作页 + 叙事地图 | 只读 HTTP，不碰文件 |

---

## 状态

**P0（数据底座）已完成**：105 单元 + 138 集成测试 / core 行覆盖 100% / `pnpm verify:p0` 11-11 通过。

**P1-a（生成链路）已完成**：Prompt 装配（S1–S5 缓存友好 + U9 锚点压尾）+ DeepSeek fetch 适配 + 场景切分降级链 + `inkloom write`。`pnpm verify:p1a` 6-6 通过。

**P1-b（确认与定稿）已完成**：逐场景 accept/reject/edit + 字符级 diff + 定稿（含蓝图摘要）+ 状态提案（逐条确认）。`pnpm verify:p1b` 11-11 通过。

**P1-c（HTTP + 前端）已完成**：Hono 12 个接口 + 错误映射 + 单书启动器；React 19 写作页（章节列表 / 场景卡片 / 版本切换 / diff 面板 / 状态提案）+ 叙事地图（React Flow + dagre）。219 单元 + 238 集成测试 / `pnpm verify:p1c` 18-18 通过。

**P2-a（局部重写）已完成**：指定一段让模型改写，其余段逐字节不变、段 ID 不变；产物作为新版本候选，旧版自动 rejected。四条拒绝落盘的情形（空/过短/过长/带段标记）在写盘前拦下，失败不留半成品。CLI / HTTP / 写作页三个入口，`pnpm verify:p2a` 7-7 通过。

**P2-b（txt/md 导入）已完成**：按「第X章 / Chapter N」切章（中英文数字、markdown 井号都认），章号按出现顺序重排；三种降级都进 warnings（首标题前正文保留为「前言」、无标题整本一章、空章保留）。导入写成定稿章节，`/api/book` 的章节集合改为「Chapter 行 ∪ 蓝图」——否则导入的书在界面上显示为「0 章」。集成测试 5 条 + Chrome 端到端实测（导入 → 界面可见 → 撤销定稿 → 场景反解）。

**P2-c（判断层）已完成**：`JudgeProvider` 接口 + 三种原语（Choice/Score/Noul）+ 两个真实实现（TypeSafe 官方 JEV、硅基流动 OpenAI 兼容）。`POST /api/chapters/:n/check` 只做只读体检（反 AI 味 / 节奏 / 一致性），默认关闭，`INKLOOM_JUDGE=mock|openai|typesafe` 打开。置信度 < 0.75 的结论标为不可注入；判断层挂掉只降级不阻塞。`pnpm verify:p2c` 7-7 通过，实测 5 场景 15 条结论 6 秒。

**P2-d（体验完善）已完成**：
- 生成改「提交任务 + 轮询」：`POST /chapters/:n/generate-async` → `GET /jobs/:id`，不再把浏览器挂在一个 40–90 秒的长连接上（实测真实生成 66 秒完成）
- 关系网络：`GET /api/relations?chapter=N` + 圆环布局 + 时间滑块（盟友变敌人的过程一拖就看出来）
- 联网搜索：`POST /api/search`（Tavily，**按需触发**，只返回标题/链接/摘要，不自动注入正文）

**P3（视觉锚点）已完成**：角色的 `visualAnchor` 已进装配（`外貌锚点（不得偏离）`），并有断言锁定（`user.test.ts` 的「含 visualAnchor（防止写错外貌）」）。

**P4（人物形象）已完成**：`inkloom portrait <dir> --character c1 [--style …]` 从 `visualAnchor` 拼 prompt → 硅基流动生图 → 下载落盘 `assets/characters/<id>.png` → 写 `Asset`（prompt / provider / model / params / visualAnchor 全记，可复现）。

> 实测踩到的坑：只给 `visualAnchor` 时，模型把 17 岁少女画成了成年男性；
> prompt 必须以「性别，年龄」开头，外貌描述再详细也拉不回来。

### 写作界面

```bash
# 终端 1
INKLOOM_BOOK=fixtures/qixia pnpm api     # → http://127.0.0.1:8787（默认只绑本机）
# 终端 2
pnpm web                                 # → http://localhost:5173（/api 代理到 8787）
```

> API 无鉴权，因此默认只绑 `127.0.0.1`（spec §9.9）。要在局域网里用时显式传 `HOST=0.0.0.0`，
> 此时启动日志会警告——同一 WiFi 下任何人都能读写你的书。

界面验收清单（手工，4 条）：

| # | 动作 | 期望 |
|---|---|---|
| 1 | 打开首页 | 左侧 `✓✓✓✓◑`，第四章「已定稿 · 1532 字」 |
| 2 | 点「地图」 | 5 章横向排开、有指向箭头、张力条 2/3/4/5/5，点节点回到该章 |
| 3 | 点「看 diff」 | 只有一个版本时是灰的（title 说明原因）；多版本时出现版本 chips 与增删底色 |
| 4 | 接受场景 | 徽章变绿、定稿按钮从灰变可点；刷新后状态不变 |

> **审阅状态存在 `chapters/ch-NNN/review.json`，不在索引里（Ruling 47）**：
> spec 原先把 accepted/rejected 放在可丢弃的 `DraftSegment`，与「索引可丢弃」直接冲突——
> 实测 `reindex` 后出现「章节已定稿、但 4 个场景显示待确认」的自相矛盾界面。
> 现在 accept/reject/edit 三个动作都会同步落盘，`reindex` 重建索引时从该文件推状态。

### 从候选到定稿（单章闭环）

```bash
pnpm cli write    fixtures/qixia --chapter 4          # 生成候选（3–5 个场景）
pnpm cli scenes   fixtures/qixia --chapter 4          # 看有哪些版本与状态
pnpm cli diff     fixtures/qixia --chapter 4 --scene 1 --from 1 --to 2
pnpm cli accept   fixtures/qixia --chapter 4 --scene 1 --version 2
pnpm cli edit     fixtures/qixia --chapter 4 --scene 1 --version 2 --seg lk7v --text "…"
pnpm cli finalize fixtures/qixia --chapter 4          # 定稿（要求无 candidate）
pnpm cli propose  fixtures/qixia --chapter 4          # 状态提案（不落库）
pnpm cli apply-proposals fixtures/qixia --chapter 4 --accept all
pnpm cli unfinalize fixtures/qixia --chapter 4        # 撤销定稿
```

三条不变量（P1-b 的骨架）：

| 不变量 | 含义 |
|---|---|
| **accepted 互斥** | 同场景同一时刻只能有一个 accepted 版本；接受新版本时旧版自动降为 rejected（Ruling 36） |
| **diff 不参与落库** | `diffChars` 只用于展示；写什么以你接受哪个版本为准（spec §4.7） |
| **状态提案只提案** | LLM 输出 `角色ID\|字段\|新值\|证据`，逐条确认后才写 revision；`stateChapter = N+1`（spec §4.8） |

### 生成一章

```bash
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
pnpm fixture                # 生成七霞示例书
pnpm cli write fixtures/qixia --chapter 4 --guidance "这一章让林岚少说话"
```

生成结果在 `fixtures/qixia/chapters/ch-004/scenes/`，每次生成的**完整 prompt** 存在 `.inkloom/index.sqlite` 的 `GenerationRun` 表里（可复现、可对照）。

### 关于 deepseek-flash（实测结论）

它**是推理模型**：`completion_tokens = reasoning + 正文`，两者共用 `max_tokens` 额度。

| 观测 | 数据 |
|---|---|
| 思考占输出比例 | 60%–84%（实测 1810/3029 与 7719/9194） |
| `max_tokens` 不把思考算进去的后果 | 截断（只剩 3 个场景）或 `EMPTY`（content 为空） |
| 前缀缓存命中率 | 同书同章重生成时 74%–86% |
| 成本结构 | 输入几乎免费（命中 ¥0.04/M），成本全在输出（含思考） |

因此 `max_tokens` 按 `目标字数 × 6` 给（2000 字 → 12000），并且每次生成都记录 `reasoning` token，避免“我只要 2000 字怎么花了 9000 token”的困惑。

### 字数控制为什么停在 75–85%

Prompt 里的约束能到“同一 prompt 三次生成差 5 倍 → 收敛到 ±10%”，但**补不齐最后 15%**：

- 文风要求“短句、少形容词”，模型靠短句自然写不够
- 加压到“每场景 400–520 字”时，思考从 1810 涨到 7719，正文只从 1288 涨到 1532
- **继续加压边际收益为负**，补足要靠“生成后检测不足 → 续写一个场景”（P1-b）

三条踩过的坑（不要在 prompt 里重蹈）：

1. 不能规定“正好 N 个场景”——三条硬约束冲突时模型会撞上限或直接返回空
2. 不能说“内容不够就补细节”——“补”会被理解成拉长句子、堆形容词
3. 必须说“不够就**加一个场景**”——这是唯一与短句文风兼容的解法

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
