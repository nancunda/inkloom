# 书库多书管理 + 共创 Plan 驱动：方案（待审）

日期：2026-10-26
状态：**方案 v2（已按子智能体审查修订），待用户确认，不实施**

## 0.0 审查结论与修订摘要

子智能体结论：**需修正后可行**。方向正确（库根 + 一级目录 = 书、阶段降级为 plan 任务、门禁绑定 taskId、不改 12 个 service 签名、切书整页重载），但原稿有两处不成立，已在本版修订：

| 级别 | 审查发现 | 本版修订 |
|---|---|---|
| P0 | run/job 没有归属书；切书后旧 run 可被续聊并写进新书 | `AgentRun/Job` 记 root+projectId，所有入口校验；切书清空内存 run/job；前端清 localStorage |
| P0 | 门禁是工具副产物，不是 plan 状态的投影；删掉 draft 特判后会出现新的「走不下去」 | `deriveGate(plan)` 单一真相；drive 结束时对账；plan/task 状态在服务端落盘 |
| P0 | plan/task 缺中止终态，预算耗尽/停止/失败/重启会把任务钉在 doing | 增加 `plan.status=aborted`、`task.status=blocked`；统一收尾；UI 提供「继续执行」 |
| P0 | 空库首启在现有挂载链上不可达（App 用 useBook 当关卡） | App.tsx 改用 useLibrary 当唯一关卡；空库渲染书库页 |
| P1 | 切书非原子、未排空写队列（Windows EBUSY） | 先开新后关旧；单飞 mutex；整个切换放进 writeQueue；保留 count→setContext→reindex 顺序 |
| P1 | 「268+299 不得回归」与删除 draft 特判矛盾 | 改为「用例总数不减少 + 指定 N 个用例按新语义重写」 |
| P1 | `pnpm verify` 不含 apps/web，前端类型错了也全绿 | verify 增加 `tsc -p apps/web --noEmit` |
| P1 | 40 步预算装不下 plan（每任务 2 步），续聊不重置 | `maxSteps = 40 + 2×任务数`；续聊重置步数配额，章节/图不重置 |
| P1 | `update_plan` 整体替换会丢 done | 只允许 append + skip；done 不可改 |
| P1 | job 表跨书污染 | 切书 `clearJobs()` |
| P1 | 中文书名 slug 变空 | 允许中文目录名，只过滤 Windows 非法字符/保留名 |

---

## 0. 三个问题的诊断

### P1 书是写死的，不能用文件夹管理多本书
现状：`server.ts` 启动时必须给 `INKLOOM_BOOK`，`setContext` 在进程级只设一次；前端没有书库/切换入口，顶部书名是只读文本。
结论：后端与前端都缺「书库」这一层。书仍是「一个文件夹 = 一本书」，缺的是**库**。

### P2 共创是固定四阶段，不是 plan 驱动
现状：`prompt.ts` 写死「世界 → 人物 → 故事 → 开篇」，门禁 `stage` 是这四个枚举；工具只有 `request_review(stage)`。
用户要的是 AI 编程工具那种「规划 → 任务清单 → 自主执行 → 到点停下」。
结论：把「阶段」换成**计划（plan）+ 任务（task）**，阶段只是默认模板，不是代码里的枚举。

### P3 「开篇」当成第四阶段是错的，门禁卡在开篇没法继续
现状：
- UI 左栏把「开篇」列成第 4 阶段，与「世界/人物/故事」并列——但开篇是**产物**（第 1 章正文），不是阶段。
- `reviewAgentRun` 里对 `gate.stage === 'draft' && approve` 直接 `done`（上一轮为修「重复 draft 门禁」加的硬编码）。
- 于是通过开篇 = 整轮结束，打回 = 重做第一章，用户感觉「一直在开篇，怎么都走不下去」。

结论：
- 开篇改为任务「第 1 章：七斤四两」；
- 门禁改为「计划批准 / 任务审阅」两种，通过任务 → 下一任务，最后一项通过 → 自然结束；
- 删除 draft 特判。

---

## 1. 方案 A：书库（Library）

### 1.1 概念
- **书库根**：一个普通文件夹，里面每个一级子目录是一本书。
- **当前书**：进程内同一时刻只打开一本（沿用单 context，不改 12 个 service 的签名）。
- **切换书**：关掉旧索引连接 → 打开新索引 → `setContext`；不重启进程。

### 1.2 配置
| 变量 | 含义 | 默认 |
|---|---|---|
| `INKLOOM_LIBRARY` | 书库根目录 | `~/inkloom`（便携版：exe 同目录 `books/`） |
| `INKLOOM_BOOK` | 可选：启动直接打开某本（开发/兼容） | 空 |
| 上次打开的书 | 存 OS 状态目录（`~/.inkloom/state.json`），不写进书库、不污染书库 git | 自动 |

启动顺序：`INKLOOM_BOOK` 优先；否则打开上次的书（目录仍在才打开）；否则空态（前端显示书库页）。

### 1.3 后端
新增 `apps/api/src/library/`：

- `library.ts`
  - `resolveLibraryRoot()`：环境变量 → 默认目录（`mkdir -p`）。
  - `listBooks(root)`：`readdir` 一级目录；含 `.inkloom/project-id` + `novel.json` 的才算书；返回 `{ folder, name, genre, totalChapters, updatedAt }`（updatedAt = `chapters/` 下最新 mtime，其次 novel.json）。
  - `createBook(root, input)`：**允许中文目录名**；只过滤 Windows 非法字符 `< > : " / \\ | ? *`、控制字符、保留名（CON/PRN/AUX/NUL/COM1…）与结尾的 `.`/空格，长度 ≤ 60；冲突加 `-2`、`-3`。调用现有 `createProject`。
  - `openBook(root, folder)`：`folder` 必须是**单段目录名**（拒绝 `/`、`\\`、`..`）；拼出路径后用 `realpath` 解析，结果必须仍在 `realpath(root)` 内（防 junction/symlink 逃逸；Windows 按大小写不敏感比较）。
- `context.ts` 增加：
  - `closeContext()`：`db.$disconnect()` + `current = null`；返回旧 context 供调用方处理。
  - `peekContext()`：不抛错的只读访问器（`/api/library` 与空态判断用）。
  - 修正 `getContext()` 的提示语：`POST /api/library/open`（现在写的是一个不存在的 `/api/books/open`）。
- 从 `server.ts` 抽出 `openBookAt(root)`，**顺序是硬约束**（现有注释已说明原因）：
  1. `openProject`
  2. `openBookIndexDb`
  3. **在 `setContext` 之前** `db.project.count()`（`setContext` 会 upsert Project 行）
  4. `setContext`
  5. 若第 3 步为 0 → `reindex`
  6. `ensureBookGitignore`；非 repo → `initRepo` + 首次提交
  补一条集成测试：切到一本删掉 `index.sqlite` 的书，断言章节被重建。
- **切书是原子且串行的**（审查 P1）：
  ```ts
export function switchBook(root: string, folder: string): Promise<void> {
  switching = switching.then(() => writeQueue.run(async () => {
    const next = await openBookAt(join(root, folder))  // 1. 先开新
    const prev = closeContext()                        // 2. 成功后才关旧
    await prev?.db.$disconnect()
    setContext(next)                                   // 3. 最后切指针
    clearRuns(); clearJobs()                           // 4. 清跨书内存
    await rememberLastBook(next.root)
  }))
  return switching
}
  ```
  - 单飞 mutex：并发 `POST /api/library/open` 不会产生两个 Prisma client。
  - 整个切换放进 `writeQueue`：排空在飞的 `upsertElement` / 定稿 / 回退，避免 `$disconnect` 后 Prisma 惰性重连旧库（Windows EBUSY）。
  - **先开新、后关旧**：`openProject` 校验失败时旧书仍可用。
- `run-service` 增加 `clearRuns()`：把 `done/stopped/failed` 的 run 全部移除；`running/waiting_review` 的 run 仍然存在时切书 **409**（提示先停止）。因为 `sendAgentMessage` 能把 done run 重新激活，绝不能把它留在内存里跨书。
- `job-service` 增加 `clearJobs()`；切书时一并清掉。

路由 `apps/api/src/routes/library.ts`：
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/library` | `{ libraryRoot, current, books[] }`（用 `peekContext`，空态不报错） |
| POST | `/api/library/open` | `{ folder }`；有 running/waiting_review 的 Agent 或 running 生成任务时 **409 拒绝** |
| POST | `/api/library/create` | `{ name, genre, totalChapters?, wordsPerChapter? }`，建完自动打开 |
| POST | `/api/library/close` | 关闭当前书（回到书库页） |

### 1.4 前端
- **挂载链改造（审查 P0）**：`App.tsx` 现在用 `useBook()` 当唯一关卡，空库会走进「连不上 API」页，书库页永远不可达。改为：
  ```tsx
  const lib = useLibrary()                 // 新增，唯一关卡
  if (lib.isLoading) return <Loading />
  if (lib.error) return <ConnectionError />
  if (lib.data.current === null) return <LibraryPage />
  return <AppShell />
  ```
  `AppShell` 的 `useOverview()` 加 `enabled: bookLoaded`，避免空库 404。
- 顶部书名改为按钮「潮骨 · 切换」→ `LibraryDialog`：书列表（名称/类型/章数/最近修改/打开）、新建书表单、书库路径。
- 未打开书时：渲染独立 `LibraryPage`（列表 + 新建 + 「把已有书文件夹放进书库即可」的提示）。
- 切书成功后：`localStorage.removeItem('inkloom.agent.runId')` → `window.location.reload()`。不能只靠重载：localStorage 里的 runId 会指向上一本书的 run。
- 切书前 `confirm`：「切换会结束当前共创会话（文件与计划已落盘）」。

### 1.5 兼容与范围
- 现有 `INKLOOM_BOOK=fixtures/qixia pnpm api` 行为不变；`pnpm cli create` 不变。
- 已有书进库的方式：把书文件夹移进书库根（UI 提示）；第一版不提供任意路径打开（安全）。
- 本轮**不做**重命名 / 归档（REQUIREMENTS P0-1 有，但用户本轮未提；列为后续）。

### 1.6 测试
- 单测：`listBooks` 识别/忽略非书目录；folder 校验（`..`、绝对路径、`a/b`、symlink 逃逸拒绝）；中文书名建目录。
- 集成：临时库建两本书 → 打开 A → 切 B → `getContext().root` 变化、A 的 db 断开；并发两次 open 只产生一个 client；切到删了 `index.sqlite` 的书能重建；有 running run 时切换 409。
- HTTP：`GET/POST /api/library*`；空库时 `GET /api/library` 200 且 `current=null`。

---

## 2. 方案 B：共创 Plan 驱动 + Skill

### 2.1 核心变化
| 现在 | 改后 |
|---|---|
| prompt 写死四阶段 | Agent 先产出一份 plan 文件，用户批准后执行 |
| `request_review(stage)` | `request_review(kind='plan' \| 'task', ...)` |
| 门禁枚举 world/cast/arcs/draft | 计划批准 + 任务审阅（任务由 plan 定义） |
| 「开篇」是第 4 阶段 | 「第 1 章」是 plan 里的一个任务 |
| draft approve 硬编码 done | 最后一项任务完成 → 自然 done |

### 2.2 计划文件（定义进 git，状态不进）
**定义**：`story/plans/<planId>.json`（进 git，作者可看、可回退）——只存任务定义，不含运行时状态，写一次不再改。
**状态**：`.inkloom/agent/plans/<planId>.state.json`（被书 `.gitignore` 忽略）——每次变更原子写，避免「每任务 2–3 次 commit」的提交风暴。
API 返回与 UI 展示的是两者合并后的 `Plan`。

`planId` 服务端生成：`plan_<yyyymmdd>_<4位随机>`；`label` 由 Agent 给（如「潮骨·开篇」），只用于显示。
`plan.runId` 记录由哪个 run 创建；「当前 plan」= 最近一个未 `done`/`aborted` 的 plan，指针存 `.inkloom/agent/current-plan`。

Schema（放 `packages/shared/src/plan.ts`，Zod）：
```ts
planTask = {
  id: string,            // t1…
  title: string,         // 「第 1 章：七斤四两」
  skill: z.enum([...]).optional(),   // 写错即校验失败，不静默
  status: 'todo' | 'doing' | 'done' | 'skipped' | 'blocked',
  review: 'none' | 'required',
  artifacts: string[],   // 产物路径（相对书根）
  note?: string,
}
plan = {
  id, projectId, runId?, label, goal,
  status: 'drafting' | 'awaiting_approval' | 'executing' | 'done' | 'aborted',
  abortedReason?: string,
  createdAt, updatedAt,
  tasks: planTask[],
}
```

### 2.3 工具
| 工具 | 作用 |
|---|---|
| `write_plan({ label, tasks })` | 规划阶段唯一写操作；写定义文件 + 状态文件；emit `plan.updated`；随后 `request_review(kind='plan')` |
| `update_plan({ append?, skip? })` | **只允许追加新任务（新 id）与把任务标 skipped**；已 `done` 不可改、不可删。emit `plan.updated` |
| `update_task({ taskId, status, artifacts?, note? })` | 标记 doing/done/blocked；**返回该任务 skill 的完整 guidance**；done 前校验 `artifacts` 至少一项且文件存在 |
| `request_review({ kind, taskId?, summary, artifacts })` | 计划批准或任务审阅；设置 gate，本轮停下 |
| 其余 7 个工具 | 不变 |

约束：
- 规划阶段（plan 未批准）只能读 + `write_plan` + `request_review`；写文件工具返回「先批准计划」。
- `request_review` 必须是该轮唯一调用；执行前校验：`kind='plan'` 要求 plan 存在且 `awaiting_approval`；`kind='task'` 要求 taskId 属于该 plan 且 `doing`，否则返回 `isError`，不设 gate。
- 所有 plan 写操作走 `writeQueue` + `atomicWrite`（与要素写入同一条单写队列）。
- **预算动态**：`maxSteps = 40 + 2 × tasks.length`；`sendAgentMessage` 续聊时把 `budget.steps` 归零（章节/图计数不重置）。否则 plan 的 2N 步会把配额吃光。
- plan 起草限制在 3 步内；本轮只排 1 章正文 + 1 张图。

### 2.4 提示词（重写 `prompt.ts`）
```
# 工作方式
1. read_book 看现状。
2. 写一份 plan：3–8 个任务，每个任务标 skill、产物、是否需要审阅。
   - 新书默认模板：世界 → 人物 → 故事蓝图 → 第 1 章；但按书的现状调整，
     已有内容就跳过或改成「校验」任务。
   - 本轮预算只够 1 章正文 + 1 张图，任务里不要排第 2 章正文。
3. request_review(kind='plan')，停下等作者批准。
4. 批准后按 tasks 顺序执行；每项 update_task(doing) → 干活 → update_task(done)。
5. review='required' 的任务完成后 request_review(kind='task')。
6. 全部任务完成，给作者一段总结，本轮结束。
```
禁止：跳过 plan 直接写；未经批准生成正文/图片；自己把任务标 done 却没产物。

### 2.5 Skill 注册表
`packages/prompt/src/skills.ts`：
```ts
export interface WritingSkill {
  id: string
  title: string
  guidance: string        // 目标 + 必填字段 + 质量清单（单一来源）
  artifacts: string[]     // 预期产物
export const WRITING_SKILLS: WritingSkill[] = [worldbuilding, character-cast, ...]
export function skillGuidance(id: string): string | null
```
- **guidance 单一来源**：把现 `prompt.ts` 的阶段细则（规则/角色/蓝图/生章/生图的具体要求）搬进 skills.ts；`prompt.ts` 只保留工作方式与纪律，避免两处漂移。
- 系统提示只列 skill 的 id + 一句话；完整 guidance 分两处注入：
  1. 批准后的 `approvePrompt` 直接附上当前任务的 guidance 全文（不依赖 agent 是否调 `update_task`）；
  2. `update_task(doing)` 的返回值再强化一次。
- 第一版静态注册表；不做第三方/动态加载。

### 2.6 门禁语义（plan 状态的投影，不是工具副产物）
`AgentGate` 改为：
```ts
{ kind: 'plan' | 'task', planId, taskId?, title, summary, artifacts }
```
**唯一真相是 plan 状态；门禁由投影函数推导**（审查 P0）：
```ts
function deriveGate(plan: Plan | null): AgentGate | null {
  if (plan === null) return null
  if (plan.status === 'awaiting_approval') return { kind: 'plan', planId: plan.id, ... }
  const t = plan.tasks.find((x) => x.status === 'done' && x.review === 'required')
  return t === undefined ? null : { kind: 'task', planId: plan.id, taskId: t.id, ... }
}
```
- `drive()` 结束时统一对账：`gate = deriveGate(plan)`；非空 → `waiting_review` + emit；为空但还有 `todo` → **`failed`（附原因）**，不允许静默 `done`。
- 批准 plan：`plan.status='executing'`，继续。
- 批准 task：该 task `done`；有 todo → 继续；全部结束 → run `done`。
- 打回 plan：`plan.status='drafting'`，Agent 重写。
- 打回 task：task 保持 `doing`，Agent 按意见重做。
- **`sendAgentMessage` 在 waiting_review 时**：先落 plan/task 状态（plan → drafting；task → doing），再 emit `gate.resolved`，再 `drive`。不能只清 `run.gate`。
- **中止终态**：`stopAgentRun`、步数耗尽、`drive` 抛错、服务重启恢复时统一调 `finalizePlanOnRunEnd(reason)`：当前 `doing` → `blocked`，plan → `aborted`，emit `plan.updated`。

### 2.7 UI
- 左栏：
  - 顶部「计划」卡：label + 状态（规划中 / 待批准 / 执行中 / 完成 / 已中断）。
  - 任务清单：状态点（todo/doing/done/skipped/blocked）、标题、skill 小标签、产物按钮。
  - 「现在」：等你批准计划 / 正在做「第 1 章」 / 等你审阅「第 1 章」 / 已中断（带「继续执行」）。
  - 未出 plan 时显示「正在规划…」。
- 时间线：`plan.updated` 渲染成计划卡（任务清单）；计划审阅卡带「批准计划 / 提修改意见」。
- **中断恢复**：`aborted` plan 提供「继续执行」→ 开新 run，把 plan 定义与剩余任务注入 prompt；「重新规划」→ 新 run 从规划开始。否则重启即卡死。
- 删除 `STAGES` 常量与四阶段进度条；预算与对话区不变。

### 2.8 状态与事件
新增事件：
```ts
{ type: 'plan.updated', plan: Plan }
```
`gate.waiting` / `gate.resolved` 的 gate 结构改为上面的 kind/task 形态。
前端 reduce 更新计划卡与任务状态。

---

## 3. 方案 C：门禁卡「走不下去」的具体修复
| 现象 | 根因 | 修复 |
|---|---|---|
| 通过开篇后整轮结束 | `draft + approve → done` 硬编码 | 删除特判；由 `deriveGate(plan)` 判断是否还有任务 |
| 打回开篇只能重做第一章 | 门禁绑定阶段而非任务 | 门禁绑定 taskId；打回只重做该任务 |
| 感觉「一直在开篇」 | 开篇被当成第 4 阶段 | 开篇改为任务「第 1 章」；完成后进入下一条任务 |
| 想继续做下一章没有办法 | run 结束后只能靠对话追加 | 保留「结束后继续对话」；Agent 可用 `update_plan` 追加任务并执行；续聊重置步数配额 |
| 删除特判后可能「没人设门禁」 | 门禁是工具副产物 | `drive()` 结束时用 `deriveGate` 对账；有未完成任务却没门禁 → `failed` 并说明 |

---

## 4. 实施顺序与文件
0. **先做跨书归属与切换原子性**（审查建议提前）：`AgentRun/Job` 记 root+projectId、入口校验、`clearRuns/clearJobs`、`switchBook` 单飞 + writeQueue、`peekContext`。
1. **书库后端**：`library/library.ts`、`routes/library.ts`、`context.closeContext/peekContext`、`server.openBookAt`（顺序硬约束）、`startServer({ libraryRoot, bookDir? })`（`libraryRoot` 必须可选，否则 `verify-p1c.ts` 的 3 处调用与 tsc 一起挂）。
2. **书库前端**：`App.tsx` 关卡改造、`LibraryPage.tsx`、`LibraryDialog.tsx`、`AppShell` 顶栏与 `useOverview enabled`、library hooks。
3. **Plan 基础**：`shared/plan.ts`、`prompt/skills.ts`（guidance 单一来源）、`storage/plans.ts`（定义/状态双文件，走 writeQueue+atomicWrite）。
4. **Agent 工具与运行服务**：`write_plan/update_plan/update_task`、gate 改 `deriveGate`、`reviewAgentRun` 按任务推进、`finalizePlanOnRunEnd`、动态预算、`plan.updated` 事件。
5. **共创 UI**：左栏计划卡、时间线计划卡、门禁文案、中断恢复、删除 STAGES。
6. **测试与验收**：单测（library、plan 状态机、skills、预算）+ 集成（切书、索引重建、plan 文件、门禁推进、跨书隔离）+ 真实 UI（切书演示、新书 plan→批准→任务→完成）+ 截图。
7. **验证门禁**：`pnpm verify` 增加 `tsc -p apps/web --noEmit`（当前 references 不含 web，前端类型错了也全绿）。
8. **提交推送**：分两个 commit（library / plan），token 方式推送。

## 5. 验收标准
- 同一进程内 A 书 ↔ B 书切换，页面数据全换、无旧书残留；有 running/waiting_review 的 Agent 时切换 409；done/stopped 的 run 在切书时被清除，无法被续聊写进新书。
- 新建中文名书自动打开，目录 / `novel.json` / git 初始提交齐全；`..`、绝对路径、`a/b`、symlink 逃逸均被拒绝。
- 切到删了 `index.sqlite` 的书，索引能从文件重建；并发两次 open 只产生一个 client。
- 新书共创：先出 plan（3–8 任务）→ 批准 → 逐任务执行；每个 `review=required` 任务停下；全部完成后 done。
- 「开篇」在 UI 中是一个任务（「第 1 章」），不再是第 4 阶段。
- plan 定义在 `story/plans/` 且进 git；状态在 `.inkloom/agent/plans/` 不进 git；任务清单随执行实时更新。
- 停止 / 预算耗尽 → plan 显示「已中断」，任务为 blocked，可「继续执行」或「重新规划」。
- 测试基线：**用例总数不减少**；`run-service.test.ts` 中 6 个旧语义用例按新语义重写（draft 通过/打回/非 draft 通过/结束后续聊/非等待态拒绝 review/打回必填意见），另补 plan 投影、无门禁失败、中止终态、`update_plan` 不覆盖 done、动态预算 5 组。

## 6. 风险与取舍
| 风险 | 影响 | 应对 |
|---|---|---|
| 切书时内存 run/job 跨书 | 写进错书（P0） | 切书前 409；切书时 `clearRuns/clearJobs`；前端清 localStorage；run 入口校验 root |
| 门禁与 plan 不同步 | 新的「走不下去」（P0） | `deriveGate` 单一投影；drive 结束对账；状态先落盘再 emit |
| 切书并发 / 写队列未排空 | EBUSY、两个 Prisma client | 单飞 mutex + `writeQueue.run` + 先开新后关旧 |
| 每轮都先规划，多一次往返 | 慢 10–30s | 规划限定 3–8 任务、最多 3 步；已有内容的书允许短 plan |
| plan 任务多，预算不够 | 中途中断 | `maxSteps = 40 + 2×tasks`；续聊重置步数；提示词限制本轮 1 章 |
| plan 状态频繁落盘 | git 提交风暴 | 定义进 git 写一次；状态进 `.inkloom`（已忽略） |
| 前端不参与 verify | 白屏也全绿 | verify 加 `tsc -p apps/web --noEmit` |
| 旧四阶段 prompt 被替换 | 已验证流程回归 | 用例按新语义重写；真实 UI 走一遍新书全流程 |

## 7. 已确认决策（2026-10-26）
1. **开篇 = 任务，不是阶段**：默认模板「世界 → 人物 → 故事 → 第 1 章」，第 1 章排在设定之后；后续章节同样以任务追加。
2. **书库默认位置**：`~/inkloom`（`INKLOOM_LIBRARY` 可覆盖；便携版可指向 exe 同目录 `books/`）。
3. **plan 存储**：定义进 git（`story/plans/<id>.json`）；运行状态不进（`.inkloom/agent/plans/<id>.state.json`，已被书 `.gitignore` 忽略）。
4. 默认模板保留（是建议，不是硬编码）；门禁带「跳过任务」（未单独询问，按推荐执行）。

> 状态：已实施（2026-10-26）。验收证据见 `docs/screenshots/accept-library.png`、`accept-plan-gate.png`、`accept-task-gate.png`、`accept-plan-aborted.png`；测试基线 294 单测 + 304 集成。
