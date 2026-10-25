import type {
  Blueprint,
  Character,
  CharacterRelation,
  CharacterSignature,
  Location,
  PlotThread,
  Project,
  Route,
  WorldRule,
} from '@inkloom/shared'
import type { PromptBlock } from '../types.js'

/** 上章结尾保留的字数上限（spec §4.4 的 C2 层） */
const PREVIOUS_ENDING_CHARS = 800

export interface ChapterContextInput {
  project: Project
  blueprint: Blueprint
  cast: Character[]
  relations: CharacterRelation[]
  tiers: { characterId: string; tierName: string; level: number }[]
  location: Location | null
  routes: Route[]
  hardRules: WorldRule[]
  softRules: WorldRule[]
  timeline: Blueprint[]
  upcoming: Blueprint[]
  unresolved: PlotThread[]
  summaries: { chapterNo: number; summary: string }[]
  previousEnding: string | null
  signatures: CharacterSignature[]
  userGuidance: string | null
}

function tierOf(input: ChapterContextInput, characterId: string): string | null {
  const t = input.tiers.find((x) => x.characterId === characterId)
  return t === undefined ? null : `${t.tierName}（第 ${t.level} 阶）`
}

/**
 * U1 本章场地设定。
 *
 * ★ 为什么 U1 不在 system：这些内容每章随 castIds 变化，
 *   放进 system 会让 S1–S5 之后的所有前缀缓存失效（spec §4.2 的审查修正）。
 */
export function blockU1(input: ChapterContextInput): PromptBlock {
  const lines = ['【本章场地设定】']

  lines.push('', '## 出场角色')
  for (const c of input.cast) {
    const bits: string[] = [`${c.name}（${c.role}）`]
    if (c.personality !== undefined) bits.push(`性格：${c.personality}`)
    if (c.motivation !== undefined) bits.push(`动机：${c.motivation}`)
    if (c.appearance !== undefined) bits.push(`外貌：${c.appearance}`)
    if (c.curPhysical !== undefined) bits.push(`当前身体：${c.curPhysical}`)
    if (c.curMental !== undefined) bits.push(`当前心境：${c.curMental}`)
    const tier = tierOf(input, c.id)
    if (tier !== null) bits.push(`修为：${tier}`)
    // visualAnchor 是防 OOC 的关键：从参考图提取的硬特征
    if (c.visualAnchor !== undefined) bits.push(`外貌锚点（不得偏离）：${c.visualAnchor}`)
    lines.push(`· ${bits.join('；')}`)

    const sigs = input.signatures.filter((s) => s.characterId === c.id && s.isActive)
    for (const s of sigs) {
      lines.push(`  - 签名[${s.kind}/${s.trigger}/${s.frequency}]：${s.content}`)
    }
  }

  if (input.relations.length > 0) {
    lines.push('', '## 角色关系')
    const nameOf = (id: string): string => input.cast.find((c) => c.id === id)?.name ?? id
    for (const r of input.relations) {
      lines.push(`· ${nameOf(r.fromId)} → ${nameOf(r.toId)}：${r.kind}（强度 ${r.strength}/5）`)
    }
  }

  if (input.location !== null) {
    lines.push('', `## 本章地点：${input.location.name}（${input.location.type}）`)
    if (input.location.region !== undefined) lines.push(`所属区域：${input.location.region}`)
    if (input.location.description !== undefined) lines.push(input.location.description)
  }

  if (input.routes.length > 0) {
    lines.push('', '## 相关路程（系统计算，不得自行更改）')
    for (const r of input.routes) {
      lines.push(
        `· ${r.mode}：${r.days} 天${r.condition === undefined ? '' : `（${r.condition}）`}`,
      )
    }
  }

  if (input.softRules.length > 0) {
    lines.push('', '## 世界软设定（建议遵循）')
    for (const r of input.softRules) lines.push(`· ${r.name}：${r.content}`)
  }

  return { id: 'U1', role: 'user', priority: 1, content: lines.join('\n') }
}

/** U2 全书进度：只列到本章为止，绝不泄露后续 */
export function blockU2(input: ChapterContextInput): PromptBlock {
  const upto = input.timeline.filter((b) => b.chapterNo <= input.blueprint.chapterNo)
  if (upto.length === 0) return { id: 'U2', role: 'user', priority: 7, content: null }
  const lines = ['【全书进度】（截至本章）']
  for (const b of upto) {
    lines.push(`第 ${b.chapterNo} 章${b.title === undefined ? '' : ` ${b.title}`}：${b.goal}`)
  }
  return { id: 'U2', role: 'user', priority: 7, content: lines.join('\n') }
}

/** U3 未兑现清单：已按紧迫度排序，调用方负责排序 */
export function blockU3(input: ChapterContextInput): PromptBlock {
  if (input.unresolved.length === 0) return { id: 'U3', role: 'user', priority: 3, content: null }
  const lines = ['【必须记住的未兑现线索】']
  for (const t of input.unresolved) {
    const parts = [`[${t.kind}] ${t.title}`]
    if (t.plantedChapter !== undefined) parts.push(`埋于第 ${t.plantedChapter} 章`)
    if (t.payoffHint !== undefined) parts.push(`预期回收：${t.payoffHint}`)
    lines.push(`· ${parts.join('，')}`)
  }
  return { id: 'U3', role: 'user', priority: 3, content: lines.join('\n') }
}

/** U4 近 3 章摘要（C3 层），按章号升序 */
export function blockU4(input: ChapterContextInput): PromptBlock {
  const sorted = [...input.summaries].sort((a, b) => a.chapterNo - b.chapterNo)
  if (sorted.length === 0) return { id: 'U4', role: 'user', priority: 2, content: null }
  const lines = ['【近期剧情摘要】']
  for (const s of sorted) lines.push(`第 ${s.chapterNo} 章：${s.summary}`)
  return { id: 'U4', role: 'user', priority: 2, content: lines.join('\n') }
}

/**
 * U5 上章结尾（C2 层，固定 800 字）。
 * ★ 超长时保留**尾部**：要接续的是结尾，不是开头。
 */
export function blockU5(input: ChapterContextInput): PromptBlock {
  if (input.previousEnding === null || input.previousEnding.trim().length === 0) {
    return { id: 'U5', role: 'user', priority: 5, content: null }
  }
  const raw = input.previousEnding.trim()
  const tail =
    raw.length <= PREVIOUS_ENDING_CHARS ? raw : `（前文省略）${raw.slice(-PREVIOUS_ENDING_CHARS)}`
  return {
    id: 'U5',
    role: 'user',
    priority: 5,
    content: ['【上一章结尾】（必须自然接续，不要重复这段内容）', tail].join('\n'),
  }
}

/** U6 本章蓝图：结构化描述，不泄露 castIds 原始 JSON */
export function blockU6(input: ChapterContextInput): PromptBlock {
  const b = input.blueprint
  const lines = [`【本章蓝图】第 ${b.chapterNo} 章${b.title === undefined ? '' : ` ${b.title}`}`]
  lines.push(`目标：${b.goal}`)
  lines.push(`冲突：${b.conflict}`)
  if (b.turn !== undefined) lines.push(`转折：${b.turn}`)
  lines.push(`章末钩子：${b.hook}`)
  lines.push(`节奏类型：${b.beatType}，张力 ${b.tensionLevel}/5`)
  if (b.userGuidance !== undefined) lines.push(`作者备注：${b.userGuidance}`)
  return { id: 'U6', role: 'user', priority: 0, content: lines.join('\n') }
}

/** U7 后续 2 章蓝图：明确禁止提前写 */
export function blockU7(input: ChapterContextInput): PromptBlock {
  if (input.upcoming.length === 0) return { id: 'U7', role: 'user', priority: 6, content: null }
  const lines = ['【后续剧情走向】（**不要提前写**，仅用于避免本章埋下与之冲突的伏笔）']
  for (const b of input.upcoming) {
    lines.push(`第 ${b.chapterNo} 章：${b.goal}（冲突：${b.conflict}）`)
  }
  return { id: 'U7', role: 'user', priority: 6, content: lines.join('\n') }
}

/** U8 作者本章额外指导 */
export function blockU8(input: ChapterContextInput): PromptBlock {
  if (input.userGuidance === null || input.userGuidance.trim().length === 0) {
    return { id: 'U8', role: 'user', priority: 4, content: null }
  }
  return {
    id: 'U8',
    role: 'user',
    priority: 4,
    content: ['【作者本章额外指导】', input.userGuidance.trim()].join('\n'),
  }
}

/**
 * U9 锚点：不可偏离的作者事实。
 *
 * ★ 这是最后一道防线，也是**最后一个 block**。
 *   放在末尾是对抗 lost-in-the-middle：开头（S1）说一次、结尾（U9）再说一次，
 *   中间的易变内容才不会把核心设定冲掉。
 */
export function blockU9(input: ChapterContextInput): PromptBlock {
  const p = input.project
  const items: string[] = []
  if (p.coreIdea !== undefined) items.push(`核心创意：${p.coreIdea}`)
  if (p.premise !== undefined) items.push(`故事前提：${p.premise}`)
  if (p.theme !== undefined) items.push(`主题：${p.theme}`)
  if (p.toneContract !== undefined) items.push(`语调契约：${p.toneContract}`)
  if (items.length === 0) return { id: 'U9', role: 'user', priority: 0, content: null }

  const lines = ['【不可偏离的作者事实】（以下内容**不可偏离**，与之冲突的写法一律视为错误）']
  for (const it of items) lines.push(`· ${it}`)
  return { id: 'U9', role: 'user', priority: 0, content: lines.join('\n') }
}
