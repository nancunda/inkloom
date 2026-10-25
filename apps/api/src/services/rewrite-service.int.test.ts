import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import type { FetchLike } from '../llm/types.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { readSceneFile, sceneRelPath, writeSceneFile } from '../storage/scenes.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { rewriteSceneSeg } from './rewrite-service.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

/** 26 字，作为比例基准 */
const ORIGINAL = '剑气贴着面颊削过去。林岚左臂裂开一道口子，血顺着指缝滴落。'
const NEXT = '她没停。'

/** 每次调用前设定本次模型怎么回 */
let reply: string
let lastBody: Record<string, unknown> = {}

const fakeLlm: FetchLike = async (_url, init) => {
  lastBody = JSON.parse(String(init.body)) as Record<string, unknown>
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 300 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

async function seedScene(): Promise<void> {
  const { relPath } = await writeSceneFile(
    root,
    {
      sceneNo: 1,
      version: 1,
      segments: [
        { segId: 'aaaa', text: ORIGINAL },
        { segId: 'bbbb', text: NEXT },
      ],
    },
    4,
  )
  await db.draftSegment.createMany({
    data: [
      {
        id: 'seg_4_1_1_aaaa',
        projectId: pid,
        chapterNo: 4,
        sceneNo: 1,
        segId: 'aaaa',
        seq: 0,
        filePath: relPath,
        contentHash: 'h1',
        wordCount: 26,
        status: 'candidate',
      },
      {
        id: 'seg_4_1_1_bbbb',
        projectId: pid,
        chapterNo: 4,
        sceneNo: 1,
        segId: 'bbbb',
        seq: 1,
        filePath: relPath,
        contentHash: 'h2',
        wordCount: 3,
        status: 'candidate',
      },
    ],
  })
}

function call(overrides: Partial<Parameters<typeof rewriteSceneSeg>[0]> = {}) {
  return rewriteSceneSeg({
    chapterNo: 4,
    sceneNo: 1,
    version: 1,
    segId: 'aaaa',
    apiKey: 'sk-test',
    fetchImpl: fakeLlm,
    ...overrides,
  })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-rewrite-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  await seedScene()
  reply = '剑气擦着面颊掠过。林岚左臂裂开，血顺着指缝滴在青石上。'
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('rewriteSceneSeg', () => {
  it('★ 成功：产 v2，只有目标段变了，邻段逐字节不变', async () => {
    const r = await call()
    expect(r.newVersion).toBe(2)
    expect(r.original).toBe(ORIGINAL)
    expect(r.rewritten).toBe(reply)

    const v2 = await readSceneFile(root, 4, 1, 2)
    expect(v2?.segments[0]).toEqual({ segId: 'aaaa', text: reply })
    // ★ 邻段：segId 与文本都必须原样
    expect(v2?.segments[1]).toEqual({ segId: 'bbbb', text: NEXT })
  })

  it('★ max_tokens 给推理模型留了空间（≥ 字数×4）', async () => {
    await call()
    expect(Number(lastBody['max_tokens'])).toBeGreaterThanOrEqual(26 * 4)
  })

  it('★ 输出过短 → INVALID_INPUT，且磁盘上不出现 v2', async () => {
    reply = '剑气掠过。林岚倒地。'
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(access(join(root, sceneRelPath(4, 1, 2)))).rejects.toThrow()
  })

  it('★ 输出里带段标记 → INVALID_INPUT（模型改写成了整段场景）', async () => {
    reply = '<!-- seg:aaaa -->剑气擦过面颊。'
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(access(join(root, sceneRelPath(4, 1, 2)))).rejects.toThrow()
  })

  it('段不存在 → NOT_FOUND', async () => {
    await expect(call({ segId: 'zzzz' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('★ 章节已定稿 → CONFLICT（不浪费一次模型调用）', async () => {
    lastBody = {}
    await db.chapter.create({
      data: { id: 'ch4', projectId: pid, chapterNo: 4, status: 'finalized', wordCount: 0 },
    })
    reply = '不应当被用到。'
    await expect(call()).rejects.toBeInstanceOf(InkloomError)
    await expect(call()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(lastBody).toEqual({})
  })

  it('★ 模型报错时原样上抛，不产生新文件', async () => {
    const failing: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    await expect(call({ fetchImpl: failing })).rejects.toBeTruthy()
    await expect(access(join(root, sceneRelPath(4, 1, 2)))).rejects.toThrow()
  })

  it('蓝图存在时会被读进上下文（不改变结果，只保证不炸）', async () => {
    await writeJsonElement(root, 'story/blueprints/ch-004.json', {
      id: 'b4',
      projectId: pid,
      chapterNo: 4,
      title: '第四章 剑冢',
      goal: '走到碑前',
      conflict: '裴无咎阻拦',
      hook: '碑上的名字是她自己',
      castIds: [],
      beatType: 'climax',
      tensionLevel: 5,
    })
    const r = await call()
    expect(r.newVersion).toBe(2)
  })
})
