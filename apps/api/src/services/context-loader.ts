import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveCharacterState } from '@inkloom/core'
import type { AssembleInput } from '@inkloom/prompt'
import {
  type Blueprint,
  blueprintSchema,
  type Character,
  type CharacterRelation,
  type CharacterSignature,
  characterRelationSchema,
  characterSchema,
  characterSignatureSchema,
  InkloomError,
  type Location,
  locationSchema,
  type PlotThread,
  plotThreadSchema,
  type Route,
  routeSchema,
  type StyleAsset,
  styleAssetSchema,
  type WorldRule,
  worldRuleSchema,
} from '@inkloom/shared'
import { readIfExists } from '../storage/atomic-write.js'
import { readJsonArray, readJsonElement } from '../storage/elements.js'
import { bookPaths } from '../storage/paths.js'
import { readRevisions } from '../storage/revisions.js'
import { getContext } from './context.js'

/** 上章结尾取多少字（spec §4.4 的 C2 层固定 800） */
const PREVIOUS_ENDING_CHARS = 800
/** 近期摘要取几章（C3 层） */
const SUMMARY_CHAPTERS = 3

export interface LoadedChapterContext {
  input: AssembleInput
  /** 上章定稿是否存在（false 时装配层会跳过 U5） */
  hasPreviousChapter: boolean
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

/**
 * Zod schema 的最小形状。
 * ❗不能用 `{ safeParse: (v) => { success: boolean; data?: T } }`：
 *   Zod 的失败分支没有 `data` 字段，那个签名会让所有 schema 报类型不匹配。
 */
type Parseable<T> = {
  safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown }
}

/** 用 Zod 逐个校验，坏数据记 warning 而不是污染 prompt */
function parseList<T>(raw: unknown[], schema: Parseable<T>, label: string): T[] {
  const out: T[] = []
  for (const item of raw) {
    const r = schema.safeParse(item)
    if (r.success) out.push(r.data)
    else console.warn(`[context] ${label} 有一条数据不合 schema，已跳过`)
  }
  return out
}

async function readOptional<T>(root: string, rel: string, schema: Parseable<T>): Promise<T | null> {
  const raw = await readJsonElement(root, rel)
  if (raw === null) return null
  const r = schema.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * 按章装载上下文（spec §4.1 第 2 步）。
 *
 * ★ 这是唯一碰 IO 的装载点。core / prompt 都只接收已装载的数组。
 * ★ 只装本章需要的：角色按 castIds 过滤，规则按 hard/soft 分开，
 *   时间线只取到本章，后续蓝图只取 2 章。全书 300 章时不装载全书。
 */
export async function loadChapterContext(
  chapterNo: number,
  opts: { userGuidance?: string } = {},
): Promise<LoadedChapterContext> {
  const { root, db, project } = getContext()
  const paths = bookPaths(root)

  // 1. 蓝图（必须先存在）
  const bpName = `ch-${String(chapterNo).padStart(3, '0')}.json`
  const blueprint = await readOptional(root, `story/blueprints/${bpName}`, blueprintSchema)
  if (blueprint === null) {
    throw new InkloomError(
      'NOT_FOUND',
      `第 ${chapterNo} 章还没有蓝图（story/blueprints/${bpName}）`,
    )
  }

  // 2. 全部蓝图（用于时间线 + 后续 2 章）
  const allBlueprints: Blueprint[] = []
  try {
    for (const name of await readdir(join(paths.story, 'blueprints'))) {
      if (!name.endsWith('.json')) continue
      const b = await readOptional(root, `story/blueprints/${name}`, blueprintSchema)
      if (b !== null) allBlueprints.push(b)
    }
  } catch {
    allBlueprints.push(blueprint)
  }
  allBlueprints.sort((a, b) => a.chapterNo - b.chapterNo)

  // 3. 角色：只取 castIds，且状态按章推导
  const rawChars = await readJsonArray(root, 'characters/index.json')
  const allChars = parseList<Character>(rawChars, characterSchema, 'characters/index.json')
  const cast: Character[] = []
  for (const id of blueprint.castIds) {
    const base = allChars.find((c) => c.id === id)
    if (base === undefined) {
      console.warn(`[context] castIds 里的 ${id} 在 characters/index.json 中不存在`)
      continue
    }
    // 状态推导：按 stateChapter 取「从第 N 章起生效」的那条
    const revs = await readRevisions(root, 'character', id)
    const snap = resolveCharacterState(revs, id, chapterNo)
    if (snap === null) {
      cast.push(base)
      continue
    }
    cast.push({
      ...base,
      ...(typeof snap.state['curPhysical'] === 'string'
        ? { curPhysical: snap.state['curPhysical'] }
        : {}),
      ...(typeof snap.state['curMental'] === 'string'
        ? { curMental: snap.state['curMental'] }
        : {}),
      ...(typeof snap.state['curTierId'] === 'string'
        ? { curTierId: snap.state['curTierId'] }
        : {}),
    })
  }

  // 4. 关系：只取 cast 内部的关系，且在本章生效
  const rawRelations = await readJsonArray(root, 'characters/relations.json')
  const allRelations = parseList<CharacterRelation>(
    rawRelations,
    characterRelationSchema,
    'characters/relations.json',
  )
  const castIds = new Set(cast.map((c) => c.id))
  const relations = allRelations.filter(
    (r) =>
      castIds.has(r.fromId) &&
      castIds.has(r.toId) &&
      (r.sinceChapter === undefined || r.sinceChapter <= chapterNo) &&
      (r.untilChapter === undefined || r.untilChapter > chapterNo),
  )

  // 5. 签名：只取出场角色的、active 的
  const rawSigs = await readJsonArray(root, 'characters/signatures.json')
  const allSigs = parseList<CharacterSignature>(
    rawSigs,
    characterSignatureSchema,
    'characters/signatures.json',
  )
  const signatures = allSigs.filter((s) => castIds.has(s.characterId) && s.isActive)

  // 6. 规则：hard 全取、soft 全取（P1-a 不做关键词匹配，量小）
  const rawRules = await readJsonArray(root, 'world/rules.json')
  const allRules = parseList<WorldRule>(rawRules, worldRuleSchema, 'world/rules.json')
  const hardRules = allRules.filter((r) => r.priority === 'hard')
  const softRules = allRules.filter((r) => r.priority === 'soft')

  // 7. 地点与路线
  const rawLocations = await readJsonArray(root, 'world/locations.json')
  const locations = parseList<Location>(rawLocations, locationSchema, 'world/locations.json')
  const location =
    blueprint.locationId === undefined
      ? null
      : (locations.find((l) => l.id === blueprint.locationId) ?? null)
  const rawRoutes = await readJsonArray(root, 'world/routes.json')
  const allRoutes = parseList<Route>(rawRoutes, routeSchema, 'world/routes.json')
  const routes = location === null ? [] : allRoutes.filter((r) => r.toId === location.id)

  // 8. 线索：只取 active 且已埋设的，按紧迫度排序
  const rawThreads = await readJsonArray(root, 'story/threads.json')
  const allThreads = parseList<PlotThread>(rawThreads, plotThreadSchema, 'story/threads.json')
  const unresolved = allThreads
    .filter(
      (t) =>
        t.status === 'active' && (t.plantedChapter === undefined || t.plantedChapter < chapterNo),
    )
    .sort((a, b) => {
      const aUrgent =
        a.payoffWindow === undefined ? Number.MAX_SAFE_INTEGER : a.payoffWindow - chapterNo
      const bUrgent =
        b.payoffWindow === undefined ? Number.MAX_SAFE_INTEGER : b.payoffWindow - chapterNo
      if (aUrgent !== bUrgent) return aUrgent - bUrgent
      return (a.plantedChapter ?? 0) - (b.plantedChapter ?? 0)
    })

  // 9. 近期摘要（C3 层）：从索引读，跳过 stale
  const chapterRows = await db.chapter.findMany({
    where: {
      projectId: project.id,
      chapterNo: { lt: chapterNo },
      status: 'finalized',
      summaryStale: false,
    },
    orderBy: { chapterNo: 'desc' },
    take: SUMMARY_CHAPTERS,
    select: { chapterNo: true, summary: true },
  })
  const summaries = chapterRows
    .filter((r): r is { chapterNo: number; summary: string } => r.summary !== null)
    .map((r) => ({ chapterNo: r.chapterNo, summary: r.summary }))

  // 10. 上章结尾（C2 层）：读定稿文件尾部
  let previousEnding: string | null = null
  if (chapterNo > 1) {
    const prevName = `ch-${String(chapterNo - 1).padStart(3, '0')}.md`
    const raw = await readIfExists(join(paths.chapters, prevName))
    if (raw !== null) {
      // 去 HTML 注释（场景/段标记）与一级标题行
      const body = raw
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/^#.*$/m, '')
        .trim()
      previousEnding =
        body.length <= PREVIOUS_ENDING_CHARS ? body : body.slice(-PREVIOUS_ENDING_CHARS)
    }
  }

  // 11. 文风：取 isDefault 的那套
  const style = await readOptional(root, 'styles/default.json', styleAssetSchema)
  if (style === null) {
    throw new InkloomError('NOT_FOUND', 'styles/default.json 不存在或不合规，无法确定文风')
  }

  // 12. tier：从 world/power-system.json 里的 tiers 反查（文件可选）
  const tiers: { characterId: string; tierName: string; level: number }[] = []
  const ps = rec((await readJsonElement(root, 'world/power-system.json')) ?? {})
  const tierList = Array.isArray(ps['tiers']) ? (ps['tiers'] as unknown[]) : []
  for (const c of cast) {
    if (c.curTierId === undefined) continue
    const t = tierList.map(rec).find((x) => x['id'] === c.curTierId)
    if (t === undefined) continue
    tiers.push({
      characterId: c.id,
      tierName: String(t['name'] ?? ''),
      level: typeof t['level'] === 'number' ? t['level'] : 0,
    })
  }

  const input: AssembleInput = {
    style,
    project,
    blueprint,
    cast,
    relations,
    tiers,
    location,
    routes,
    hardRules,
    softRules,
    timeline: allBlueprints.filter((b) => b.chapterNo <= chapterNo),
    upcoming: allBlueprints.filter((b) => b.chapterNo > chapterNo).slice(0, 2),
    unresolved,
    summaries,
    previousEnding,
    signatures,
    userGuidance: opts.userGuidance ?? null,
  }

  return { input, hasPreviousChapter: previousEnding !== null }
}
