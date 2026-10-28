import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { EntityType } from '@inkloom/core'
import {
  blueprintSchema,
  characterRelationSchema,
  characterSchema,
  characterSignatureSchema,
  locationSchema,
  mergePlan,
  type Plan,
  type PlanDef,
  type PlanState,
  planDefSchema,
  powerSystemSchema,
  powerTierSchema,
  routeSchema,
  storyArcSchema,
  worldRuleSchema,
} from '@inkloom/shared'
import { Type } from 'typebox'
import { commitAll } from '../git/runner.js'
import { fetchReadable } from '../search/extract.js'
import { createSearchService } from '../search/service.js'
import type { SearchResult } from '../search/types.js'
import { getContext } from '../services/context.js'
import { readElement, upsertElement } from '../services/element-service.js'
import { generateChapter } from '../services/generate-service.js'
import { getLoreForRun, type LoreView, savePage, saveSearchHits } from '../services/lore-service.js'
import { generatePortrait } from '../services/portrait-service.js'
import { hashContent, readIfExists } from '../storage/atomic-write.js'
import {
  readPlanDef,
  readPlanState,
  setCurrentPlan,
  writePlanDef,
  writePlanState,
} from '../storage/plans.js'
import { writeQueue } from '../storage/queue.js'
import { buildBookSnapshot, renderSnapshot } from './book-snapshot.js'
import type { CriticInput, CriticVerdict } from './critic.js'
import { renderGraphSummary } from './graph-summary.js'
import { createGraphTools } from './graph-tools.js'
import { type AgentGate, deriveGate } from './plan-gate.js'
import { isAgentRoleId } from './roles.js'
import type { SubagentRequest, SubagentResult } from './subagent.js'
import { clip, fail, ok } from './tool-result.js'

export type { AgentGate } from './plan-gate.js'

export interface RunBudget {
  steps: number
  maxSteps: number
  /** 只统计；不再拦截（作者可以连续写多章） */
  chapterCalls: number
  /** 只统计；不再拦截 */
  portraitCalls: number
  /** 子智能体调用次数（delegate + critic），只统计 */
  subagentCalls: number
}

/** run-service 与工具之间的计划桥：工具改状态、run 层知道当前计划 */
export interface PlanBridge {
  getPlanId: () => string | null
  setPlanId: (id: string | null) => void
  notify: (plan: Plan) => void
}

export interface AgentToolDeps {
  apiKey: string
  imageApiKey: string | null
  model: string
  budget: RunBudget
  plan: PlanBridge
  onGate: (gate: AgentGate) => void
  /** 当前 run id：资料卡用它判断「本 run 可读」 */
  getRunId: () => string
  /** 子智能体 runner；run-service 注入。缺省时 delegate 直接失败 */
  subagent?: (req: SubagentRequest) => Promise<SubagentResult>
  /** critic 门禁；只在 INKLOOM_CRITIC=on 时注入 */
  critic?: (input: CriticInput) => Promise<CriticVerdict>
}

interface Parser {
  safeParse: (v: unknown) => {
    success: boolean
    data?: unknown
    error?: { issues: { path: PropertyKey[]; message: string }[] }
  }
}

interface WritableFile {
  schema: Parser
  label: string
  entityType: EntityType
}

/**
 * 力量体系文件比 shared 的 powerSystemSchema 多一个 tiers 数组（UI 与 fixture 都这么存）。
 * ★ 不能直接用 powerSystemSchema：它会「成功解析」但悄悄把 tiers 丢掉——
 *   第一次实测就写出了一个只有 id/name 的空体系。
 * ★ passthrough：agent 多写的 summary/constraints 保留，不静默丢字段。
 */
/** 导出仅为测试：验证 tiers 不会被 Zod 静默剥掉 */
export const powerSystemFileSchema = powerSystemSchema
  .extend({
    tiers: powerTierSchema
      .partial()
      .passthrough()
      .array()
      .default(() => []),
  })
  .passthrough()

/** 允许 agent 直写的人类可编辑文件；其余一律拒绝 */
const WRITABLE: Record<string, WritableFile> = {
  'characters/index.json': {
    schema: characterSchema.passthrough().array(),
    label: '角色',
    entityType: 'character',
  },
  'characters/relations.json': {
    schema: characterRelationSchema.passthrough().array(),
    label: '关系',
    entityType: 'character_relation',
  },
  'characters/signatures.json': {
    schema: characterSignatureSchema.passthrough().array(),
    label: '角色签名',
    entityType: 'character_signature',
  },
  'world/rules.json': {
    schema: worldRuleSchema.passthrough().array(),
    label: '世界规则',
    entityType: 'world_rule',
  },
  'world/power-system.json': {
    schema: powerSystemFileSchema,
    label: '力量体系',
    entityType: 'power_system',
  },
  'world/locations.json': {
    schema: locationSchema.passthrough().array(),
    label: '地点',
    entityType: 'location',
  },
  'world/routes.json': {
    schema: routeSchema.passthrough().array(),
    label: '路线',
    entityType: 'route',
  },
  'story/arcs.json': {
    schema: storyArcSchema.passthrough().array(),
    label: '故事弧',
    entityType: 'story_arc',
  },
}

const ENTITY_TYPES = new Set<EntityType>([
  'character',
  'world_rule',
  'power_system',
  'power_tier',
  'blueprint',
  'plot_thread',
  'style_asset',
  'story_arc',
  'character_relation',
  'character_signature',
  'location',
  'route',
])

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function withProjectId(payload: unknown, projectId: string): unknown {
  if (Array.isArray(payload)) {
    return payload.map((row) =>
      isRec(row) && (row['projectId'] === undefined || row['projectId'] === '')
        ? { ...row, projectId }
        : row,
    )
  }
  if (isRec(payload) && (payload['projectId'] === undefined || payload['projectId'] === '')) {
    return { ...payload, projectId }
  }
  return payload
}

function issuesText(error: NonNullable<ReturnType<Parser['safeParse']>['error']>): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
    .join('；')
}

// ---------------------------------------------------------------------------
// 计划：读写与校验
// ---------------------------------------------------------------------------

interface PlanBundle {
  def: PlanDef
  state: PlanState
  plan: Plan
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 按码点截断：直接 slice 可能切坏代理对（emoji / 扩展 B 区汉字） */
function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  const cp = text.codePointAt(max - 1) ?? 0
  const cut = cp > 0xffff ? max - 1 : max
  return `${text.slice(0, cut)}\n…（已截断）`
}

function emptyState(): PlanState {
  return { status: 'drafting', summary: null, feedback: null, tasks: [], updatedAt: nowIso() }
}

async function loadBundle(deps: AgentToolDeps): Promise<PlanBundle | null> {
  const id = deps.plan.getPlanId()
  if (id === null) return null
  const { root } = getContext()
  const def = await readPlanDef(root, id)
  if (def === null) return null
  const state = (await readPlanState(root, id)) ?? emptyState()
  return { def, state, plan: mergePlan(def, state) }
}

/** 定义与状态一起写；写完整推送 plan.updated */
async function saveBundle(
  deps: AgentToolDeps,
  root: string,
  def: PlanDef,
  state: PlanState,
): Promise<Plan> {
  const merged = mergePlan(def, state)
  await writeQueue.run(async () => {
    await writePlanDef(root, def)
    await writePlanState(root, def.id, state)
  })
  deps.plan.notify(merged)
  return merged
}

/** 定义进 git；提交失败不影响计划本身（下一次写入会一并带上） */
async function tryCommit(root: string, message: string): Promise<string> {
  try {
    await commitAll(root, message)
    return ''
  } catch (e) {
    return `\n（注意：Git 提交失败，改动仍在文件里：${(e as Error).message}）`
  }
}

/** 计划没批准前，不允许写任何设定/正文 */
async function requireApprovedPlan(
  deps: AgentToolDeps,
): Promise<AgentToolResult<Record<string, unknown>> | null> {
  const bundle = await loadBundle(deps)
  if (bundle === null) {
    return fail('还没有计划。先调用 write_plan 提交计划，等作者批准后再写。')
  }
  if (bundle.plan.status !== 'approved' && bundle.plan.status !== 'done') {
    return fail(
      `计划当前是「${bundle.plan.status}」，作者批准前不能写设定/正文。先 request_review(kind="plan") 请作者拍板。`,
    )
  }
  return null
}

function taskStateFromDef(def: PlanDef): PlanState['tasks'] {
  return def.tasks.map((t) => ({
    id: t.id,
    status: 'todo' as const,
    artifacts: [],
    feedback: null,
    summary: null,
    reviewed: false,
  }))
}

function sameDef(a: PlanDef['tasks'][number], b: PlanDef['tasks'][number]): boolean {
  return a.title === b.title && a.skill === b.skill && a.brief === b.brief && a.review === b.review
}

const READ_BOOK = Type.Object({})

const READ_ELEMENT = Type.Object({
  path: Type.String({
    description:
      '相对书根的文件路径，例如 characters/index.json、world/rules.json、story/arcs.json',
  }),
})

const WRITE_ELEMENT = Type.Object({
  path: Type.String({
    description: '要写的文件，必须是已存在的受管文件（如 characters/index.json）',
  }),
  entityType: Type.String({
    description: '实体类型，如 character / world_rule / location / story_arc',
  }),
  entityId: Type.String({ description: '本次改动的实体 id；写数组文件时必须是数组里某一行的 id' }),
  payload: Type.Unknown({ description: '完整的新内容（数组文件必须传整张表，不是单行）' }),
  expectedHash: Type.Optional(
    Type.String({ description: '可选：read_element 返回的 hash，用于防止覆盖别人的并发修改' }),
  ),
  reason: Type.Optional(Type.String({ description: '一句话说明为什么改' })),
})

const WRITE_BLUEPRINT = Type.Object({
  chapterNo: Type.Integer({ minimum: 1 }),
  blueprint: Type.Unknown({ description: '完整蓝图对象，字段见系统提示里的 schema' }),
})

const PLAN_TASK_INPUT = Type.Object({
  id: Type.String({ description: '稳定 id，小写 kebab-case，如 world-setting' }),
  title: Type.String({ description: '任务名，作者在计划里看到的标题' }),
  skill: Type.Union(
    [
      Type.Literal('world'),
      Type.Literal('characters'),
      Type.Literal('story'),
      Type.Literal('chapter'),
      Type.Literal('review'),
      Type.Literal('free'),
    ],
    { description: '取系统提示里「可用技能」的 id' },
  ),
  brief: Type.Optional(Type.String({ description: '具体到什么程度算完成；越具体越不容易跑偏' })),
  review: Type.Optional(
    Type.Union([Type.Literal('required'), Type.Literal('none')], {
      description: 'required=完成后停下等作者审阅；none=直接进入下一个任务',
    }),
  ),
})

const WRITE_PLAN = Type.Object({
  title: Type.String({ description: '计划标题，例如「开篇骨架」' }),
  goal: Type.String({ description: '这份计划要把书推进到什么程度' }),
  tasks: Type.Array(PLAN_TASK_INPUT, { minItems: 1, maxItems: 20 }),
})

const UPDATE_PLAN = Type.Object({
  title: Type.String(),
  goal: Type.String(),
  tasks: Type.Array(PLAN_TASK_INPUT, { minItems: 1, maxItems: 20 }),
})

const UPDATE_TASK = Type.Object({
  taskId: Type.String(),
  status: Type.Union([Type.Literal('doing'), Type.Literal('done'), Type.Literal('blocked')]),
  artifacts: Type.Optional(
    Type.Array(Type.String(), { description: '实际写出的文件相对路径；done 时校验存在' }),
  ),
  note: Type.Optional(Type.String({ description: '一句话说明这个任务的结果/卡点' })),
})

const REQUEST_REVIEW = Type.Object({
  kind: Type.Union([Type.Literal('plan'), Type.Literal('task')], {
    description: 'plan=请作者批准/验收整份计划；task=请作者审阅某个任务',
  }),
  taskId: Type.Optional(Type.String({ description: 'kind=task 时必填' })),
  summary: Type.String({ description: '给作者看的变更摘要：做了什么、为什么、要作者重点看什么' }),
  artifacts: Type.Optional(
    Type.Array(Type.String(), { description: '产物文件路径，供审阅页跳转' }),
  ),
})

const GENERATE_CHAPTER = Type.Object({
  chapterNo: Type.Integer({ minimum: 1 }),
  guidance: Type.Optional(Type.String({ description: '本章额外要求，例如"让林岚少说话"' })),
})

const WEB_SEARCH = Type.Object({
  query: Type.String({ minLength: 1, description: '搜索词，尽量具体' }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: '默认 5' })),
})

const READ_URL = Type.Object({
  url: Type.String({ minLength: 8, description: 'http/https 公网地址' }),
  maxChars: Type.Optional(
    Type.Integer({ minimum: 1000, maximum: 12000, description: '默认 6000' }),
  ),
})

const READ_LORE = Type.Object({
  id: Type.String({ minLength: 4, description: '资料卡 id，形如 lr-a1b2c3d4' }),
})

const DELEGATE = Type.Object({
  // 显式四个 Literal：与 roles.ts 的 AgentRoleId 一一对应，新增角色必须两边一起改
  role: Type.Union([
    Type.Literal('researcher'),
    Type.Literal('worldbuilder'),
    Type.Literal('critic'),
    Type.Literal('stylist'),
  ]),
  task: Type.String({ minLength: 1, maxLength: 500, description: '具体要它做什么，一次一件事' }),
  context: Type.Optional(
    Type.String({ maxLength: 2000, description: '需要它知道的背景；它看不到你的对话历史' }),
  ),
})

const GENERATE_PORTRAIT = Type.Object({
  characterId: Type.String(),
  style: Type.Optional(Type.String({ description: '风格后缀，默认国风插画' })),
})

export function createAgentTools(deps: AgentToolDeps): AgentTool[] {
  const readBook: AgentTool<typeof READ_BOOK> = {
    name: 'read_book',
    label: '读取全书',
    description:
      '一次读取本书的设定全貌：novel.json、角色、关系、签名、世界规则、力量体系、地点、路线、卷、全部蓝图、章节状态；末尾附图谱概况（节点/边/类计数、前 8 类实例数、error 问题、最近 5 条已批准资料卡）。搭世界或写蓝图前先读它。',
    parameters: READ_BOOK,
    execute: async () => {
      const snap = await buildBookSnapshot()
      const summary = await renderGraphSummary()
      return ok(`${renderSnapshot(snap)}\n\n${summary}`, {
        characters: Array.isArray(snap.characters) ? snap.characters.length : 0,
      })
    },
  }

  const readElementTool: AgentTool<typeof READ_ELEMENT> = {
    name: 'read_element',
    label: '读取要素文件',
    description:
      '读取一个要素文件的原始内容和 hash（`chapters/` 下按 Markdown 原文返回，只读）。写之前用它拿 hash；如果只想看全貌，用 read_book 更省。',
    parameters: READ_ELEMENT,
    execute: async (_id, params) => {
      const { root } = getContext()
      const rel = params.path
      if (!/^(characters|world|story|chapters)\//.test(rel) || rel.includes('..')) {
        return fail(`路径不可读：${rel}。只能是 characters/、world/、story/、chapters/ 下的文件`)
      }
      // ★ 章节是 Markdown：返回原文，不做 JSON 化（否则模型看到的是转义后的字符串）
      if (rel.startsWith('chapters/')) {
        let raw: string | null
        try {
          raw = await readIfExists(join(root, rel))
        } catch (e) {
          // 模型经常把目录当文件读（chapters/ch-001 是目录）：给可执行的提示，不抛 EISDIR
          return fail(`读取失败：${rel}（${(e as Error).message}）。目录请给具体文件路径。`)
        }
        if (raw === null) return fail(`文件不存在：${rel}`)
        return ok(truncateText(raw, 30_000), { path: rel, hash: hashContent(raw), format: 'text' })
      }
      const data = await readElement(rel)
      if (data === null) return fail(`文件不存在：${rel}`)
      const raw = (await readIfExists(join(root, rel))) ?? ''
      const text = JSON.stringify({ path: rel, data, hash: hashContent(raw) }, null, 2)
      return ok(text.length > 30_000 ? `${text.slice(0, 30_000)}\n…（已截断）` : text, {
        path: rel,
        hash: hashContent(raw),
      })
    },
  }

  const webSearchTool: AgentTool<typeof WEB_SEARCH> = {
    name: 'web_search',
    label: '联网搜索',
    description:
      '搜索公开网页，返回标题/链接/摘要，并把每条结果落成资料卡（默认未批准）。需要外部考据时用；一次一个问题，不要连续搜同一主题。',
    parameters: WEB_SEARCH,
    execute: async (_id, params) => {
      const ctx = getContext()
      let r: SearchResult
      try {
        r = await createSearchService().search(params.query, params.maxResults ?? 5)
      } catch (e) {
        return fail(`搜索失败：${(e as Error).message}`)
      }
      if (r.hits.length === 0) {
        return fail(
          `没有搜到结果${r.warnings.length > 0 ? `（${r.warnings.join('；')}）` : ''}。可以换个说法，或让作者在设置里配搜索 key。`,
        )
      }
      // ★ 落卡失败不该连搜索结果一起丢：模型还能看摘要，只是 read_lore 拿不到卡
      let saved: { id: string; title: string; url: string; snippet: string }[] = []
      let saveWarning = ''
      try {
        saved = await saveSearchHits(ctx.db, ctx.project.id, deps.getRunId(), params.query, r.hits)
      } catch (e) {
        saveWarning = `\n（落卡失败，本次没有资料卡：${(e as Error).message}）`
      }
      const rows =
        saved.length > 0
          ? saved
          : r.hits.map((h) => ({ id: '', title: h.title, url: h.url, snippet: h.snippet }))
      const lines = rows.map(
        (s, i) =>
          `${i + 1}. ${s.title} — ${s.url} — ${clip(s.snippet)}${s.id === '' ? '' : `（资料卡 ${s.id}）`}`,
      )
      return ok(
        `找到 ${rows.length} 条（provider=${r.provider ?? 'none'}${r.degraded ? '，已降级' : ''}）\n${lines.join('\n')}${saveWarning}`,
        { provider: r.provider, degraded: r.degraded, ids: saved.map((s) => s.id) },
      )
    },
  }

  const readUrlTool: AgentTool<typeof READ_URL> = {
    name: 'read_url',
    label: '读取网页正文',
    description:
      '抓取一个公网网页并提取正文（最长 1.2 万字），落成资料卡后返回摘要。一次只读一个链接。',
    parameters: READ_URL,
    execute: async (_id, params) => {
      if (!/^https?:\/\//i.test(params.url)) {
        return fail(`url 需要以 http:// 或 https:// 开头，收到：${params.url}`)
      }
      try {
        const ctx = getContext()
        const page = await fetchReadable(params.url, {
          ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
        })
        // ★ 落卡失败不该丢掉已经抓到的正文（与 web_search 同一取舍）
        let savedId = ''
        let saveWarning = ''
        try {
          const saved = await savePage(ctx.db, ctx.project.id, deps.getRunId(), page)
          savedId = saved.id
        } catch (e) {
          saveWarning = `\n（落卡失败，本次没有资料卡：${(e as Error).message}）`
        }
        return ok(
          `已读取「${page.title || page.url}」（${page.text.length} 字，extracted=${page.extracted}${savedId === '' ? '' : `，资料卡 ${savedId}`}）\n\n${page.text.slice(0, 2000)}${saveWarning}`,
          // 落卡失败时 id 为 null（与 web_search 的 ids: [] 同义）
          { id: savedId === '' ? null : savedId, url: page.url, extracted: page.extracted },
        )
      } catch (e) {
        return fail(`读取失败：${(e as Error).message}`)
      }
    },
  }

  const readLoreTool: AgentTool<typeof READ_LORE> = {
    name: 'read_lore',
    label: '读取资料卡',
    description: '读取本次会话搜到/抓到的资料卡正文；跨会话的卡必须作者批准过才可读。',
    parameters: READ_LORE,
    execute: async (_id, params) => {
      const ctx = getContext()
      let row: LoreView | null
      try {
        row = await getLoreForRun(ctx.db, params.id, deps.getRunId())
      } catch (e) {
        return fail(`读取资料卡失败：${(e as Error).message}`)
      }
      if (row === null) {
        return fail(`资料卡 ${params.id} 不存在，或未获作者批准（跨会话资料需要先在资料页批准）`)
      }
      const body = row.content ?? row.snippet
      // ★ 搜索卡只有摘要：不说清楚，模型会当成正文写考据
      const note = row.content === null ? '\n\n（仅有摘要；需要正文请对来源 URL 调 read_url）' : ''
      return ok(`${row.title} — ${row.url}\n\n${body.slice(0, 4000)}${note}`, {
        id: row.id,
        provider: row.provider,
      })
    },
  }

  const delegateTool: AgentTool<typeof DELEGATE> = {
    name: 'delegate',
    label: '派子智能体',
    description:
      '把一个只读子任务派给专家子智能体并等它跑完：researcher=联网考据，worldbuilder=审设定与图谱缺口，critic=查一致性，stylist=文风建议。它看不到你的对话历史，也不写文件；需要背景请写进 context。',
    parameters: DELEGATE,
    execute: async (_id, params) => {
      if (deps.subagent === undefined) return fail('这个会话没有启用子智能体')
      // TypeBox 只在真实工具循环里校验；测试/直接调用 execute 会绕过，保留运行期兜底
      if (!isAgentRoleId(params.role)) return fail(`未知角色：${params.role}`)
      const r = await deps.subagent({
        role: params.role,
        task: params.task,
        ...(params.context === undefined ? {} : { context: params.context }),
      })
      if (!r.ok) {
        const partial =
          r.text.length === 0 ? '' : `\n\n已产出的部分结论：\n${r.text.slice(0, 1000)}`
        return fail(
          `[${r.role}] 子任务失败：${r.error ?? '未知原因'}。可以换一种方式，或自己继续。${partial}`,
        )
      }
      const summary =
        r.text.length <= 4000
          ? r.text
          : `${r.text.slice(0, 4000)}…（已截断，共 ${r.text.length} 字符）`
      return ok(
        `[${r.role}] 用了 ${r.steps} 步，${r.tokens.toLocaleString()} tokens。\n摘要：\n${summary}`,
        { role: r.role, ok: r.ok, steps: r.steps, tokens: r.tokens },
      )
    },
  }

  const writeElementTool: AgentTool<typeof WRITE_ELEMENT> = {
    name: 'write_element',
    label: '写入要素文件',
    description:
      '写入一个受管要素文件（角色/关系/签名/规则/力量体系/地点/路线/卷）。数组文件必须传完整数组；entityId 填数组里被改动那一行的 id。写入会走 CAS、revision 与 git commit。',
    parameters: WRITE_ELEMENT,
    execute: async (_id, params) => {
      const blocked = await requireApprovedPlan(deps)
      if (blocked !== null) return blocked
      const ctx = getContext()
      const file = WRITABLE[params.path]
      if (file === undefined) {
        return fail(
          `不能直接写 ${params.path}。可写文件：${Object.keys(WRITABLE).join('、')}；蓝图请用 write_blueprint`,
        )
      }
      if (!ENTITY_TYPES.has(params.entityType as EntityType)) {
        return fail(`不支持的 entityType：${params.entityType}`)
      }
      if (Array.isArray(params.payload)) {
        const found = params.payload.some((row) => isRec(row) && row['id'] === params.entityId)
        if (!found) return fail(`payload 数组里找不到 id=${params.entityId} 的行`)
      }

      const payload = withProjectId(params.payload, ctx.project.id)
      const parsed = file.schema.safeParse(payload)
      if (!parsed.success || parsed.error !== undefined) {
        return fail(
          `${file.label}校验失败：${parsed.error === undefined ? '未知错误' : issuesText(parsed.error)}`,
        )
      }

      let expectedHash = params.expectedHash
      if (expectedHash === undefined) {
        const raw = await readIfExists(join(ctx.root, params.path))
        if (raw !== null) expectedHash = hashContent(raw)
      }

      try {
        const r = await upsertElement({
          entityType: params.entityType as EntityType,
          entityId: params.entityId,
          relPath: params.path,
          payload: parsed.data,
          changeSource: 'ai',
          ...(params.reason === undefined || params.reason.length === 0
            ? {}
            : { changeReason: params.reason }),
          ...(expectedHash === undefined ? {} : { expectedHash }),
        })
        return ok(`已写入 ${params.path} · v${r.version}`, {
          path: params.path,
          version: r.version,
          newHash: r.newHash,
        })
      } catch (e) {
        return fail(`写入失败：${(e as Error).message}`)
      }
    },
  }

  const writeBlueprintTool: AgentTool<typeof WRITE_BLUEPRINT> = {
    name: 'write_blueprint',
    label: '写入章节蓝图',
    description:
      '写入一章的蓝图（story/blueprints/ch-00N.json）。blueprint 必须包含 id、chapterNo、title、goal、conflict、hook、castIds、beatType、tensionLevel。',
    parameters: WRITE_BLUEPRINT,
    execute: async (_id, params) => {
      const blocked = await requireApprovedPlan(deps)
      if (blocked !== null) return blocked
      const ctx = getContext()
      const payload = withProjectId(params.blueprint, ctx.project.id)
      const parsed = blueprintSchema.passthrough().safeParse(payload)
      if (!parsed.success || parsed.error !== undefined) {
        return fail(
          `蓝图校验失败：${parsed.error === undefined ? '未知错误' : issuesText(parsed.error)}`,
        )
      }
      const bp = parsed.data as { id: string; chapterNo: number }
      const rel = `story/blueprints/ch-${String(params.chapterNo).padStart(3, '0')}.json`
      const raw = await readIfExists(join(ctx.root, rel))
      try {
        const r = await upsertElement({
          entityType: 'blueprint',
          entityId: bp.id,
          relPath: rel,
          payload: parsed.data,
          changeSource: 'ai',
          changeReason: `agent 生成第 ${params.chapterNo} 章蓝图`,
          ...(raw === null ? {} : { expectedHash: hashContent(raw) }),
        })
        return ok(`已写入第 ${params.chapterNo} 章蓝图 · v${r.version}`, {
          path: rel,
          version: r.version,
        })
      } catch (e) {
        return fail(`写入蓝图失败：${(e as Error).message}`)
      }
    },
  }

  const writePlanTool: AgentTool<typeof WRITE_PLAN> = {
    name: 'write_plan',
    label: '制定计划',
    description:
      '提交一份计划（4–8 个任务）请作者批准。只能在还没有计划时调用；之后用 update_plan 修订。计划批准前不能写任何设定/正文。',
    parameters: WRITE_PLAN,
    execute: async (_id, params) => {
      if (deps.plan.getPlanId() !== null) {
        return fail('这个会话已经有计划了。用 update_plan 修订，不要重新写一份。')
      }
      const parsed = planDefSchema.safeParse(params)
      if (!parsed.success) {
        return fail(
          `计划校验失败：${parsed.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
            .join('；')}`,
        )
      }
      const ids = new Set(parsed.data.tasks.map((t) => t.id))
      if (ids.size !== parsed.data.tasks.length) return fail('任务 id 不能重复')

      const ctx = getContext()
      const id = `plan-${randomUUID().replace(/-/g, '').slice(0, 10)}`
      const now = nowIso()
      const def: PlanDef = {
        version: 1,
        id,
        title: parsed.data.title,
        goal: parsed.data.goal,
        tasks: parsed.data.tasks,
        createdAt: now,
      }
      const state: PlanState = { ...emptyState(), tasks: taskStateFromDef(def), updatedAt: now }
      await writeQueue.run(async () => {
        await writePlanDef(ctx.root, def)
        await writePlanState(ctx.root, id, state)
        await setCurrentPlan(ctx.root, id)
      })
      deps.plan.setPlanId(id)
      deps.plan.notify(mergePlan(def, state))
      const warning = await tryCommit(ctx.root, `plan: 制定计划《${def.title}》`)
      return ok(
        `${JSON.stringify(
          {
            planId: id,
            tasks: def.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              skill: t.skill,
              review: t.review,
            })),
            next: '调用 request_review(kind="plan", summary=...) 请作者批准；批准前不要写设定/正文。',
          },
          null,
          2,
        )}${warning}`,
        { planId: id },
      )
    },
  }

  const updatePlanTool: AgentTool<typeof UPDATE_PLAN> = {
    name: 'update_plan',
    label: '修订计划',
    description:
      '按作者意见修订计划。已完成的任务不能删；改了要求的任务会重新回到待做。修订后要重新 request_review(kind="plan")。',
    parameters: UPDATE_PLAN,
    execute: async (_id, params) => {
      const bundle = await loadBundle(deps)
      if (bundle === null) return fail('还没有计划。先调用 write_plan。')
      const parsed = planDefSchema.safeParse(params)
      if (!parsed.success) {
        return fail(
          `计划校验失败：${parsed.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
            .join('；')}`,
        )
      }
      const nextIds = new Set(parsed.data.tasks.map((t) => t.id))
      if (nextIds.size !== parsed.data.tasks.length) return fail('任务 id 不能重复')

      const lost = bundle.plan.tasks
        .filter((t) => t.status === 'done' && !nextIds.has(t.id))
        .map((t) => t.id)
      if (lost.length > 0) {
        return fail(
          `不能删掉已完成的任务：${lost.join('、')}。要重做请改它的 title/brief，或把它留在列表里。`,
        )
      }

      const oldDef = new Map(bundle.def.tasks.map((t) => [t.id, t]))
      const oldState = new Map(bundle.state.tasks.map((t) => [t.id, t]))
      const tasks = parsed.data.tasks.map((t) => {
        const s = oldState.get(t.id)
        if (s === undefined) {
          return {
            id: t.id,
            status: 'todo' as const,
            artifacts: [],
            feedback: null,
            summary: null,
            reviewed: false,
          }
        }
        const d = oldDef.get(t.id)
        // 已完成的定义被改了要求 → 回到待做（不能假装旧产物满足新要求）
        if (d !== undefined && !sameDef(d, t) && s.status === 'done') {
          return { ...s, status: 'todo' as const, reviewed: false, summary: null }
        }
        return s
      })

      const ctx = getContext()
      const def: PlanDef = {
        ...bundle.def,
        title: parsed.data.title,
        goal: parsed.data.goal,
        tasks: parsed.data.tasks,
      }
      const state: PlanState = { ...bundle.state, summary: null, tasks, updatedAt: nowIso() }
      const plan = await saveBundle(deps, ctx.root, def, state)
      const warning = await tryCommit(ctx.root, `plan: 修订计划《${def.title}》`)
      return ok(`已修订计划（${plan.tasks.length} 个任务）${warning}`, { planId: plan.id })
    },
  }

  const updateTaskTool: AgentTool<typeof UPDATE_TASK> = {
    name: 'update_task',
    label: '更新任务状态',
    description:
      '开始/完成/卡住一个任务。done 时用 artifacts 报实际产出的文件相对路径（会逐个校验存在）。',
    parameters: UPDATE_TASK,
    execute: async (_id, params) => {
      const bundle = await loadBundle(deps)
      if (bundle === null) return fail('还没有计划。先调用 write_plan。')
      const task = bundle.plan.tasks.find((t) => t.id === params.taskId)
      if (task === undefined) return fail(`计划里没有任务 ${params.taskId}`)

      const ctx = getContext()
      const cur = bundle.state.tasks.find((s) => s.id === task.id) ?? {
        id: task.id,
        status: 'todo' as const,
        artifacts: [],
        feedback: null,
        summary: null,
        reviewed: false,
      }
      const artifacts = params.artifacts ?? cur.artifacts
      if (params.status === 'done') {
        for (const rel of artifacts) {
          if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) {
            return fail(`产物路径不合法：${rel}`)
          }
          if ((await readIfExists(join(ctx.root, rel))) === null) {
            return fail(`产物不存在：${rel}。只填实际写出的文件路径。`)
          }
        }
      }

      let criticNote = ''
      if (params.status === 'done' && deps.critic !== undefined) {
        // ★ 空产物会绕过检查（模型只要不填 artifacts 就能拿到「通过」），所以直接拦下
        if (artifacts.length === 0) {
          return fail(
            'done 时必须用 artifacts 列出实际产出的文件；没有产物不能标记完成（也会绕过一致性检查）。',
          )
        }
        let verdict: CriticVerdict
        try {
          verdict = await deps.critic({
            taskId: task.id,
            title: task.title,
            brief: task.brief,
            artifacts,
            summary: params.note ?? cur.summary,
            goal: bundle.plan.goal,
          })
        } catch (e) {
          // ★ 注入方抛异常也必须按「未完成」放行：不能让任务永久卡在 doing
          verdict = { kind: 'skipped', reason: `检查器出错（${(e as Error).message}）` }
        }
        if (verdict.kind === 'blocked') {
          const lines = verdict.errors.map(
            (c, i) => `${i + 1}. ${c.message}（证据：${c.evidence.join('、')}）`,
          )
          const warns =
            verdict.warnings.length === 0 ? '' : `\n另有 ${verdict.warnings.length} 处提示。`
          return fail(
            `一致性检查发现 ${verdict.errors.length} 处矛盾，任务保持未完成：\n${lines.join('\n')}${warns}\n修好后重新调用 update_task(status="done")。`,
            { taskId: task.id, blocked: true, conflicts: verdict.errors.length },
          )
        }
        if (verdict.kind === 'passed') {
          const sug =
            verdict.suggestions.length === 0
              ? ''
              : `；建议：${verdict.suggestions.slice(0, 3).join('；')}`
          criticNote = `一致性检查通过（${verdict.warnings.length} 处提示${sug}）。`
        } else {
          criticNote = `一致性检查未完成：${verdict.reason}。`
        }
      }

      const next =
        params.status === 'done'
          ? {
              ...cur,
              status: 'done' as const,
              artifacts,
              summary: params.note ?? cur.summary,
              reviewed: task.review === 'none',
            }
          : params.status === 'doing'
            ? { ...cur, status: 'doing' as const, reviewed: false, summary: null }
            : { ...cur, status: 'blocked' as const, summary: params.note ?? cur.summary }
      const state: PlanState = {
        ...bundle.state,
        tasks: [...bundle.state.tasks.filter((s) => s.id !== task.id), next],
        updatedAt: nowIso(),
      }
      await saveBundle(deps, ctx.root, bundle.def, state)

      const hint =
        params.status === 'done'
          ? task.review === 'required'
            ? `接着调用 request_review(kind="task", taskId="${task.id}", summary=...) 并停下。`
            : '这个任务不需要逐项审阅，继续下一个任务。'
          : params.status === 'doing'
            ? '开始做吧。'
            : '任务已标记为卡住；说明卡点后停下等作者。'
      return ok(
        `任务 ${task.id} → ${params.status}${params.note === undefined ? '' : `（${params.note}）`}。${criticNote}${hint}`,
        { taskId: task.id, status: params.status },
      )
    },
  }

  const requestReviewTool: AgentTool<typeof REQUEST_REVIEW> = {
    name: 'request_review',
    label: '请求作者审阅',
    description:
      '计划完成后请作者批准；任务完成后请作者审阅。调用后本轮暂停，等作者通过或打回。必须是该轮唯一的工具调用。',
    parameters: REQUEST_REVIEW,
    execute: async (_id, params) => {
      const ctx = getContext()
      const bundle = await loadBundle(deps)
      if (bundle === null) return fail('还没有计划。先调用 write_plan。')
      const now = nowIso()

      if (params.kind === 'plan') {
        if (bundle.plan.status === 'done') return fail('计划已经验收完成，不需要再请求批准。')
        if (
          bundle.plan.status === 'approved' &&
          !bundle.plan.tasks.every((t) => t.status === 'done')
        ) {
          return fail(
            '计划已经批准、正在执行。任务审阅用 kind="task"；全部任务完成后才能请作者验收整本书。',
          )
        }
        const state: PlanState = {
          ...bundle.state,
          status: 'awaiting_approval',
          summary: params.summary,
          feedback: null,
          updatedAt: now,
        }
        const plan = await saveBundle(deps, ctx.root, bundle.def, state)
        const gate = deriveGate(plan)
        if (gate === null) return fail('计划状态异常：没有生成门禁。')
        deps.onGate(gate)
        const warning = await tryCommit(ctx.root, `plan: 提交计划《${bundle.def.title}》待作者批准`)
        return ok(`已暂停：计划《${plan.title}》等待作者批准${warning}`, { planId: plan.id }, true)
      }

      if (params.taskId === undefined) return fail('kind="task" 时 taskId 必填')
      const task = bundle.plan.tasks.find((t) => t.id === params.taskId)
      if (task === undefined) return fail(`计划里没有任务 ${params.taskId}`)
      if (bundle.plan.status !== 'approved') return fail('计划还没批准，不能请求任务审阅。')
      if (task.status !== 'done') {
        return fail(`任务 ${task.id} 还没完成（当前 ${task.status}），不能请求审阅。`)
      }
      if (task.review !== 'required') return fail('这个任务 review=none，不需要逐项审阅。')
      if (task.reviewed) return fail('这个任务已经通过审阅了。')

      const artifacts = params.artifacts ?? task.artifacts
      const cur = bundle.state.tasks.find((s) => s.id === task.id) ?? {
        id: task.id,
        status: 'done' as const,
        artifacts: task.artifacts,
        feedback: null,
        summary: null,
        reviewed: false,
      }
      const state: PlanState = {
        ...bundle.state,
        tasks: [
          ...bundle.state.tasks.filter((s) => s.id !== task.id),
          { ...cur, summary: params.summary, artifacts },
        ],
        updatedAt: now,
      }
      const plan = await saveBundle(deps, ctx.root, bundle.def, state)
      const gate = deriveGate(plan)
      if (gate === null) return fail('任务状态异常：没有生成门禁。')
      deps.onGate(gate)
      return ok(`已暂停：任务 ${task.id}「${task.title}」等待作者审阅`, { taskId: task.id }, true)
    },
  }

  const generateChapterTool: AgentTool<typeof GENERATE_CHAPTER> = {
    name: 'generate_chapter',
    label: '生成章节候选稿',
    description:
      '按已写好的蓝图生成一章候选稿（会真实调用模型，耗时 1–3 分钟，可能截断）。一次会话可连续生成多章；生成结果落盘为候选场景，等作者在写作页接受/拒绝。',
    parameters: GENERATE_CHAPTER,
    execute: async (_id, params) => {
      const blocked = await requireApprovedPlan(deps)
      if (blocked !== null) return blocked
      deps.budget.chapterCalls += 1
      try {
        const r = await generateChapter({
          chapterNo: params.chapterNo,
          apiKey: deps.apiKey,
          model: deps.model,
          ...(params.guidance === undefined ? {} : { userGuidance: params.guidance }),
        })
        return ok(
          JSON.stringify(
            {
              runId: r.runId,
              chapterNo: r.chapterNo,
              scenes: r.scenes.map((s) => ({
                sceneNo: s.sceneNo,
                version: s.version,
                words: s.wordCount,
              })),
              warnings: r.warnings,
            },
            null,
            2,
          ),
          { runId: r.runId, chapterNo: r.chapterNo },
        )
      } catch (e) {
        return fail(`章节生成失败：${(e as Error).message}`)
      }
    },
  }

  const generatePortraitTool: AgentTool<typeof GENERATE_PORTRAIT> = {
    name: 'generate_portrait',
    label: '生成角色形象图',
    description:
      '为角色生成一张形象图（真实调用硅基流动，约 10–30 秒）。一次会话可连续生成多张；角色需要有 visualAnchor 或 appearance。',
    parameters: GENERATE_PORTRAIT,
    execute: async (_id, params) => {
      const blocked = await requireApprovedPlan(deps)
      if (blocked !== null) return blocked
      if (deps.imageApiKey === null) {
        return fail('未配置 SILICONFLOW_API_KEY，无法生成形象图。请作者在设置页填写')
      }
      deps.budget.portraitCalls += 1
      try {
        const r = await generatePortrait({
          characterId: params.characterId,
          apiKey: deps.imageApiKey,
          ...(params.style === undefined ? {} : { style: params.style }),
        })
        return ok(`已生成「${r.name}」形象图：${r.filePath}`, { filePath: r.filePath })
      } catch (e) {
        return fail(`生图失败：${(e as Error).message}`)
      }
    },
  }

  return [
    readBook,
    readElementTool,
    webSearchTool,
    readUrlTool,
    readLoreTool,
    delegateTool,
    ...createGraphTools(),
    writeElementTool,
    writeBlueprintTool,
    writePlanTool,
    updatePlanTool,
    updateTaskTool,
    requestReviewTool,
    generateChapterTool,
    generatePortraitTool,
  ]
}
