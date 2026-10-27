# 世界推演沙盘：公开证据与可借用架构

- 核实日期：2026-10-27
- 方法：公开论文 / 官方文档 / 开源仓库；标注「有据」与「推断」
- 用途：给下一份「推演沙盘」spec 提供输入；本文件不实现

## 0. 一句话

沙盘不是「让 AI 演一遍」，而是「在不可变事件日志上开一个可验证的假设分支」：AI 写可能性，代码守世界，作者决定哪颗成为正史。

## 1. 世界状态与事件：日志是唯一真源，快照只是缓存

| 结论 | 证据 | 对 inkloom 的含义 |
|---|---|---|
| 正史 = 一条 append-only 事件日志；`state@t = fold(events ≤ t, rulesVersion)` 是纯函数 | Fowler 2005 事件溯源（有据）；Azure Event Sourcing 文档（有据） | `story/events.jsonl` 已符合；需要补 `replay()` 与 `stateHash` |
| 快照是优化不是替代，事件流仍可重建 | Azure 文档（有据） | 每章/每 N 条事件写 `snapshots/chapter-XX.json`（`lastEventId/stateHash/rulesVersion`） |
| 双时钟：话语顺序 vs 故事时间 | 推断 | `timeOrder` 建索引 + `inWorldTime` 对齐；分支对比按故事时间 |
| LLM 结果也是事件，重放不重调模型 | Temporal Event History + 确定性重放（有据） | 候选/评分/拒绝理由/采纳都进日志；`provenance` 记 model/promptHash/seed |
| 历史要有压缩边界 | Temporal 51,200 事件上限 + Continue-As-New（有据） | 每章/每卷一个边界，避免无限日志 |
| 时间图可惰性物化多视图 | Raphtory（有据） | 可借「同一日志多视图」，不必引入图数据库 |

**失败模式**：重放变慢；快照与 `rulesVersion` 不一致；事件 schema 升级缺 upcaster；追溯插入/删除事件让后续全部失效；日志没有 projection 只能全扫。

## 2. 推演循环：提案—校验—采纳三拍

1. **选 fork 点**：`forkEventId + stateHash + 问题`；沙盒只读 canon。
2. **组上下文包**：fork 快照；人物卡（目标/恐惧/关系/本章状态）；角色知识边界；地点与准入；规则与版本；最近 K 条事件 + 未回收伏笔。按实体/地点检索，不塞全量。
3. **提案**：LLM 产出结构化候选，不是散文。字段建议：`type/participants/locationId/inWorldTime/intent/preconditions/effects/causes/ruleRefs/evidenceRefs/uncertainty`。
4. **硬校验**：schema、ID 存在、时间单调、地点共在、规则谓词、生死/资源/身份、与 canon 冲突；返回 `violations[]`（ruleId + 输入 + 期望）。
5. **软校验**：LLM critic 只评动机可信/语气/OOC/戏剧性，必须引用人物卡字段或事件 id；**不给硬冲突裁决权**。
6. **作者采纳**：看事实 diff + 因果链 + 违反项；采纳 = 追加并写 `adoptedFrom`。

**防编造**：封闭世界（本体外实体只能走「世界扩展提案」）；强制引用（实体/规则/事件 id，引用不存在即幻觉）；effects 用 typed delta（`assert/retract + 值`）；角色只能引用知识边界内事实；散文由 render 层从已采纳事件生成。

**证据**：WorldLines 的 PDVA（Plan–Diff–Validate–Apply）与「narrator renders, world agent keeps the books」（有据，预印本）；LLM-Modulo 的「生成与验证分离」（有据）；StoryVerse 的 Act Director 实例化（有据）；Generative Agents 的 memory stream + 检索（有据）。

**失败模式**：校验器只查形式 → 「合法但荒谬」；规则过严 → 无候选；候选同质 → 审阅疲劳；单事件合法但整体弧线崩；采纳后使用后续事件前提失效 → 需级联失效提示。

## 3. 多智能体：权威只能有一个，智能体只提供视角

| 系统 | 权威状态 | 谁提议 | 谁裁决 | 可借用 | 已知失败 |
|---|---|---|---|---|---|
| Generative Agents（UIST'23, arXiv:2304.03442，有据） | 沙盒环境 + 各 agent 的 memory stream | agent 的 plan/action | 环境解析执行 | memory stream、reflection、recency/importance/relevance 检索 | 幻觉与 memory hacking；成本高；评估时间尺度短 |
| StoryVerse（arXiv:2405.13042，有据） | 游戏 world state | Act Director + Character Simulator | 执行环境更新 world state | abstract acts 作作者意图软约束 | 长程连贯性差；延迟；无量化评估；控制难 |
| Multi-Agent Character Simulation（ACL 2025.in2writing-1.9，有据） | narrative plan | 角色 agents 按时间 role-play | rewrite 步对齐 plan | 「先演后修」只用于散文草稿 | 无独立世界状态；rewrite 可能把矛盾「修顺」 |
| WorldLines / Ludic Dynamics（预印本，**编号待核实**） | 单一 world agent（single writer），canonical JSON entity tree | soul agents（私有知识）提议 | world agent 校验后提交 | 单写者、PDVA、private knowledge、pub/sub | 研究原型；人类研究未完成；流畅散文会掩盖状态漂移 |

**可借用排序**：① 单写者 + 结构化提案；② 作者意图的「抽象幕」；③ 角色私有知识 + 记忆检索；④ 先演后修只用于散文。

**不要做**：25 个自治 agent 自由对话。单机小说工具的瓶颈不是角色数量，而是「状态不可信 + 作者不可控」。

## 4. 一致性与因果：硬规则用代码，软判断用 LLM，作者终裁

- 硬约束（schema/引用/时间/地点/资源/生死/身份/知识边界/规则谓词）用确定性代码；软约束交 LLM 只读评审；作者唯一 commit。
- `json-rules-engine`（有据）：JSON 规则、all/any 递归、无 eval；适合「扁平事实 + 明确阈值」；不负责状态变更、回滚、跨实体量词。
- 自研纯函数更适合本体图：`apply(state, event) -> {state, violations, trace}`，可单测、可重放、可解释；规则输出含 `ruleId + 输入事实 + verdict`。
- `causes/effects` 不够：只能答「谁导致谁」，不能答「为什么允许/为什么必然/角色为什么这么做」。
- 建议补字段：`requires`（前置断言）、`invalidates`（负效果）、`intent`、`ruleTrace`、`evidence`、`confidence`；effects 用 typed delta。
- 解释 = 支持图回溯（事件 ← 前置 ← 规则 ← 初始状态），不是让 LLM 事后编故事。
- 成熟可解释方案：IPOCL 的 causal link + intention（有据）；事件演算的 `initiates/terminates`（有据）；W3C PROV-O 的 `wasGeneratedBy/used/wasDerivedFrom`（有据）。
- story sifting：按模式从日志匹配「背叛/救赎/伏笔回收」事件子序列（有据，Felt/ICIDS 2019）。

**失败模式**：规则表达力不足 → 外挂 LLM → 不可解释、不可复现；LLM 事后合理化；多因过定/循环因果；只有正效果 → 死人复活；规则版本变更让旧 `ruleTrace` 失效。

## 5. 分支世界线：fork 点 + 差异集，不要复制正史

- 正史一条 `events.jsonl`，单写者，append-only。
- 分支：`{branchId, forkEventId, forkStateHash, rulesVersion, events[]}`，只存 fork 之后的差异；前缀引用 fork 点。
- **不要「事件子集」**：子集丢失前缀状态与顺序，重放会得到不同的世界。
- 对比不 diff 散文，diff 事实：两边各自 fold 到同一 `inWorldTime`/章节点，比较事实 `added/removed/changed`、人物状态、未回收伏笔、触发规则。
- 采纳 = rebase：逐条追加到 canon head、重排 `timeOrder`、校验前置、写 `adoptedFrom/supersedes`。
- 冲突只有三类：前置不成立、同一事实被改成不同值、时间顺序矛盾；默认拒绝。
- 避免冲突：canon 单写者、`expectedStateHash` 乐观并发、一次只采纳一个分支、整批提交、采纳前全量 `replay+validate`。
- 失败模式：分支爆炸（每章 ≤3 个活跃沙盒）；fork 点按 `timeOrder` 选却按 `inWorldTime` 比 → 因果错位；采纳后 canon 后续前提失效；两边 `rulesVersion` 不同；沙盒混入正文。

证据：Dolt 分支/合并（有据）；Raphtory 多视图（有据）；Azure 乐观并发 + 事件 id 去重（有据）；WhatELSE 的 pivot/outline/variants 三视图（有据，CHI 2025）。

## 6. 对 inkloom 的推荐（按优先级）

1. **先把正史做成「唯一真源 + 纯函数 fold + 章节快照」**：`events.jsonl` 只追加；`replay(events, rulesVersion)` 产出 `state` 与 `stateHash`；每章落快照；LLM 输出写入 `provenance`，绝不重算。
2. **沙盘 = overlay 分支 + 采纳时 rebase 校验**：`.inkloom/sandbox/<branch>.jsonl` 只存差异事件；UI 只给事实 diff + 因果链；正文是 canon 的只读投影并带 `canonHash`。
3. **候选事件协议化 + 两层校验 + 单写者**：定义 `CandidateEvent` schema；硬规则用纯函数，软规则用只读 LLM critic，作者唯一 commit；v1 最多 1 个世界 agent + 2–3 个角色提案器。

## 7. 与当前 spec 的衔接

- 切片 2 的 `query_graph` / `find_path` 是沙盘的查询底座（fork 点、因果链、分支 diff 都要用）。
- 切片 3 的 `critic` 角色可直接复用为「推演一致性检查」，但沙盘的硬校验必须另写纯函数，不能只靠 LLM。
- 事件字段扩展（`requires/invalidates/intent/ruleTrace/evidence/confidence`）属于下一份 spec 的数据模型变更，不在本轮做。

## 附：待核实

- WorldLines / Ludic Dynamics 的 arXiv 编号与同行评审状态。
- Generative Agents 的成本数字与评估时间尺度，引用时需回原文核对。
