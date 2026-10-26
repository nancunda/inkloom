import { join } from 'node:path'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { EntityType } from '@inkloom/core'
import {
  blueprintSchema,
  characterRelationSchema,
  characterSchema,
  characterSignatureSchema,
  locationSchema,
  powerSystemSchema,
  powerTierSchema,
  routeSchema,
  storyArcSchema,
  worldRuleSchema,
} from '@inkloom/shared'
import { Type } from 'typebox'
import { getContext } from '../services/context.js'
import { readElement, upsertElement } from '../services/element-service.js'
import { generateChapter } from '../services/generate-service.js'
import { generatePortrait } from '../services/portrait-service.js'
import { hashContent, readIfExists } from '../storage/atomic-write.js'
import { buildBookSnapshot, renderSnapshot } from './book-snapshot.js'

export type ReviewStage = 'world' | 'cast' | 'arcs' | 'draft'

export interface AgentGate {
  stage: ReviewStage
  summary: string
  /** 产物路径，供审阅页跳转 */
  artifacts: string[]
}

export interface RunBudget {
  steps: number
  maxSteps: number
  chapterCalls: number
  maxChapters: number
  portraitCalls: number
  maxPortraits: number
}

export interface AgentToolDeps {
  apiKey: string
  imageApiKey: string | null
  model: string
  budget: RunBudget
  onGate: (gate: AgentGate) => void
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

function ok(
  text: string,
  details: Record<string, unknown> = {},
  terminate = false,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }],
    details,
    ...(terminate ? { terminate: true } : {}),
  }
}

function fail(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details, isError: true }
}

function issuesText(error: NonNullable<ReturnType<Parser['safeParse']>['error']>): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.map(String).join('.')} ${i.message}`)
    .join('；')
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

const REQUEST_REVIEW = Type.Object({
  stage: Type.Union([
    Type.Literal('world'),
    Type.Literal('cast'),
    Type.Literal('arcs'),
    Type.Literal('draft'),
  ]),
  summary: Type.String({ description: '给作者看的变更摘要：做了什么、为什么、要作者重点看什么' }),
  artifacts: Type.Array(Type.String(), { description: '产物文件路径，供审阅页跳转' }),
})

const GENERATE_CHAPTER = Type.Object({
  chapterNo: Type.Integer({ minimum: 1 }),
  guidance: Type.Optional(Type.String({ description: '本章额外要求，例如"让林岚少说话"' })),
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
      '一次读取本书的设定全貌：novel.json、角色、关系、签名、世界规则、力量体系、地点、路线、卷、全部蓝图、章节状态。搭世界或写蓝图前先读它。',
    parameters: READ_BOOK,
    execute: async () => {
      const snap = await buildBookSnapshot()
      return ok(renderSnapshot(snap), {
        characters: Array.isArray(snap.characters) ? snap.characters.length : 0,
      })
    },
  }

  const readElementTool: AgentTool<typeof READ_ELEMENT> = {
    name: 'read_element',
    label: '读取要素文件',
    description:
      '读取一个要素文件的原始内容和 hash。写之前用它拿 hash；如果只想看全貌，用 read_book 更省。',
    parameters: READ_ELEMENT,
    execute: async (_id, params) => {
      const { root } = getContext()
      const rel = params.path
      if (!/^(characters|world|story)\//.test(rel) || rel.includes('..')) {
        return fail(`路径不可读：${rel}。只能是 characters/、world/、story/ 下的文件`)
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

  const writeElementTool: AgentTool<typeof WRITE_ELEMENT> = {
    name: 'write_element',
    label: '写入要素文件',
    description:
      '写入一个受管要素文件（角色/关系/签名/规则/力量体系/地点/路线/卷）。数组文件必须传完整数组；entityId 填数组里被改动那一行的 id。写入会走 CAS、revision 与 git commit。',
    parameters: WRITE_ELEMENT,
    execute: async (_id, params) => {
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

  const requestReviewTool: AgentTool<typeof REQUEST_REVIEW> = {
    name: 'request_review',
    label: '请求作者审阅',
    description:
      '在一个阶段完成后调用，暂停整个循环等待作者通过或打回。必须带阶段、摘要与产物路径；不要在没有完成阶段时调用。',
    parameters: REQUEST_REVIEW,
    execute: async (_id, params) => {
      deps.onGate({ stage: params.stage, summary: params.summary, artifacts: params.artifacts })
      return ok(`已暂停：${params.stage} 阶段等待作者审阅`, { stage: params.stage }, true)
    },
  }

  const generateChapterTool: AgentTool<typeof GENERATE_CHAPTER> = {
    name: 'generate_chapter',
    label: '生成章节候选稿',
    description:
      '按已写好的蓝图生成一章候选稿（会真实调用模型，耗时 1–3 分钟，可能截断）。每次 run 只允许 1 章；生成结果落盘为候选场景，等作者在写作页接受/拒绝。',
    parameters: GENERATE_CHAPTER,
    execute: async (_id, params) => {
      if (deps.budget.chapterCalls >= deps.budget.maxChapters) {
        return fail(`本次 run 的章节生成预算已用完（${deps.budget.maxChapters} 章）`)
      }
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
      '为角色生成一张形象图（真实调用硅基流动，约 10–30 秒）。每次 run 只允许 1 张；角色需要有 visualAnchor 或 appearance。',
    parameters: GENERATE_PORTRAIT,
    execute: async (_id, params) => {
      if (deps.imageApiKey === null) {
        return fail('未配置 SILICONFLOW_API_KEY，无法生成形象图。请作者在设置页填写')
      }
      if (deps.budget.portraitCalls >= deps.budget.maxPortraits) {
        return fail(`本次 run 的生图预算已用完（${deps.budget.maxPortraits} 张）`)
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
    writeElementTool,
    writeBlueprintTool,
    requestReviewTool,
    generateChapterTool,
    generatePortraitTool,
  ]
}
