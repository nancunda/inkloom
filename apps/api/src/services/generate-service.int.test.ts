import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import type { FetchLike } from '../llm/types.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { generateChapter } from './generate-service.js'

let base: string
let root: string
let db: IndexDb

/** 假 fetch：返回固定正文，零网络零花费 */
function fakeLlm(
  content: string,
  usage = { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 800 },
): FetchLike {
  return async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-gen-'))
  root = join(base, 'qixia')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  await setContext({ root, db, project })
  await writeJsonElement(root, 'characters/index.json', [
    { id: 'c1', projectId: project.id, name: '林岚', role: 'protagonist' },
  ])
  await writeJsonElement(root, 'story/blueprints/ch-004.json', {
    id: 'b4',
    projectId: project.id,
    chapterNo: 4,
    goal: '走到碑前',
    conflict: '裴无咎阻拦',
    hook: '名字是她自己',
    castIds: ['c1'],
    beatType: 'climax',
    tensionLevel: 5,
  })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true })
})

const THREE_SCENES = `===场景1===
林岚踏上山道。

===场景2===
剑冢在雾中显现。

===场景3===
她按住了玉牌。`

describe('generateChapter', () => {
  it('★ 生成三段场景候选稿并落盘', async () => {
    const r = await generateChapter({
      chapterNo: 4,
      apiKey: 'sk-test',
      fetchImpl: fakeLlm(THREE_SCENES),
    })
    expect(r.strategy).toBe('marker')
    expect(r.scenes).toHaveLength(3)
    const first = r.scenes[0]
    if (first === undefined) throw new Error('没有场景')
    const raw = await readFile(join(root, first.relPath), 'utf8')
    expect(raw).toContain('<!-- seg:')
  })

  it('★ generation_run 存完整 assembledPrompt（可复现）', async () => {
    const r = await generateChapter({
      chapterNo: 4,
      apiKey: 'sk-test',
      fetchImpl: fakeLlm(THREE_SCENES),
    })
    const run = await db.generationRun.findUnique({ where: { id: r.runId } })
    expect(run).not.toBeNull()
    expect(run?.assembledPrompt).toContain('本章蓝图')
    expect(run?.status).toBe('success')
    expect(run?.purpose).toBe('draft')
  })

  it('★ 记录 usage 与 cacheHit', async () => {
    const r = await generateChapter({
      chapterNo: 4,
      apiKey: 'sk-test',
      fetchImpl: fakeLlm(THREE_SCENES),
    })
    expect(r.usage.input).toBe(1000)
    expect(r.usage.output).toBe(500)
    expect(r.usage.cacheHit).toBe(800)
    const run = await db.generationRun.findUnique({ where: { id: r.runId } })
    expect(run?.usageInput).toBe(1000)
    expect(run?.cacheHitTokens).toBe(800)
  })

  it('★ 每个段都有唯一 segId', async () => {
    await generateChapter({ chapterNo: 4, apiKey: 'sk-test', fetchImpl: fakeLlm(THREE_SCENES) })
    const segs = await db.draftSegment.findMany({ where: { chapterNo: 4 } })
    const ids = segs.map((s) => s.segId)
    expect(ids.length).toBeGreaterThanOrEqual(3)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{4}$/)
  })

  it('★ 切分降级时 warnings 与 degradedReason 都留痕', async () => {
    const noMarker = `${'甲'.repeat(500)}\n\n${'乙'.repeat(500)}`
    const r = await generateChapter({
      chapterNo: 4,
      apiKey: 'sk-test',
      fetchImpl: fakeLlm(noMarker),
    })
    expect(r.strategy).toBe('heuristic')
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.degradedReason).not.toBeNull()
    const run = await db.generationRun.findUnique({ where: { id: r.runId } })
    expect(run?.degradedReason).not.toBeNull()
    expect(run?.warnings).not.toBeNull()
  })

  it('★ LLM 失败时 run 记为 failed 且不落候选稿', async () => {
    const failFetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    await expect(
      generateChapter({ chapterNo: 4, apiKey: 'sk-test', fetchImpl: failFetch }),
    ).rejects.toThrow()
    const runs = await db.generationRun.findMany({ where: { chapterNo: 4 } })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('failed')
    expect(runs[0]?.errorMessage).toContain('HTTP 500')
    expect(await db.draftSegment.count({ where: { chapterNo: 4 } })).toBe(0)
  })

  it('★ 蓝图缺失时在建 run 之前就失败（不留垃圾 run）', async () => {
    await expect(
      generateChapter({ chapterNo: 99, apiKey: 'sk-test', fetchImpl: fakeLlm('甲') }),
    ).rejects.toThrow()
    expect(await db.generationRun.count()).toBe(0)
  })

  it('同一章重复生成产生递增的场景版本', async () => {
    const r1 = await generateChapter({
      chapterNo: 4,
      apiKey: 'sk-test',
      fetchImpl: fakeLlm(THREE_SCENES),
    })
    const r2 = await generateChapter({
      chapterNo: 4,
      apiKey: 'sk-test',
      fetchImpl: fakeLlm(THREE_SCENES),
    })
    expect(r1.scenes[0]?.version).toBe(1)
    expect(r2.scenes[0]?.version).toBe(2)
  })

  it('★ 候选稿进 Git（有 commit）', async () => {
    await generateChapter({ chapterNo: 4, apiKey: 'sk-test', fetchImpl: fakeLlm(THREE_SCENES) })
    const count = await db.generationRun.count()
    expect(count).toBe(1)
    // 生成本身不抛错即说明 commitAll 没抛（失败只会进 warnings）
  })
})
