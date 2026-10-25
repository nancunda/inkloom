#!/usr/bin/env node
// P2-a 验收：局部重写 6 条。全部假 LLM，零网络零花费。
//
// ★ 与 rewrite-service.int.test.ts 的分工：那边跑在 vitest 里逐条断言；
//   这里走一遍「用户会遇到的完整动作」，输出人可读的结论，
//   并额外核对磁盘状态（失败时不许留下半成品版本文件）。
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IndexDb } from '../apps/api/src/index-db/client.js'
import type { FetchLike } from '../apps/api/src/llm/types.js'
import { clearContext, setContext } from '../apps/api/src/services/context.js'
import {
  type RewriteSceneSegOptions,
  rewriteSceneSeg,
} from '../apps/api/src/services/rewrite-service.js'
import { createProject } from '../apps/api/src/storage/project.js'
import { readSceneFile, sceneRelPath, writeSceneFile } from '../apps/api/src/storage/scenes.js'
import { freshIndexDb } from '../apps/api/src/test-utils/index-db-fixture.js'

const results: { name: string; ok: boolean; err?: string }[] = []
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    results.push({ name, ok: false, err })
    console.error(`✗ ${name}\n    ${err}`)
  }
}

/** 34 字，比例校验基准 */
const ORIGINAL = '剑气贴着面颊削过去。林岚左臂裂开一道口子，血顺着指缝滴落，落在青石上。'
const NEXT = '她没停。'
const GOOD = '剑气贴着面颊掠过。林岚左臂裂开，血顺指缝滴在青石上，砸出细响。'

let reply = GOOD
const fakeLlm: FetchLike = async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 400, completion_tokens: 200 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

const tmp = await mkdtemp(join(tmpdir(), 'inkloom-p2a-'))
const book = join(tmp, 'book')
let db: IndexDb | null = null
let pid = ''

function call(overrides: Partial<RewriteSceneSegOptions> = {}) {
  return rewriteSceneSeg({
    chapterNo: 4,
    sceneNo: 1,
    version: 1,
    segId: 'aaaa',
    apiKey: 'sk-fake',
    fetchImpl: fakeLlm,
    ...overrides,
  })
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(join(book, rel))
    return true
  } catch {
    return false
  }
}

try {
  await check('准备：建书 + 一个两段的场景', async () => {
    const { project } = await createProject({ rootPath: book, name: 'P2A', genre: 'xuanhuan' })
    pid = project.id
    db = await freshIndexDb(tmp)
    await setContext({ root: book, db, project })
    const { relPath } = await writeSceneFile(
      book,
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
          wordCount: 34,
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
  })

  await check('★ 重写成功 → 产 v2，目标段换成模型输出', async () => {
    const r = await call()
    if (r.newVersion !== 2) throw new Error(`期望 v2，实际 v${r.newVersion}`)
    const v2 = await readSceneFile(book, 4, 1, 2)
    if (v2?.segments[0]?.text !== GOOD) throw new Error('目标段没换成模型输出')
    if (v2?.segments[0]?.segId !== 'aaaa') throw new Error('段 ID 变了——单段回退会失效')
  })

  await check('★ 其余段逐字节不变（局部重写不是整场景重写）', async () => {
    const v1 = await readSceneFile(book, 4, 1, 1)
    const v2 = await readSceneFile(book, 4, 1, 2)
    const a = v1?.segments[1]
    const b = v2?.segments[1]
    if (a?.segId !== b?.segId || a?.text !== b.text) throw new Error('邻段被改动了')
  })

  await check('★ 输出过短 → 拒绝，且磁盘上没有 v3', async () => {
    reply = '剑气掠过。林岚倒地。'
    await expectFail('INVALID_INPUT')
    if (await exists(sceneRelPath(4, 1, 3))) throw new Error('失败却留下了 v3 文件')
  })

  await check('★ 输出里带段标记 → 拒绝（模型改写成了整段场景）', async () => {
    reply = '<!-- seg:aaaa -->剑气擦过面颊。'
    await expectFail('INVALID_INPUT')
    if (await exists(sceneRelPath(4, 1, 3))) throw new Error('失败却留下了文件')
  })

  await check('段不存在 → NOT_FOUND', async () => {
    reply = GOOD
    await expectFail('NOT_FOUND', { segId: 'zzzz' })
  })

  await check('★ 章节已定稿 → CONFLICT', async () => {
    if (db === null) throw new Error('前置未就绪')
    await db.chapter.create({
      data: { id: 'ch4', projectId: pid, chapterNo: 4, status: 'finalized', wordCount: 0 },
    })
    await expectFail('CONFLICT')
  })
} finally {
  clearContext()
  if (db !== null) await db.$disconnect()
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** 断言这次调用以指定错误码失败 */
async function expectFail(
  code: string,
  overrides: Partial<RewriteSceneSegOptions> = {},
): Promise<void> {
  try {
    await call(overrides)
  } catch (e) {
    const actual = (e as { code?: string }).code
    if (actual !== code) throw new Error(`期望 ${code}，实际 ${String(actual)}`)
    return
  }
  throw new Error(`期望 ${code}，实际成功返回`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error('✗ P2-a 验收未通过')
  process.exit(1)
}
console.log('✓ P2-a 验收全部通过')
