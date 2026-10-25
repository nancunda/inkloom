import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { countWords, newSegId, parseChapterFile, toSegments } from '@inkloom/core'
import { blueprintSchema, InkloomError } from '@inkloom/shared'
import { commitAll, initRepo } from '../git/runner.js'
import { hashContent } from '../storage/atomic-write.js'
import { mergeChapter } from '../storage/chapters.js'
import { readJsonElement } from '../storage/elements.js'
import { emptyChapterReview, writeChapterReview } from '../storage/review-state.js'
import { listSceneDir, readSceneFile, writeSceneFile } from '../storage/scenes.js'
import { buildSummaryFromBlueprint, upsertChapterSummary } from '../storage/summaries.js'
import { getContext } from './context.js'

export interface FinalizeResult {
  relPath: string
  wordCount: number
  sceneCount: number
  summary: string
}

/** 从 filePath 反解版本号（chapters/ch-004/scenes/s1.v3.md → 3） */
function versionOf(filePath: string): number {
  return Number(/\.v(\d+)\.md$/.exec(filePath)?.[1] ?? '0')
}

/**
 * 定稿（spec §4.1 [9]）。
 *
 * 顺序：
 *   1 校验：该章不得有 candidate（逐场景确认是定稿的前提）
 *   2 取每个场景的 accepted 版本
 *   3 合并 → chapters/ch-NNN.md（保留 <!-- scene:N --> 供撤销时反解）
 *   4 Chapter.status = finalized
 *   5 摘要（Ruling 37：蓝图拼装，零 LLM）
 *   6 git commit
 *
 * ★ 幂等：重复定稿会重新合并同一批 accepted 场景，结果一致。
 */
export async function finalizeChapter(input: {
  chapterNo: number
  title?: string
}): Promise<FinalizeResult> {
  const { root, db, project } = getContext()

  // 1. 校验：不得有未确认的段
  const candidates = await db.draftSegment.count({
    where: {
      projectId: project.id,
      chapterNo: input.chapterNo,
      status: 'candidate',
      deletedAt: null,
    },
  })
  if (candidates > 0) {
    throw new InkloomError(
      'CONFLICT',
      `第 ${input.chapterNo} 章还有 ${candidates} 个段处于 candidate（未确认），不能定稿`,
    )
  }

  // 2. 取 accepted 版本
  const accepted = await db.draftSegment.findMany({
    where: {
      projectId: project.id,
      chapterNo: input.chapterNo,
      status: 'accepted',
      deletedAt: null,
    },
    orderBy: [{ sceneNo: 'asc' }, { seq: 'asc' }],
  })
  if (accepted.length === 0) {
    throw new InkloomError('CONFLICT', `第 ${input.chapterNo} 章没有已接受的场景，不能定稿`)
  }

  // 每个场景取 accepted 的那一版（Ruling 36 保证同场景只有一个 accepted）
  const picked = new Map<number, { version: number; relPath: string }>()
  for (const s of accepted) {
    if (!picked.has(s.sceneNo)) {
      picked.set(s.sceneNo, { version: versionOf(s.filePath), relPath: s.filePath })
    }
  }

  const scenes: { sceneNo: number; text: string }[] = []
  for (const [sceneNo, meta] of [...picked.entries()].sort((a, b) => a[0] - b[0])) {
    const scene = await readSceneFile(root, input.chapterNo, sceneNo, meta.version)
    if (scene === null) {
      throw new InkloomError('NOT_FOUND', `场景文件缺失：${meta.relPath}`)
    }
    scenes.push({
      sceneNo,
      text: scene.segments.map((s) => s.text).join('\n\n'),
    })
  }

  // 3. 合并正文
  const bpName = `ch-${String(input.chapterNo).padStart(3, '0')}.json`
  const bpRaw = await readJsonElement(root, `story/blueprints/${bpName}`)
  const bpParsed = bpRaw === null ? null : blueprintSchema.safeParse(bpRaw)
  const blueprint = bpParsed !== null && bpParsed.success ? bpParsed.data : null

  const title = input.title ?? blueprint?.title ?? `第 ${input.chapterNo} 章`
  const merged = await mergeChapter(root, { chapterNo: input.chapterNo, title, scenes })
  const wordCount = countWords(scenes.map((s) => s.text).join(''))

  // 4. Chapter 状态
  await db.chapter.upsert({
    where: { projectId_chapterNo: { projectId: project.id, chapterNo: input.chapterNo } },
    create: {
      id: `ch_${project.id}_${input.chapterNo}`,
      projectId: project.id,
      chapterNo: input.chapterNo,
      title,
      status: 'finalized',
      wordCount,
      finalizedAt: new Date(),
    },
    update: { title, status: 'finalized', wordCount, finalizedAt: new Date() },
  })

  // 5. 摘要（零 LLM）
  const summary = blueprint === null ? '' : buildSummaryFromBlueprint(blueprint)
  if (summary.length > 0) await upsertChapterSummary(input.chapterNo, summary)

  // 6. commit
  await initRepo(root)
  await commitAll(
    root,
    `feat(chapter): 定稿第 ${input.chapterNo} 章（${scenes.length} 场景 / ${wordCount} 字）`,
  )

  return { relPath: merged.relPath, wordCount, sceneCount: scenes.length, summary }
}

/**
 * 撤销定稿：finalized → review。
 *
 * ★ 不删正文文件：撤销只是「允许再改」，已定稿的文字仍是唯一真相。
 * ★ 不回滚已应用的状态提案：revision 是 append-only，需要时用 element rollback。
 */
export async function unfinalizeChapter(input: { chapterNo: number }): Promise<void> {
  const { root, db, project } = getContext()
  const ch = await db.chapter.findUnique({
    where: { projectId_chapterNo: { projectId: project.id, chapterNo: input.chapterNo } },
  })
  if (ch === null || ch.status !== 'finalized') {
    throw new InkloomError(
      'CONFLICT',
      `第 ${input.chapterNo} 章当前状态是 ${ch?.status ?? '不存在'}，只有 finalized 才能撤销`,
    )
  }

  // ★ 撤销定稿 = 把正文反解回场景，不是只改个状态。
  //   不反解的话，用户撤销完看不到任何场景，也就无法重写/对比——
  //   界面上只剩一句「本章还没有候选场景」。
  await restoreScenesFromChapter(root, input.chapterNo)

  await db.chapter.update({
    where: { id: ch.id },
    data: { status: 'review', finalizedAt: null },
  })
  await initRepo(root)
  await commitAll(root, `chore(chapter): 撤销定稿第 ${input.chapterNo} 章（正文已反解为场景）`)
}

/**
 * 从 ch-NNN.md 反解出场景与段，写回 scenes/ 并删掉正文文件。
 *
 * ★ 必须删正文：reindex 把「有 ch-NNN.md」等同于「已定稿」，
 *   留着它会让下一次重建把章节又变回 finalized，撤销定稿形同虚设。
 * ★ 段 ID 重新分配（定稿正文里本来就不带段标记）：从全书已用段 ID
 *   里避开，保持「全书唯一、永不复用」的约定。
 */
async function restoreScenesFromChapter(root: string, chapterNo: number): Promise<void> {
  const rel = `chapters/ch-${String(chapterNo).padStart(3, '0')}.md`
  const raw = await readFile(join(root, rel), 'utf8').catch(() => null)
  if (raw === null) return // 正文已不在：只改状态，不假装恢复了什么

  const parsed = parseChapterFile(raw)
  const { db, project } = getContext()

  // 已有段 ID 全集：新分配的 ID 不能与它们撞
  const existing = await db.draftSegment.findMany({
    where: { projectId: project.id },
    select: { segId: true, chapterNo: true, sceneNo: true, filePath: true },
  })
  const taken = new Set(existing.map((s) => s.segId))

  // 已有场景文件的最大版本号：避免覆盖定稿前留下的旧候选稿
  const names = await listSceneDir(root, chapterNo)
  const maxVersionOf = (sceneNo: number): number => {
    let max = 0
    for (const name of names) {
      const m = /^s(\d+)\.v(\d+)\.md$/.exec(name)
      if (m?.[1] !== undefined && m[2] !== undefined && Number(m[1]) === sceneNo) {
        max = Math.max(max, Number(m[2]))
      }
    }
    return max
  }

  for (const scene of parsed.scenes) {
    const version = maxVersionOf(scene.sceneNo) + 1
    const segments = toSegments(scene.text).map((text) => {
      const segId = newSegId(Math.random, taken)
      taken.add(segId)
      return { segId, text }
    })
    if (segments.length === 0) continue

    const written = await writeSceneFile(
      root,
      { sceneNo: scene.sceneNo, version, segments },
      chapterNo,
    )
    await db.draftSegment.createMany({
      data: segments.map((s, seq) => ({
        id: `seg_${chapterNo}_${scene.sceneNo}_${version}_${s.segId}`,
        projectId: project.id,
        chapterNo,
        sceneNo: scene.sceneNo,
        segId: s.segId,
        seq,
        filePath: written.relPath,
        contentHash: hashContent(s.text),
        wordCount: countWords(s.text),
        status: 'candidate',
      })),
    })
  }

  // 旧的审阅状态属于已定稿的那一版，反解后从 candidate 重新开始
  await writeChapterReview(root, emptyChapterReview(chapterNo))
  await rm(join(root, rel), { force: true })
}
