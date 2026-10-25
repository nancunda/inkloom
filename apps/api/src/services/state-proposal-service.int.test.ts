import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import type { FetchLike } from '../llm/types.js'
import { mergeChapter } from '../storage/chapters.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { readRevisions } from '../storage/revisions.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import {
  applyStateProposals,
  loadLatestProposals,
  proposeStateChanges,
} from './state-proposal-service.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

function fakeLlm(content: string): FetchLike {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 100 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-prop-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  await writeJsonElement(root, 'characters/index.json', [
    { id: 'c1', projectId: pid, name: '林岚', role: 'protagonist', curPhysical: '健康' },
    { id: 'c4', projectId: pid, name: '裴无咎', role: 'antagonist' },
  ])
  await mergeChapter(root, {
    chapterNo: 4,
    title: '第四章 剑冢',
    scenes: [{ sceneNo: 1, text: '剑气削过，林岚左臂裂开一道口子，血顺着指缝滴。' }],
  })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('proposeStateChanges', () => {
  it('★ 解析行格式提案，stateChapter = 本章 + 1', async () => {
    const out = 'c1|curPhysical|左臂受伤|左臂裂开一道口子，血顺着指缝滴'
    const r = await proposeStateChanges({ chapterNo: 4, apiKey: 'sk', fetchImpl: fakeLlm(out) })
    expect(r.proposals).toHaveLength(1)
    expect(r.proposals[0]?.characterId).toBe('c1')
    expect(r.proposals[0]?.characterName).toBe('林岚')
    expect(r.proposals[0]?.field).toBe('curPhysical')
    expect(r.proposals[0]?.newValue).toBe('左臂受伤')
    // ★ spec §4.8：定稿第 N 章的变化记 N+1
    expect(r.proposals[0]?.stateChapter).toBe(5)
  })

  it('★ 提案不落库（只存在 GenerationRun 里）', async () => {
    const out = 'c1|curPhysical|左臂受伤|血顺着指缝滴'
    await proposeStateChanges({ chapterNo: 4, apiKey: 'sk', fetchImpl: fakeLlm(out) })
    expect(await readRevisions(root, 'character', 'c1')).toHaveLength(0)
  })

  it('★ 角色 ID 不存在时跳过并记入 unparsed', async () => {
    const out = 'zzz|curPhysical|挂了|某段原文'
    const r = await proposeStateChanges({ chapterNo: 4, apiKey: 'sk', fetchImpl: fakeLlm(out) })
    expect(r.proposals).toHaveLength(0)
    expect(r.unparsed).toHaveLength(1)
  })

  it('★ 非法字段名时跳过', async () => {
    const out = 'c1|color|红色|原文'
    const r = await proposeStateChanges({ chapterNo: 4, apiKey: 'sk', fetchImpl: fakeLlm(out) })
    expect(r.proposals).toHaveLength(0)
    expect(r.unparsed).toHaveLength(1)
  })

  it('★ 证据原文里含 | 也能解析（只按前 3 个 | 切分）', async () => {
    const out = 'c1|curPhysical|左臂受伤|他说：甲|乙|丙'
    const r = await proposeStateChanges({ chapterNo: 4, apiKey: 'sk', fetchImpl: fakeLlm(out) })
    expect(r.proposals[0]?.evidenceQuote).toBe('他说：甲|乙|丙')
  })

  it('空输出时 proposals 为空且不报错', async () => {
    const r = await proposeStateChanges({ chapterNo: 4, apiKey: 'sk', fetchImpl: fakeLlm('') })
    expect(r.proposals).toEqual([])
  })

  it('★ 本章没有定稿正文时拒绝（提案要看正文）', async () => {
    await expect(
      proposeStateChanges({ chapterNo: 99, apiKey: 'sk', fetchImpl: fakeLlm('') }),
    ).rejects.toThrow()
  })
})

describe('applyStateProposals', () => {
  async function prepare(): Promise<string[]> {
    const out = ['c1|curPhysical|左臂受伤|血顺着指缝滴', 'c1|curMental|警觉|他按住剑柄'].join('\n')
    const r = await proposeStateChanges({ chapterNo: 4, apiKey: 'sk', fetchImpl: fakeLlm(out) })
    return r.proposals.map((p) => p.id)
  }

  it('★ 只写被确认的提案（逐条确认，不是全量应用）', async () => {
    const ids = await prepare()
    const r = await applyStateProposals({ chapterNo: 4, acceptIds: [ids[0] as string] })
    expect(r.applied).toBe(1)
    expect(r.skipped).toBe(1)
    const revs = await readRevisions(root, 'character', 'c1')
    expect(revs).toHaveLength(1)
    const payload = JSON.parse(revs[0]?.payload ?? '{}') as Record<string, unknown>
    expect(payload['stateChapter']).toBe(5)
    // ★ 扁平结构：字段直接落在 payload 顶层
    expect(payload['curPhysical']).toBe('左臂受伤')
    expect(payload['stateStale']).toBe(false)
  })

  it('★ 保留实体原有字段（payload 是完整快照，不是只有变化字段）', async () => {
    const ids = await prepare()
    await applyStateProposals({ chapterNo: 4, acceptIds: ids })
    const revs = await readRevisions(root, 'character', 'c1')
    expect(revs).toHaveLength(1)
    const payload = JSON.parse(revs[0]?.payload ?? '{}') as Record<string, unknown>
    // 两个提案合并后：curPhysical 和 curMental 都在同一快照里
    expect(payload['curPhysical']).toBe('左臂受伤')
    expect(payload['curMental']).toBe('警觉')
    expect(payload['stateChapter']).toBe(5)
  })

  it('★ 全部跳过时不写任何 revision', async () => {
    await prepare()
    const r = await applyStateProposals({ chapterNo: 4, acceptIds: [] })
    expect(r.applied).toBe(0)
    expect(await readRevisions(root, 'character', 'c1')).toHaveLength(0)
  })

  it('★ 没有提案记录时拒绝', async () => {
    await expect(applyStateProposals({ chapterNo: 7, acceptIds: ['x'] })).rejects.toThrow()
  })

  it('★ 应用后角色的 stateStale 被清掉（索引 + 文件）', async () => {
    await writeJsonElement(root, 'characters/index.json', [
      { id: 'c1', projectId: pid, name: '林岚', role: 'protagonist', stateStale: true },
    ])
    const ids = await prepare()
    await applyStateProposals({ chapterNo: 4, acceptIds: ids })
    const payload = JSON.parse(
      (await readRevisions(root, 'character', 'c1'))[0]?.payload ?? '{}',
    ) as Record<string, unknown>
    expect(payload['stateStale']).toBe(false)
  })
})

describe('loadLatestProposals', () => {
  it('★ 取最近一次提案（多 run 时按时间倒序）', async () => {
    const first = await proposeStateChanges({
      chapterNo: 4,
      apiKey: 'sk',
      fetchImpl: fakeLlm('c1|curPhysical|第一次|原文1'),
    })
    expect(first.proposals).toHaveLength(1)
    const second = await proposeStateChanges({
      chapterNo: 4,
      apiKey: 'sk',
      fetchImpl: fakeLlm('c1|curPhysical|第二次|原文2'),
    })
    const loaded = await loadLatestProposals(4)
    expect(loaded.map((p) => p.newValue)).toEqual(['第二次'])
    expect(second.proposals.map((p) => p.newValue)).toEqual(['第二次'])
  })
})
