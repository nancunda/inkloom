import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { nextRevision } from '@inkloom/core'
import { characterSchema, InkloomError } from '@inkloom/shared'
import { chat } from '../llm/deepseek.js'
import { type FetchLike, LlmError } from '../llm/types.js'
import { readIfExists } from '../storage/atomic-write.js'
import { readJsonArray, writeJsonElement } from '../storage/elements.js'
import { bookPaths } from '../storage/paths.js'
import { appendRevision, lastRevision } from '../storage/revisions.js'
import { getContext } from './context.js'

export type ProposalField = 'curPhysical' | 'curMental' | 'curTierId'
const ALLOWED_FIELDS: readonly ProposalField[] = ['curPhysical', 'curMental', 'curTierId']

export interface StateProposal {
  id: string
  characterId: string
  characterName: string
  field: ProposalField
  newValue: string
  evidenceQuote: string
  /**
   * 证据原文是否真的在正文里（Ruling 44）。
   *
   * ★ 实测模型会把「腕骨」写成「臂骨」、把「丢了一魂」写成「少了一魂」。
   *   一次 includes 就能挡住编造的证据，成本几乎为零。
   *   false 不代表提案一定错，但**必须人工核对**——CLI 会显 ⚠。
   */
  evidenceVerified: boolean
  /** 从第几章起生效 = 本章 N + 1（spec §4.8） */
  stateChapter: number
}

export interface ProposeResult {
  runId: string
  proposals: StateProposal[]
  /** 模型输出里无法解析的行（供排查） */
  unparsed: string[]
}

function newRunId(): string {
  return `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** 比对证据时去掉所有空白与换行：模型常把它们插在引文里 */
function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, '')
}

const SYSTEM_PROMPT = `你是小说编辑助手。读一章正文，找出"角色状态发生了变化"的地方。

只看三个字段：
- curPhysical：身体状态（受伤、中毒、断臂、失明…）
- curMental：心理状态（恐惧、决意、崩溃、释然…）
- curTierId：修为境界（仅当正文明确写出突破/跌落时）

输出格式：每行一条，用竖线分隔，不要任何其它文字：
角色ID|字段|新值|证据原文
- 新值：不超过 12 字的短语
- 证据原文：从正文里逐字复制的一句，不超过 40 字
- 没有变化就不输出任何行`

async function readChapterBody(root: string, chapterNo: number): Promise<string> {
  const name = `ch-${String(chapterNo).padStart(3, '0')}.md`
  const raw = await readIfExists(join(bookPaths(root).chapters, name))
  if (raw === null) {
    throw new InkloomError('NOT_FOUND', `第 ${chapterNo} 章没有定稿正文，无法做状态提案`)
  }
  // 去掉一级标题与场景/段标记，只留正文
  return raw
    .replace(/^#.*$/m, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
}

/**
 * 调 LLM 产出状态变更提案（spec §4.1 [9]）。
 *
 * ★ 只提案，不落库：写 revision 必须用户逐条确认（§5「AI 只提案，人决定」）。
 * ★ stateChapter = 本章 + 1：spec §4.8——第 N 章结尾的断臂不能喂给第 N 章开头。
 * ★ 行格式而非 JSON（Ruling 38）：证据原文是中文引用，塞进 JSON 要转义引号和换行，
 *   模型容易写坏；而行格式解析失败只丢一行，不会整体报废。
 */
export async function proposeStateChanges(input: {
  chapterNo: number
  apiKey: string
  fetchImpl?: FetchLike
  model?: string
}): Promise<ProposeResult> {
  const { root, db, project } = getContext()
  const body = await readChapterBody(root, input.chapterNo)

  const rawChars = await readJsonArray(root, 'characters/index.json')
  const cast: { id: string; name: string }[] = []
  for (const item of rawChars) {
    const r = characterSchema.safeParse(item)
    if (r.success) cast.push({ id: r.data.id, name: r.data.name })
  }

  const runId = newRunId()
  const model = input.model ?? 'deepseek-flash'
  const userPrompt = [
    '【角色列表】',
    ...cast.map((c) => `${c.id} = ${c.name}`),
    '',
    '【本章正文】',
    body,
  ].join('\n')

  await db.generationRun.create({
    data: {
      id: runId,
      projectId: project.id,
      chapterNo: input.chapterNo,
      commitState: 'pending',
      purpose: 'state_proposal',
      provider: 'deepseek',
      model,
      assembledPrompt: JSON.stringify([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ]),
      status: 'running',
    },
  })

  let content: string
  try {
    const r = await chat({
      apiKey: input.apiKey,
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 4000,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    })
    content = r.content
  } catch (e) {
    // ★ 提案场景下空输出是合法的（模型认为「本章没有状态变化」），
    //   不能像生成侧那样当作失败。chat 的 EMPTY 保护是给正文生成用的。
    if (e instanceof LlmError && e.code === 'EMPTY') {
      content = ''
    } else {
      await db.generationRun.update({
        where: { id: runId },
        data: { status: 'failed', errorMessage: (e as Error).message, finishedAt: new Date() },
      })
      throw e
    }
  }

  const proposals: StateProposal[] = []
  const unparsed: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    // ★ 只按前 3 个 | 切分：证据原文里可能含 |（Ruling 38）
    const parts = trimmed.split('|')
    if (parts.length < 4) {
      unparsed.push(trimmed)
      continue
    }
    const charId = (parts[0] ?? '').trim()
    const field = (parts[1] ?? '').trim()
    const newValue = (parts[2] ?? '').trim()
    const evidence = parts.slice(3).join('|').trim()
    const known = cast.find((c) => c.id === charId)
    if (
      known === undefined ||
      !ALLOWED_FIELDS.includes(field as ProposalField) ||
      newValue.length === 0
    ) {
      unparsed.push(trimmed)
      continue
    }
    proposals.push({
      id: `prop_${proposals.length}_${charId}`,
      characterId: known.id,
      characterName: known.name,
      field: field as ProposalField,
      newValue,
      evidenceQuote: evidence,
      // 去空白后比对：模型常在引文里多加空格或换行
      evidenceVerified: normalizeForMatch(body).includes(normalizeForMatch(evidence)),
      stateChapter: input.chapterNo + 1,
    })
  }

  await db.generationRun.update({
    where: { id: runId },
    data: {
      status: 'success',
      output: JSON.stringify({ proposals, unparsed }),
      finishedAt: new Date(),
    },
  })

  return { runId, proposals, unparsed }
}

/** 取某章最近一次提案（apply 需要用它还原完整信息） */
export async function loadLatestProposals(chapterNo: number): Promise<StateProposal[]> {
  const { db, project } = getContext()
  const run = await db.generationRun.findFirst({
    where: { projectId: project.id, chapterNo, purpose: 'state_proposal', status: 'success' },
    orderBy: { startedAt: 'desc' },
  })
  if (run === null || run.output === null) {
    throw new InkloomError('NOT_FOUND', `第 ${chapterNo} 章还没有状态提案，先跑 propose`)
  }
  const parsed = JSON.parse(run.output) as { proposals: StateProposal[] }
  return parsed.proposals
}

/**
 * 应用用户确认的提案。
 *
 * ★ 逐条确认：只写 acceptIds 里的，其余跳过（§5「AI 只提案，人决定」）。
 * ★ 同一角色的多个字段**合并成一条 revision**（Ruling 40）：
 *   resolveCharacterState 按 stateChapter 取值，同章多条会有一条被浪费；
 *   而且用户「确认第 4 章的 3 个变化」是一个整体决策，不是 3 次独立决策。
 * ★ payload 是**扁平实体快照**（不是 { state: {...} } 嵌套）：
 *   resolveCharacterState 返回的 state 就是 JSON.parse(payload) 本身，
 *   嵌一层会让装配层读不到状态。
 */
export async function applyStateProposals(input: {
  chapterNo: number
  acceptIds: string[]
}): Promise<{ applied: number; skipped: number }> {
  const { root, db, project } = getContext()
  const proposals = await loadLatestProposals(input.chapterNo)
  const accepted = new Set(input.acceptIds)

  let applied = 0
  let skipped = 0

  // 按角色分组：一个角色一次写入
  const byChar = new Map<string, StateProposal[]>()
  for (const p of proposals) {
    if (!accepted.has(p.id)) {
      skipped++
      continue
    }
    const list = byChar.get(p.characterId) ?? []
    list.push(p)
    byChar.set(p.characterId, list)
  }

  const touched = new Set<string>()
  for (const [charId, list] of byChar) {
    const prev = await lastRevision(root, 'character', charId)
    const prevPayload: Record<string, unknown> =
      prev === null ? {} : (JSON.parse(prev.payload) as Record<string, unknown>)

    const changes: Record<string, unknown> = {}
    for (const p of list) {
      // ★ 同字段多条提案用「；」拼接（Ruling 43）：身体状态允许多项并存，
      //   直接赋值会让后一条覆盖前一条（实测 3 条 curPhysical 只剩 1 条）。
      const prevValue = changes[p.field]
      changes[p.field] =
        prevValue === undefined ? p.newValue : `${String(prevValue)}；${p.newValue}`
    }

    const revision = nextRevision({
      id: `rev_${charId}_${(prev?.version ?? 0) + 1}`,
      entityType: 'character',
      entityId: charId,
      prev,
      payload: {
        ...prevPayload,
        ...changes,
        // stateChapter 语义：从第几章起生效（定稿第 N 章 → N+1）
        stateChapter: list[0]?.stateChapter ?? input.chapterNo + 1,
        stateStale: false,
        sourceQuote: list.map((p) => p.evidenceQuote).join(' / '),
        sourceChapter: input.chapterNo,
      },
      changeSource: 'ai',
      changeReason: `第 ${input.chapterNo} 章定稿：${list.map((p) => p.field).join('、')}`,
      now: new Date().toISOString(),
    })
    await appendRevision(root, revision)
    applied += list.length
    touched.add(charId)
  }

  // 清掉被提案角色的 stateStale（文件 + 索引）
  if (touched.size > 0) {
    const rawChars = await readJsonArray(root, 'characters/index.json')
    const next = rawChars.map((item) => {
      const r = characterSchema.safeParse(item)
      if (!r.success) return item
      if (!touched.has(r.data.id)) return item
      return { ...r.data, stateStale: false }
    })
    await writeJsonElement(root, 'characters/index.json', next)
    for (const id of touched) {
      await db.character.updateMany({
        where: { projectId: project.id, id },
        data: { stateStale: false },
      })
    }
  }

  return { applied, skipped }
}
