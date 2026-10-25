#!/usr/bin/env node
// P1-a 验收：用假 LLM 跑完整链路，验证「装配 → 切分 → 落盘 → 记账」闭环。
// 真实模型质量由人判断，不在这里断言（Ruling 34）。
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitAll, git, initRepo } from '../apps/api/src/git/runner.js'
import type { IndexDb } from '../apps/api/src/index-db/client.js'
import { openBookIndexDb } from '../apps/api/src/index-db/open-book.js'
import type { FetchLike } from '../apps/api/src/llm/types.js'
import { setContext } from '../apps/api/src/services/context.js'
import { exportBook } from '../apps/api/src/services/export-service.js'
import { generateChapter } from '../apps/api/src/services/generate-service.js'
import { writeJsonElement } from '../apps/api/src/storage/elements.js'
import { bookPaths } from '../apps/api/src/storage/paths.js'
import { createProject } from '../apps/api/src/storage/project.js'
import { reindex } from '../apps/api/src/storage/reindex.js'

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

const THREE_SCENES = `===场景1===
林岚踏上山道，风从袖口灌进来。

===场景2===
剑冢在雾中显现。

===场景3===
她按住了玉牌，指节泛白。`

function fakeLlm(): FetchLike {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: THREE_SCENES }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2100, completion_tokens: 600, prompt_cache_hit_tokens: 1800 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

const tmp = await mkdtemp(join(tmpdir(), 'inkloom-p1a-'))
const book = join(tmp, 'book')
let db: IndexDb | null = null

try {
  // ---------------------------------------------------------------- 闭环
  await check('装配 → 生成 → 落盘闭环（3 个场景 + 段标记）', async () => {
    const { project } = await createProject({
      rootPath: book,
      name: 'P1A',
      genre: 'xuanhuan',
      // 锚点必须给：U9 在锚点全空时返回 null，就无法验证「锚点压尾」
      coreIdea: '剑冢里的名字',
      theme: '名字与身份',
      toneContract: '冷峻、克制',
    })
    await initRepo(book)
    await commitAll(book, 'chore: 初始化书籍')
    db = await openBookIndexDb(book)
    await setContext({ root: book, db, project })
    await reindex(book, db)

    await writeJsonElement(book, 'characters/index.json', [
      { id: 'c1', projectId: project.id, name: '林岚', role: 'protagonist' },
    ])
    await writeJsonElement(book, 'story/blueprints/ch-004.json', {
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

    const r = await generateChapter({ chapterNo: 4, apiKey: 'sk-fake', fetchImpl: fakeLlm() })
    if (r.strategy !== 'marker') throw new Error(`切分策略应为 marker，实际 ${r.strategy}`)
    if (r.scenes.length !== 3) throw new Error(`应有 3 个场景，实际 ${r.scenes.length}`)

    const first = r.scenes[0]
    if (first === undefined) throw new Error('没有场景')
    const raw = await readFile(join(book, first.relPath), 'utf8')
    if (!raw.includes('<!-- seg:')) throw new Error('候选稿缺少段标记')
    if (raw.includes('===场景')) throw new Error('候选稿里残留 ===场景 标记')
  })

  // ---------------------------------------------------------------- run 存档
  await check('generation_run 存完整 prompt（含锚点与蓝图）与 usage', async () => {
    if (db === null) throw new Error('db 未初始化')
    const runs = await db.generationRun.findMany()
    if (runs.length !== 1) throw new Error(`应有 1 条 run，实际 ${runs.length}`)
    const run = runs[0]
    if (run === undefined) throw new Error('run 缺失')
    if (!run.assembledPrompt.includes('不可偏离的作者事实')) throw new Error('prompt 里没有锚点块')
    if (!run.assembledPrompt.includes('本章蓝图')) throw new Error('prompt 里没有蓝图块')
    if (run.usageInput !== 2100) throw new Error(`usageInput 应为 2100，实际 ${run.usageInput}`)
    if (run.cacheHitTokens !== 1800)
      throw new Error(`cacheHit 应为 1800，实际 ${run.cacheHitTokens}`)
    if (run.status !== 'success') throw new Error(`status 应为 success，实际 ${run.status}`)
  })

  // ---------------------------------------------------------------- 段 ID
  await check('段 ID 全书唯一且格式合法（4 位 base36）', async () => {
    if (db === null) throw new Error('db 未初始化')
    const segs = await db.draftSegment.findMany()
    const ids = segs.map((s) => s.segId)
    if (new Set(ids).size !== ids.length) throw new Error('段 ID 有重复')
    if (ids.length < 3) throw new Error(`应有至少 3 段，实际 ${ids.length}`)
    for (const id of ids) if (!/^[0-9a-z]{4}$/.test(id)) throw new Error(`段 ID 格式非法：${id}`)
  })

  // ---------------------------------------------------------------- 索引重建
  await check('索引可重建（删库后 reindex 恢复 3 段）', async () => {
    if (db === null) throw new Error('db 未初始化')
    // ★ Windows 上必须先断开连接，否则 -wal/-shm 仍被持有，rm 会 EBUSY
    await db.$disconnect()
    db = null
    await rm(bookPaths(book).indexDb, { force: true, maxRetries: 5, retryDelay: 100 })
    const db2 = await openBookIndexDb(book)
    try {
      const report = await reindex(book, db2)
      if (report.segments !== 3) throw new Error(`reindex 应恢复 3 段，实际 ${report.segments}`)
    } finally {
      await db2.$disconnect()
    }
  })

  // ---------------------------------------------------------------- 导出
  await check('导出包含生成结果', async () => {
    const j = JSON.parse((await exportBook('json', book)).content) as { chapters?: unknown }
    if (j.chapters === undefined) throw new Error('导出缺 chapters')
  })

  // ---------------------------------------------------------------- Git
  await check('Git 有生成提交（≥2）', async () => {
    const count = Number((await git(book, ['rev-list', '--count', 'HEAD'])).trim())
    if (count < 2) throw new Error(`应有至少 2 个 commit（初始化 + 生成），实际 ${count}`)
  })
} finally {
  // ★ Windows 上 SQLite 的 -wal/-shm 会被进程持有，先断开再带重试地删
  if (db !== null) await db.$disconnect().catch(() => undefined)
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error('\n未通过：')
  for (const f of failed) console.error(`  ✗ ${f.name}\n    ${f.err}`)
  process.exit(1)
}
console.log('✓ P1-a 验收全部通过')
