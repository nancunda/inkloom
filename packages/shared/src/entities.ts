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
  /**
   * 七种签名（spec §3.16）。分类不是随意选的：
   * 出场/退场诗是玄幻标配手法，而“动作”与“意象道具”是更隐形的印象加深。
   */
  kind: z.enum([
    'entrance_verse',
    'exit_verse',
    'catchphrase',
    'verbal_tick',
    'signature_action',
    'motif',
    'epithet',
  ]),
  /** 诗号全文 / 台词 / 动作描述 */
  content: z.string().min(1),
  /**
   * ★ 场合触发器（spec §3.16 必填）。
   * frequency 只说“多频繁”，trigger 说“什么场合演出”——缺一不可。
   * 没有 trigger 就无法表达“退场时留一句话”这种手法。
   */
  trigger: z.enum(['entrance', 'exit', 'battle', 'anger', 'death', 'first_meet', 'always']),
  /**
   * 频率控制（ADR-20）：不控制的话每次出场都吟诗会变成尴尬的套路。
   * once = 仅首次正式出场；key_moment = 生死关头；every_scene = 口头禅。
   */
  frequency: z.enum(['once', 'key_moment', 'every_scene']).default('key_moment'),
  /** JSON: { good, bad } 示例 */
  examples: z.string().optional(),
  firstUsedChapter: z.number().int().positive().optional(),
  isActive: z.boolean().default(true),
  deletedAt: isoDate.optional(),
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
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  deletedAt: isoDate.optional(),
})
export type Location = z.infer<typeof locationSchema>

export const routeSchema = z.object({
  id,
  projectId: id,
  fromId: id,
  toId: id,
  mode: z.enum(['walk', 'ride', 'fly', 'teleport', 'boat', 'caravan']),
  /** 标准行进天数，系统算，AI 不得改（P0-13 / ADR-16）。spec 为 Int */
  days: z.number().int().positive(),
  /** “需过魔渊关，冬季封闭三个月”这类通行条件 */
  condition: z.string().optional(),
  /** 是否双向可走。传送阵/断桥为 false */
  bidirectional: z.boolean().default(true),
})
export type Route = z.infer<typeof routeSchema>

/**
 * 对应 spec §3.18 的 `model Reference`。
 *
 * 为什么类型名不同：TS 全局环境（lib.dom）已有 `Reference` 接口，同名会在
 * 搜索结果里混淆。字段与 spec 完全一致，只改类型名。
 */
export const loreReferenceSchema = z.object({
  id,
  projectId: id,
  query: z.string().min(1),
  /** tavily | bocha | searxng —— 换 provider 后不能混用缓存（spec 硬规则 3） */
  provider: z.string().min(1),
  title: z.string().optional(),
  url: z.string().url().optional(),
  snippet: z.string().optional(),
  /** 清洗后的正文 */
  content: z.string().optional(),
  fetchedAt: isoDate,
  /** JSON: 被哪些 generation_run 引用过（可追溯，P0 的“可复现”依赖它） */
  usedInRunIds: z.string().optional(),
  /** L3 级别：必须显式授权才进 prompt */
  approved: z.boolean().default(false),
})
export type LoreReference = z.infer<typeof loreReferenceSchema>

// ---------------------------------------------------------------------------
// 结构层
// ---------------------------------------------------------------------------

export const beatTypeSchema = z.enum([
  'setup',
  'rising',
  'climax',
  'twist',
  'falling',
  'resolution',
])
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
  castIds: z.array(id).default(() => []),
  locationId: z.string().optional(),
  /** 数值化故事时间（第 N 日），供时间线校验与 Route.days 累加 */
  storyDay: z.number().int().nonnegative().optional(),
  /** 描述性故事时间：“第 12 日 · 辰时”。时辰信息无法数值化，必须单独存 */
  storyTime: z.string().optional(),
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
  /** 与 spec §3.7 对齐（原写作 name 是错的） */
  title: z.string().min(1),
  description: z.string().optional(),
  /** 埋设章。spec 为 Int? —— “先登记、后埋设”（status=planned）是正常起点 */
  plantedChapter: z.number().int().positive().optional(),
  advancedChapters: z.array(z.number().int().positive()).default(() => []),
  /** 回收章。字段名与 spec §3.7 一致（原写作 resolutionChapter 是错的） */
  resolvedChapter: z.number().int().positive().optional(),
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
  samples: z.array(z.string()).default(() => []),
  bannedWords: z.array(z.string()).default(() => []),
  bannedPatterns: z.array(z.string()).default(() => []),
  /** 量化上限：{ "仿佛": 3 } 表示全章最多出现 3 次 */
  quantLimits: z.record(z.string(), z.number()).default(() => ({})),
  /**
   * ★ 默认文风。一本书可以有多套（冷硬短句 / 绵密长句 / 谈谐），
   * 但装配时 S2 段只能进一套 —— 没有这个标记就只能“取第一个”或全塞入。
   */
  isDefault: z.boolean().default(false),
  deletedAt: isoDate.optional(),
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
    /**
     * 作用域指针：scope 决定哪个字段必填，其余必须为空。
     * ★ 用 id（min 1）而非 z.string()：空串指针会通过校验但指向不存在的对象，
     *   注入时静默失效且不报错 —— 这是 spec 二次审查专门修掉的洞，不能重新打开。
     */
    arcId: id.optional(),
    chapterNo: z.number().int().positive().optional(),
    characterId: id.optional(),
    examples: z.string().optional(),
    priority: z.number().int().default(3),
    isActive: z.boolean().default(true),
  })
  .refine(
    (t) => {
      const hasArc = t.arcId !== undefined
      const hasChapter = t.chapterNo !== undefined
      const hasCharacter = t.characterId !== undefined
      switch (t.scope) {
        case 'global':
          // 全局手法不得携带任何指针，否则装配时会被误当成局部手法
          return !hasArc && !hasChapter && !hasCharacter
        case 'arc':
          // 同一时间只能属于一个作用域：混带指针会让注入优先级不确定
          return hasArc && !hasChapter && !hasCharacter
        case 'chapter':
          return hasChapter && !hasArc && !hasCharacter
        case 'character':
          return hasCharacter && !hasArc && !hasChapter
      }
    },
    {
      message:
        'scope 与指针字段不匹配：global 不得带指针，其余 scope 必须且只能带对应指针（spec §3.17）',
    },
  )
export type WritingTechnique = z.infer<typeof writingTechniqueSchema>
