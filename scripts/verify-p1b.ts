#!/usr/bin/env node
// P1-b 验收：生成 → 逐场景确认 → 编辑 → diff → 定稿 → 状态提案 → 撤销。
// 全部用假 LLM，零网络零花费。
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitAll, git, initRepo } from '../apps/api/src/git/runner.js'
import type { IndexDb } from '../apps/api/src/index-db/client.js'
import { openBookIndexDb } from '../apps/api/src/index-db/open-book.js'
import type { FetchLike } from '../apps/api/src/llm/types.js'
import { setContext } from '../apps/api/src/services/context.js'
import { finalizeChapter, unfinalizeChapter } from '../apps/api/src/services/finalize-service.js'
import { generateChapter } from '../apps/api/src/services/generate-service.js'
import {
  acceptScene,
  editSceneSeg,
  listChapterScenes,
} from '../apps/api/src/services/scene-review-service.js'
import {
  applyStateProposals,
  proposeStateChanges,
} from '../apps/api/src/services/state-proposal-service.js'
import { writeJsonElement } from '../apps/api/src/storage/elements.js'
import { createProject } from '../apps/api/src/storage/project.js'
import { reindex } from '../apps/api/src/storage/reindex.js'
import { readRevisions } from '../apps/api/src/storage/revisions.js'
import { readSceneFile } from '../apps/api/src/storage/scenes.js'
import { diffText, summarizeDiff } from '../packages/core/src/diff/chars.js'

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
剑气贴着面颊削过去。林岚左臂裂开一道口子，血顺着指缝滴。

===场景2===
裴无咎按住剑柄。他说：别逼我动手。

===场景3===
碑上刻着她自己的名字。`

const PROPOSAL_OUT = 'c1|curPhysical|左臂受伤|林岚左臂裂开一道口子，血顺着指缝滴'

/** 一个假 fetch 同时服务「生成」与「状态提案」 */
const llm: FetchLike = async (_url, init) => {
  const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
  const isProposal = body.messages[0]?.content.includes('小说编辑助手') === true
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: isProposal ? PROPOSAL_OUT : THREE_SCENES }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 3000,
        completion_tokens_details: { reasoning_tokens: 1500 },
        prompt_cache_hit_tokens: 900,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

const tmp = await mkdtemp(join(tmpdir(), 'inkloom-p1b-'))
const book = join(tmp, 'book')
let db: IndexDb | null = null
let finalRel = ''

try {
  await check('准备：建书 + 蓝图 + 生成 3 个候选场景', async () => {
    const { project } = await createProject({
      rootPath: book,
      name: 'P1B',
      genre: 'xuanhuan',
      coreIdea: '碑上刻着她自己的名字',
      theme: '名字与身份',
    })
    await initRepo(book)
    await commitAll(book, 'chore: 初始化')
    db = await openBookIndexDb(book)
    await setContext({ root: book, db, project })
    await reindex(book, db)

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

    const r = await generateChapter({ chapterNo: 4, apiKey: 'sk-fake', fetchImpl: llm })
    if (r.scenes.length !== 3) throw new Error(`应有 3 个场景，实际 ${r.scenes.length}`)
  })

  await check('★ 有 candidate 时不能定稿', async () => {
    let threw = false
    try {
      await finalizeChapter({ chapterNo: 4 })
    } catch {
      threw = true
    }
    if (!threw) throw new Error('有 candidate 时定稿应当失败')
  })

  await check('逐场景接受（3 个场景全部 accepted）', async () => {
    for (const sceneNo of [1, 2, 3]) {
      await acceptScene({ chapterNo: 4, sceneNo, version: 1 })
    }
    const rows = await listChapterScenes(4)
    if (rows.length !== 3) throw new Error(`应有 3 个场景版本，实际 ${rows.length}`)
    if (!rows.every((r) => r.status === 'accepted')) {
      throw new Error(`状态应为全 accepted，实际 ${rows.map((r) => r.status).join(',')}`)
    }
  })

  await check('★ 编辑一段 → 新版本 candidate，旧版本 rejected', async () => {
    const rows = await listChapterScenes(4)
    const first = rows.find((r) => r.sceneNo === 1)
    if (first === undefined) throw new Error('缺少场景 1')
    const scene = await readSceneFile(book, 4, 1, first.version)
    const segId = scene?.segments[0]?.segId
    if (segId === undefined) throw new Error('场景 1 没有段')

    await editSceneSeg({
      chapterNo: 4,
      sceneNo: 1,
      version: first.version,
      segId,
      newText: '剑气贴着面颊削过去。她没躲。',
    })
    const after = await listChapterScenes(4)
    const v1 = after.find((r) => r.sceneNo === 1 && r.version === first.version)
    const v2 = after.find((r) => r.sceneNo === 1 && r.version === first.version + 1)
    if (v1?.status !== 'rejected') throw new Error(`旧版本应为 rejected，实际 ${v1?.status}`)
    if (v2?.status !== 'candidate') throw new Error(`新版本应为 candidate，实际 ${v2?.status}`)
  })

  await check('★ 字符级 diff 能定位改动', async () => {
    const rows = await listChapterScenes(4)
    const vers = rows.filter((r) => r.sceneNo === 1).map((r) => r.version)
    const from = Math.min(...vers)
    const to = Math.max(...vers)
    const a = await readSceneFile(book, 4, 1, from)
    const b = await readSceneFile(book, 4, 1, to)
    if (a === null || b === null) throw new Error('版本文件缺失')
    const spans = diffText(
      a.segments.map((s) => s.text).join('\n\n'),
      b.segments.map((s) => s.text).join('\n\n'),
    )
    const s = summarizeDiff(spans)
    if (s.addedChars === 0 || s.removedChars === 0) throw new Error('diff 应同时有增删')
    if (s.similarity >= 1) throw new Error('相似度应小于 1')
  })

  await check('接受新版本 → 无 candidate → 可定稿', async () => {
    const rows = await listChapterScenes(4)
    const newest = rows.filter((r) => r.sceneNo === 1).sort((a, b) => b.version - a.version)[0]
    if (newest === undefined) throw new Error('缺少场景 1')
    await acceptScene({ chapterNo: 4, sceneNo: 1, version: newest.version })
    const all = await listChapterScenes(4)
    const candidates = all.filter((r) => r.status === 'candidate')
    if (candidates.length > 0) throw new Error(`仍有 ${candidates.length} 个 candidate`)
  })

  await check('★ 定稿：合并正文 + finalized + 蓝图摘要', async () => {
    const r = await finalizeChapter({ chapterNo: 4, title: '第四章 剑冢' })
    finalRel = r.relPath
    if (r.sceneCount !== 3) throw new Error(`应合并 3 个场景，实际 ${r.sceneCount}`)
    const raw = await readFile(join(book, r.relPath), 'utf8')
    if (!raw.includes('她没躲')) throw new Error('定稿正文里缺少编辑后的内容')
    if (!raw.includes('碑上刻着她自己的名字')) throw new Error('定稿正文缺少场景 3')
    if (!r.summary.includes('走到碑前')) throw new Error(`摘要应含蓝图目标，实际 ${r.summary}`)
    if (db === null) throw new Error('db 未初始化')
    const ch = await db.chapter.findFirst({ where: { chapterNo: 4 } })
    if (ch?.status !== 'finalized') throw new Error(`Chapter 应为 finalized，实际 ${ch?.status}`)
    if (ch.finalizedAt === null) throw new Error('finalizedAt 未写')
  })

  await check('★ 状态提案：只提案不落库，stateChapter=5', async () => {
    const r = await proposeStateChanges({ chapterNo: 4, apiKey: 'sk-fake', fetchImpl: llm })
    if (r.proposals.length !== 1) throw new Error(`应有 1 条提案，实际 ${r.proposals.length}`)
    const p = r.proposals[0]
    if (p?.stateChapter !== 5) throw new Error(`stateChapter 应为 5，实际 ${p?.stateChapter}`)
    if (p.characterId !== 'c1') throw new Error(`角色应为 c1，实际 ${p.characterId}`)
    const revs = await readRevisions(book, 'character', 'c1')
    if (revs.length !== 0) throw new Error('提案阶段不应写入 revision')
  })

  await check('★ 应用提案：写 revision（payload 扁平）+ 清 stateStale', async () => {
    const proposals = (
      await proposeStateChanges({ chapterNo: 4, apiKey: 'sk-fake', fetchImpl: llm })
    ).proposals
    const applied = await applyStateProposals({
      chapterNo: 4,
      acceptIds: proposals.map((p) => p.id),
    })
    if (applied.applied !== 1) throw new Error(`应应用 1 条，实际 ${applied.applied}`)
    const revs = await readRevisions(book, 'character', 'c1')
    if (revs.length !== 1) throw new Error(`应有 1 条 revision，实际 ${revs.length}`)
    const payload = JSON.parse(revs[0]?.payload ?? '{}') as Record<string, unknown>
    if (payload['stateChapter'] !== 5) throw new Error('revision 的 stateChapter 应为 5')
    if (payload['curPhysical'] !== '左臂受伤') {
      throw new Error(
        `revision 的 curPhysical 应为 左臂受伤，实际 ${String(payload['curPhysical'])}`,
      )
    }
    if (payload['stateStale'] !== false) throw new Error('revision 的 stateStale 应为 false')
  })

  await check('★ 撤销定稿：finalized → review，正文保留', async () => {
    await unfinalizeChapter({ chapterNo: 4 })
    if (db === null) throw new Error('db 未初始化')
    const ch = await db.chapter.findFirst({ where: { chapterNo: 4 } })
    if (ch?.status !== 'review') throw new Error(`Chapter 应为 review，实际 ${ch?.status}`)
    const raw = await readFile(join(book, finalRel), 'utf8')
    if (!raw.includes('碑上刻着她自己的名字')) throw new Error('撤销后正文应保留')
  })

  await check('Git 有多次提交（初始化/接受/编辑/定稿/撤销 ≥5）', async () => {
    const count = Number((await git(book, ['rev-list', '--count', 'HEAD'])).trim())
    if (count < 5) throw new Error(`应有 ≥5 个 commit，实际 ${count}`)
  })
} finally {
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
console.log('✓ P1-b 验收全部通过')
