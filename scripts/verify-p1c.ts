#!/usr/bin/env node
// P1-c 验收：HTTP 层 12 条 + 真实端口监听。全部假 LLM，零网络零花费。
//
// ★ 与 api.http.test.ts 的分工：那边跑在 vitest 里、用 app.request()；
//   这里额外验证两件 vitest 没法保证的事——
//   1) review.json 是审阅状态的**文件真相**（Ruling 47）：accept → reindex → 状态不丢
//   2) reindex 重建 Chapter 时 wordCount / finalizedAt 不能归零（Ruling 48）
//   这两条都是浏览器验收用眼睛抓到的 bug，必须变成永久回归。
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../apps/api/src/app.js'
import { commitAll, initRepo, isRepo } from '../apps/api/src/git/runner.js'
import type { IndexDb } from '../apps/api/src/index-db/client.js'
import { openBookIndexDb } from '../apps/api/src/index-db/open-book.js'
import type { FetchLike } from '../apps/api/src/llm/types.js'
import { startServer } from '../apps/api/src/server.js'
import { clearContext, setContext } from '../apps/api/src/services/context.js'
import { writeJsonElement } from '../apps/api/src/storage/elements.js'
import { createProject } from '../apps/api/src/storage/project.js'
import { reindex } from '../apps/api/src/storage/reindex.js'
import { reviewFilePath } from '../apps/api/src/storage/review-state.js'

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

const TWO_SCENES = `===场景1===
剑气贴着面颊削过去。林岚左臂裂开一道口子。

===场景2===
碑上刻着她自己的名字。`

const PROPOSAL_OUT = 'c1|curPhysical|左臂受伤|林岚左臂裂开一道口子'

/** 假 fetch：靠 system prompt 区分「写场景」与「提状态提案」 */
const llm: FetchLike = async (_url, init) => {
  const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
  const isProposal = body.messages[0]?.content.includes('小说编辑助手') === true
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: isProposal ? PROPOSAL_OUT : TWO_SCENES }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 2400,
        completion_tokens_details: { reasoning_tokens: 1200 },
        prompt_cache_hit_tokens: 600,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const tmp = await mkdtemp(join(tmpdir(), 'inkloom-p1c-'))
const book = join(tmp, 'book')
let db: IndexDb | null = null

type App = ReturnType<typeof createApp>
let app: App

/** 统一发请求，返回 { status, json } */
async function req(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await app.request(`/api${path}`, init)
  return { status: r.status, json: (await r.json()) as Record<string, unknown> }
}

function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

try {
  let wordCountBefore = 0
  let finalizedAtBefore = ''

  await check('准备：建书 + 蓝图 + 角色', async () => {
    const { project } = await createProject({
      rootPath: book,
      name: 'P1C',
      genre: 'xuanhuan',
      coreIdea: '碑上刻着她自己的名字',
      theme: '名字与身份',
    })
    await initRepo(book)
    await commitAll(book, 'chore: 初始化')
    db = await openBookIndexDb(book)
    await setContext({ root: book, db, project })

    await writeJsonElement(book, 'characters/index.json', [
      { id: 'c1', projectId: project.id, name: '林岚', role: 'protagonist', curPhysical: '健康' },
    ])
    await writeJsonElement(book, 'story/blueprints/ch-004.json', {
      id: 'b4',
      projectId: project.id,
      chapterNo: 4,
      title: '第四章 剑冢',
      goal: '走到碑前',
      conflict: '裴无咎阻拦',
      hook: '碑上的名字是她自己',
      castIds: ['c1'],
      beatType: 'climax',
      tensionLevel: 5,
    })
    await reindex(book, db)
    app = createApp({ fetchImpl: llm, apiKey: 'sk-fake' })
  })

  await check('GET /api/health → ok', async () => {
    const r = await req('/health')
    if (r.status !== 200 || r.json['ok'] !== true) throw new Error(`返回 ${JSON.stringify(r)}`)
  })

  await check('★ POST /api/chapters/4/generate → 2 个场景候选', async () => {
    const r = await post('/chapters/4/generate', {})
    if (r.status !== 200) throw new Error(`状态 ${r.status}：${JSON.stringify(r.json)}`)
    const scenes = r.json['scenes'] as unknown[]
    if (!Array.isArray(scenes) || scenes.length !== 2) {
      throw new Error(`应有 2 个场景，实际 ${JSON.stringify(scenes)}`)
    }
    const usage = r.json['usage'] as { reasoning: number }
    if (usage.reasoning !== 1200) throw new Error(`usage.reasoning 应为 1200`)
  })

  await check('★ GET /api/book 把「有候选但没定稿」的章标成 drafting', async () => {
    const r = await req('/book')
    const chapters = r.json['chapters'] as { chapterNo: number; status: string }[]
    const ch4 = chapters.find((c) => c.chapterNo === 4)
    if (ch4 === undefined) throw new Error('章节列表里没有第 4 章')
    // ★ 没有 Chapter 行时不能报 planned：它已经有候选稿了
    if (ch4.status !== 'drafting') throw new Error(`应为 drafting，实际 ${ch4.status}`)
  })

  await check('GET /api/chapters/4 → 2 个 candidate 场景', async () => {
    const r = await req('/chapters/4')
    const scenes = r.json['scenes'] as { sceneNo: number; status: string }[]
    if (scenes.length !== 2) throw new Error(`应有 2 个场景，实际 ${scenes.length}`)
    if (!scenes.every((s) => s.status === 'candidate')) {
      throw new Error(`应全为 candidate，实际 ${scenes.map((s) => s.status).join(',')}`)
    }
  })

  await check('GET /api/chapters/4/scenes/1 → 段带 segId', async () => {
    const r = await req('/chapters/4/scenes/1')
    const segs = r.json['segments'] as { segId: string; text: string }[]
    if (segs.length === 0) throw new Error('没有段')
    if (!segs.every((s) => /^[0-9a-z]{4}$/.test(s.segId))) {
      throw new Error(`segId 格式不对：${segs.map((s) => s.segId).join(',')}`)
    }
  })

  await check('★ 有 candidate 时定稿 → 409', async () => {
    const r = await post('/chapters/4/finalize', {})
    if (r.status !== 409) throw new Error(`应为 409，实际 ${r.status}`)
    const err = r.json['error'] as { code: string }
    if (err.code !== 'CONFLICT') throw new Error(`错误码应为 CONFLICT，实际 ${err.code}`)
  })

  await check('★ 接受全部场景 → review.json 落盘（Ruling 47）', async () => {
    for (const sceneNo of [1, 2]) {
      const r = await post(`/chapters/4/scenes/${sceneNo}/accept`, { version: 1 })
      if (r.status !== 200) throw new Error(`接受场景 ${sceneNo} 失败：${JSON.stringify(r.json)}`)
    }
    const raw = await readFile(reviewFilePath(book, 4), 'utf8')
    const saved = JSON.parse(raw) as { scenes: Record<string, { acceptedVersion: number }> }
    if (saved.scenes['1']?.acceptedVersion !== 1) throw new Error('review.json 里没有场景 1')
    if (saved.scenes['2']?.acceptedVersion !== 1) throw new Error('review.json 里没有场景 2')
  })

  await check('★ reindex 后 accepted 状态仍在（Ruling 47）', async () => {
    if (db === null) throw new Error('db 未初始化')
    await reindex(book, db)
    const r = await req('/chapters/4')
    const scenes = r.json['scenes'] as { sceneNo: number; status: string }[]
    if (!scenes.every((s) => s.status === 'accepted')) {
      throw new Error(`重建后状态丢了：${scenes.map((s) => `${s.sceneNo}=${s.status}`).join(',')}`)
    }
  })

  await check('★ 编辑一段 → v2 candidate，diff 能定位改动', async () => {
    const seg = await req('/chapters/4/scenes/1')
    const first = (seg.json['segments'] as { segId: string }[])[0]
    if (first === undefined) throw new Error('场景 1 没有段')
    const r = await post('/chapters/4/scenes/1/edit', {
      version: 1,
      segId: first.segId,
      newText: '剑气贴着面颊削过去。林岚左臂裂开一道口子，血滴在青石上。',
    })
    if (r.status !== 200) throw new Error(`编辑失败：${JSON.stringify(r.json)}`)
    if (r.json['newVersion'] !== 2)
      throw new Error(`应产出 v2，实际 ${String(r.json['newVersion'])}`)

    const d = await req('/chapters/4/scenes/1/diff?from=1&to=2')
    if (d.status !== 200) throw new Error(`diff 失败：${JSON.stringify(d.json)}`)
    if ((d.json['addedChars'] as number) <= 0) throw new Error('diff 没有识别出新增字符')
  })

  await check('★ 接受 v2 → 定稿成功，wordCount > 0', async () => {
    const a = await post('/chapters/4/scenes/1/accept', { version: 2 })
    if (a.status !== 200) throw new Error(`接受 v2 失败：${JSON.stringify(a.json)}`)
    const f = await post('/chapters/4/finalize', {})
    if (f.status !== 200) throw new Error(`定稿失败：${JSON.stringify(f.json)}`)
    wordCountBefore = f.json['wordCount'] as number
    if (wordCountBefore <= 0) throw new Error(`定稿字数为 ${wordCountBefore}`)

    finalizedAtBefore = (await readFinalizedAt()) ?? ''
    if (finalizedAtBefore === '') throw new Error('Chapter.finalizedAt 为空')
  })

  await check('★ reindex 后 wordCount / finalizedAt 不归零（Ruling 48）', async () => {
    if (db === null) throw new Error('db 未初始化')
    await reindex(book, db)
    const r = await req('/chapters/4')
    if (r.json['status'] !== 'finalized') throw new Error(`状态应为 finalized`)
    if (r.json['wordCount'] !== wordCountBefore) {
      throw new Error(`字数从 ${wordCountBefore} 变成 ${String(r.json['wordCount'])}`)
    }
    const after = await readFinalizedAt()
    if (after !== finalizedAtBefore)
      throw new Error(`定稿时间从 ${finalizedAtBefore} 变成 ${after}`)
  })

  await check('★ POST propose → 提案带 evidenceVerified', async () => {
    const r = await post('/chapters/4/propose', {})
    if (r.status !== 200) throw new Error(`提案失败：${JSON.stringify(r.json)}`)
    const ps = r.json['proposals'] as { evidenceVerified: boolean }[]
    if (ps.length !== 1) throw new Error(`应有 1 条提案，实际 ${ps.length}`)
    if (ps[0]?.evidenceVerified !== true) throw new Error('证据校验应为 true')
  })

  await check('错误映射：参数非数字 → 400，场景不存在 → 404', async () => {
    const bad = await req('/chapters/abc')
    if (bad.status !== 400) throw new Error(`应为 400，实际 ${bad.status}`)
    const miss = await req('/chapters/4/scenes/99')
    if (miss.status !== 404) throw new Error(`应为 404，实际 ${miss.status}`)
    const noRoute = await req('/nope')
    if (noRoute.status !== 404) throw new Error(`未注册路由应为 404，实际 ${noRoute.status}`)
  })

  await check('★ 真实端口：startServer(port:0) + fetch /api/health', async () => {
    const running = await startServer({ bookDir: book, port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${running.port}/api/health`)
      const j = (await r.json()) as { ok: boolean }
      if (r.status !== 200 || j.ok !== true)
        throw new Error(`返回 ${r.status} ${JSON.stringify(j)}`)
    } finally {
      await running.close()
    }
  })

  await check('★ 默认只绑 127.0.0.1，不监听 0.0.0.0（spec §9.9）', async () => {
    // 读内核真实绑定地址，不是读我们传进去的参数
    const running = await startServer({ bookDir: book, port: 0 })
    try {
      if (running.address !== '127.0.0.1') {
        throw new Error(`实际绑定 ${running.address}，无鉴权的 API 不能对局域网开放`)
      }
    } finally {
      await running.close()
    }
  })

  await check('★ 书没有 .git 时，startServer 自动补建（新 clone 开箱可用）', async () => {
    await rm(join(book, '.git'), { recursive: true, force: true })
    const running = await startServer({ bookDir: book, port: 0 })
    try {
      if (!(await isRepo(book))) throw new Error('启动后仍不是 git 仓库，accept/finalize 会失败')
    } finally {
      await running.close()
    }
  })
} finally {
  clearContext()
  if (db !== null) await db.$disconnect()
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

/** 直接读索引里的 finalizedAt，绕过 HTTP 的 ISO 序列化，比较原始值 */
async function readFinalizedAt(): Promise<string | null> {
  if (db === null) return null
  const row = await db.chapter.findFirst({ select: { finalizedAt: true } })
  return row?.finalizedAt?.toISOString() ?? null
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error('✗ P1-c 验收未通过')
  process.exit(1)
}
console.log('✓ P1-c 验收全部通过')
