import { z } from 'zod'

// ---------------------------------------------------------------------------
// 基础片段
// ---------------------------------------------------------------------------

const id = z.string().min(1)
const isoDate = z.string().datetime()

// ---------------------------------------------------------------------------
// 书籍与锚点
// ---------------------------------------------------------------------------

export const projectSchema = z.object({
  id,
  folderId: id,
  rootPath: z.string().min(1),
  name: z.string().min(1),
  genre: z.string().min(1),
  subGenre: z.string().optional(),
  targetAudience: z.string().optional(),
  totalChapters: z.number().int().positive().optional(),
  wordsPerChapter: z.number().int().positive().optional(),
  narrativePov: z.string().optional(),

  // 锚点层：anchorLocked 后 AI 无权修改
  coreIdea: z.string().optional(),
  premise: z.string().optional(),
  theme: z.string().optional(),
  toneContract: z.string().optional(),
  anchorLocked: z.boolean().default(false),

  status: z.enum(['draft', 'completed', 'archived']).default('draft'),
  createdAt: isoDate,
  archivedAt: isoDate.optional(),
})
export type Project = z.infer<typeof projectSchema>

export const anchorFields = ['coreIdea', 'premise', 'theme', 'toneContract'] as const
export type AnchorField = (typeof anchorFields)[number]

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

export const characterSchema = z.object({
  id,
  projectId: id,
  name: z.string().min(1),
  role: z.enum(['protagonist', 'antagonist', 'supporting', 'minor']),

  // 静态设定（跨章不变）
  gender: z.string().optional(),
  age: z.string().optional(),
  appearance: z.string().optional(),
  personality: z.string().optional(),
  background: z.string().optional(),
  abilities: z.string().optional(),
  motivation: z.string().optional(),
  relationships: z.string().optional(),
  arc: z.string().optional(),
  notes: z.string().optional(),

  // 动态状态（按章演进）
  curLocation: z.string().optional(),
  curTierId: z.string().optional(),
  curPhysical: z.string().optional(),
  curMental: z.string().optional(),
  curItems: z.string().optional(),
  curEvents: z.string().optional(),
  stateChapter: z.number().int().positive().optional(),

  /** 字段级溯源：{ "curTierId": { "chapter": 12, "runId": "run_x" }, ... } */
  stateProvenance: z.string().optional(),

  /** 人工改正文后标脏，提示用户确认，不自动同步 */
  stateStale: z.boolean().default(false),
  stateStaleSince: z.number().int().positive().optional(),

  /** 视觉锚点：从参考图提取的外貌特征，注入正文生成防 OOC */
  visualAnchor: z.string().optional(),

  deletedAt: isoDate.optional(),
})
export type Character = z.infer<typeof characterSchema>

export const characterRelationSchema = z.object({
  id,
  projectId: id,
  fromId: id,
  toId: id,
  kind: z.enum(['master', 'disciple', 'kin', 'ally', 'enemy', 'rival', 'lover']),
  strength: z.number().int().min(1).max(5).default(3),
  sinceChapter: z.number().int().positive().optional(),
  untilChapter: z.number().int().positive().optional(),
  note: z.string().optional(),
})
export type CharacterRelation = z.infer<typeof characterRelationSchema>

export const characterSignatureSchema = z.object({
  id,
  projectId: id,
  characterId: id,
  kind: z.enum([
    'entrance_poem',
    'catchphrase',
    'gesture',
    'epithet',
    'theme_song',
    'costume',
    'habit',
  ]),
  content: z.string().min(1),
  /**
   * 频率控制（ADR-20）：不控制的话每次出场都吟诗会变成尴尬的套路。
   * once = 仅首次正式出场；key_moment = 生死关头；every_scene = 口头禅。
   */
  frequency: z.enum(['once', 'key_moment', 'every_scene']).default('key_moment'),
  firstUsedChapter: z.number().int().positive().optional(),
  note: z.string().optional(),
})
export type CharacterSignature = z.infer<typeof characterSignatureSchema>

// ---------------------------------------------------------------------------
// 世界
// ---------------------------------------------------------------------------

export const worldRuleSchema = z.object({
  id,
  projectId: id,
  category: z.enum(['power', 'faction', 'geography', 'item', 'taboo']),
  name: z.string().min(1),
  content: z.string().min(1),
  /** hard = 违背即 OOC；soft = 建议 */
  priority: z.enum(['hard', 'soft']),
  deletedAt: isoDate.optional(),
})
export type WorldRule = z.infer<typeof worldRuleSchema>

export const powerSystemSchema = z.object({
  id,
  projectId: id,
  name: z.string().min(1),
  description: z.string().optional(),
})
export type PowerSystem = z.infer<typeof powerSystemSchema>

export const powerTierSchema = z.object({
  id,
  systemId: id,
  name: z.string().min(1),
  /** 整数可比 —— 硬校验（越级挑战告警）的基础 */
  level: z.number().int(),
  description: z.string().optional(),
  breakthrough: z.string().optional(),
})
export type PowerTier = z.infer<typeof powerTierSchema>

export const locationSchema = z.object({
  id,
  projectId: id,
  name: z.string().min(1),
  type: z.enum(['city', 'mountain', 'sect', 'secret_realm', 'ruin', 'plain']),
  region: z.string().optional(),
  description: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  deletedAt: isoDate.optional(),
})
export type Location = z.infer<typeof locationSchema>

export const routeSchema = z.object({
  id,
  projectId: id,
  fromId: id,
  toId: id,
  mode: z.enum(['walk', 'ride', 'fly', 'teleport', 'boat', 'caravan']),
  /** 系统算，AI 不得改（P0-13 / ADR-16） */
  days: z.number().positive(),
  note: z.string().optional(),
})
export type Route = z.infer<typeof routeSchema>

export const loreReferenceSchema = z.object({
  id,
  projectId: id,
  query: z.string().min(1),
  title: z.string().optional(),
  url: z.string().url().optional(),
  snippet: z.string().optional(),
  fetchedAt: isoDate,
  /** L3 级别：必须显式授权才进 prompt */
  approved: z.boolean().default(false),
})
export type LoreReference = z.infer<typeof loreReferenceSchema>

// ---------------------------------------------------------------------------
// 结构层
// ---------------------------------------------------------------------------

export const beatTypeSchema = z.enum(['setup', 'rising', 'climax', 'twist', 'resolution'])
export type BeatType = z.infer<typeof beatTypeSchema>

export const blueprintSchema = z.object({
  id,
  projectId: id,
  chapterNo: z.number().int().positive(),
  title: z.string().optional(),
  goal: z.string().min(1),
  conflict: z.string().min(1),
  turn: z.string().optional(),
  hook: z.string().min(1),
  castIds: z.array(id).default([]),
  locationId: z.string().optional(),
  storyDay: z.number().int().nonnegative().optional(),
  beatType: beatTypeSchema.default('rising'),
  /** 1..5，叙事地图的纵轴 */
  tensionLevel: z.number().int().min(1).max(5).default(3),
  userGuidance: z.string().optional(),
  deletedAt: isoDate.optional(),
})
export type Blueprint = z.infer<typeof blueprintSchema>

export const plotThreadSchema = z.object({
  id,
  projectId: id,
  kind: z.enum(['setup', 'payoff', 'foreshadow', 'callback', 'running_gag']),
  name: z.string().min(1),
  description: z.string().optional(),
  plantedChapter: z.number().int().positive(),
  advancedChapters: z.array(z.number().int().positive()).default([]),
  resolutionChapter: z.number().int().positive().optional(),
  status: z.enum(['planned', 'active', 'resolved', 'abandoned']).default('active'),
  payoffHint: z.string().optional(),
  /**
   * 期望回收章号。用于区分「长线伏笔」与「忘了收」：
   * currentChapter >= payoffWindow 则升级为 overdue。
   */
  payoffWindow: z.number().int().positive().optional(),
  deletedAt: isoDate.optional(),
})
export type PlotThread = z.infer<typeof plotThreadSchema>

export const storyArcSchema = z.object({
  id,
  projectId: id,
  name: z.string().min(1),
  startChapter: z.number().int().positive(),
  endChapter: z.number().int().positive(),
  purpose: z.string().optional(),
  turningPoint: z.number().int().positive().optional(),
  order: z.number().int().nonnegative(),
})
export type StoryArc = z.infer<typeof storyArcSchema>

// ---------------------------------------------------------------------------
// 文风与手法
// ---------------------------------------------------------------------------

export const styleAssetSchema = z.object({
  id,
  projectId: id,
  name: z.string().min(1),
  description: z.string().min(1),
  samples: z.array(z.string()).default([]),
  bannedWords: z.array(z.string()).default([]),
  bannedPatterns: z.array(z.string()).default([]),
  /** 量化上限：{ "仿佛": 3 } 表示全章最多出现 3 次 */
  quantLimits: z.record(z.string(), z.number()).default({}),
})
export type StyleAsset = z.infer<typeof styleAssetSchema>

export const techniqueScopeSchema = z.enum(['global', 'arc', 'chapter', 'character'])
export type TechniqueScope = z.infer<typeof techniqueScopeSchema>

export const writingTechniqueSchema = z
  .object({
    id,
    projectId: id,
    name: z.string().min(1),
    category: z.enum(['rhythm', 'description', 'dialogue', 'foreshadow', 'emotion', 'entrance']),
    content: z.string().min(1),
    scope: techniqueScopeSchema,
    /** 作用域指针：scope 决定哪个字段必填，其余为 null */
    arcId: z.string().optional(),
    chapterNo: z.number().int().positive().optional(),
    characterId: z.string().optional(),
    examples: z.string().optional(),
    priority: z.number().int().default(3),
    isActive: z.boolean().default(true),
  })
  .refine(
    (t) =>
      t.scope === 'global' ||
      (t.scope === 'arc' && t.arcId !== undefined) ||
      (t.scope === 'chapter' && t.chapterNo !== undefined) ||
      (t.scope === 'character' && t.characterId !== undefined),
    { message: 'scope 与对应指针字段不匹配（spec §3.17）' },
  )
export type WritingTechnique = z.infer<typeof writingTechniqueSchema>
