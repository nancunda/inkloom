import { countWords } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import { commitAll, initRepo } from '../git/runner.js'
import { hashContent } from '../storage/atomic-write.js'
import { markAccepted, markRejected } from '../storage/review-state.js'
import { readSceneFile, writeSceneFile } from '../storage/scenes.js'
import { getContext } from './context.js'

export interface SceneRow {
  sceneNo: number
  version: number
  relPath: string
  wordCount: number
  segCount: number
  /** 该版本里所有段的状态；混合时取最保守的（有 candidate 就是 candidate） */
  status: 'candidate' | 'accepted' | 'rejected'
  acceptedAt: Date | null
}

export interface AcceptSceneInput {
  chapterNo: number
  sceneNo: number
  version: number
}

export interface EditSceneSegInput extends AcceptSceneInput {
  segId: string
  newText: string
}

/** 从 filePath 反解版本号（chapters/ch-004/scenes/s1.v3.md → 3） */
function versionOf(filePath: string): number {
  return Number(/\.v(\d+)\.md$/.exec(filePath)?.[1] ?? '0')
}

/**
 * 状态保守度：有 candidate 就算 candidate，否则有 rejected 算 rejected，全 accepted 才 accepted。
 * ★ 为什么取最保守：只要有一个段没确认，这个场景就还没确认完；
 *   把"部分 accepted"报成 accepted 会让用户以为可以定稿。
 */
function aggregateStatus(statuses: string[]): SceneRow['status'] {
  if (statuses.includes('candidate')) return 'candidate'
  if (statuses.includes('rejected')) return 'rejected'
  return 'accepted'
}

/** 列出某章所有场景版本（按 sceneNo → version 升序） */
export async function listChapterScenes(chapterNo: number): Promise<SceneRow[]> {
  const { db, project } = getContext()
  const segs = await db.draftSegment.findMany({
    where: { projectId: project.id, chapterNo, deletedAt: null },
    orderBy: [{ sceneNo: 'asc' }, { seq: 'asc' }],
  })

  const byFile = new Map<string, typeof segs>()
  for (const s of segs) {
    const list = byFile.get(s.filePath) ?? []
    list.push(s)
    byFile.set(s.filePath, list)
  }

  const rows: SceneRow[] = []
  for (const [filePath, list] of byFile) {
    const first = list[0]
    if (first === undefined) continue
    rows.push({
      sceneNo: first.sceneNo,
      version: versionOf(filePath),
      relPath: filePath,
      segCount: list.length,
      wordCount: list.reduce((n, s) => n + (s.wordCount ?? 0), 0),
      status: aggregateStatus(list.map((s) => s.status)),
      acceptedAt: list.find((s) => s.acceptedAt !== null)?.acceptedAt ?? null,
    })
  }
  return rows.sort((a, b) => a.sceneNo - b.sceneNo || a.version - b.version)
}

/** 校验某个场景版本存在，返回它的文件路径 */
async function assertVersionExists(input: AcceptSceneInput): Promise<string> {
  const { db, project } = getContext()
  const rows = await db.draftSegment.findMany({
    where: { projectId: project.id, chapterNo: input.chapterNo, sceneNo: input.sceneNo },
    select: { filePath: true },
  })
  const relPath = rows.find((r) => versionOf(r.filePath) === input.version)?.filePath
  if (relPath === undefined) {
    throw new InkloomError(
      'NOT_FOUND',
      `第 ${input.chapterNo} 章场景 ${input.sceneNo} 没有 v${input.version}`,
    )
  }
  return relPath
}

/**
 * 接受某个场景版本（spec §4.1 [8]）。
 *
 * ★ 同场景其他 accepted 版本自动降为 rejected（Ruling 36）：
 *   定稿只能把「一个版本」合并进正文文件，允许多个 accepted 会让定稿产生歧义。
 * ★ 不写 EntityRevision：正文历史归 Git（ADR-27）。
 * ★ 文件内容不变，但要写 `chapters/ch-NNN/review.json`（Ruling 47）：
 *   「接受了哪一版」是决策而不是缓存，索引重建后必须还在。
 */
export async function acceptScene(input: AcceptSceneInput): Promise<{ relPath: string }> {
  const { root, db, project } = getContext()
  const relPath = await assertVersionExists(input)

  await db.$transaction(async (tx) => {
    await tx.draftSegment.updateMany({
      where: {
        projectId: project.id,
        chapterNo: input.chapterNo,
        sceneNo: input.sceneNo,
        filePath: { not: relPath },
        status: 'accepted',
      },
      data: { status: 'rejected' },
    })
    await tx.draftSegment.updateMany({
      where: {
        projectId: project.id,
        chapterNo: input.chapterNo,
        sceneNo: input.sceneNo,
        filePath: relPath,
      },
      data: { status: 'accepted', acceptedAt: new Date() },
    })
  })

  // 先落文件真相，再提交：反过来的话 commit 里会有一份「没有 accepted 记录」的 review.json
  await markAccepted(root, input.chapterNo, input.sceneNo, input.version)

  await initRepo(root)
  await commitAll(
    root,
    `feat(scene): 接受第 ${input.chapterNo} 章场景 ${input.sceneNo} v${input.version}`,
  )
  return { relPath }
}

/** 拒绝某个版本：只改状态，不删文件（保留作对照，且可再接受） */
export async function rejectScene(input: AcceptSceneInput): Promise<void> {
  const { root, db, project } = getContext()
  const relPath = await assertVersionExists(input)
  await db.draftSegment.updateMany({
    where: {
      projectId: project.id,
      chapterNo: input.chapterNo,
      sceneNo: input.sceneNo,
      filePath: relPath,
    },
    data: { status: 'rejected', acceptedAt: null },
  })
  await markRejected(root, input.chapterNo, input.sceneNo, input.version)
  await initRepo(root)
  await commitAll(
    root,
    `chore(scene): 拒绝第 ${input.chapterNo} 章场景 ${input.sceneNo} v${input.version}`,
  )
}

/**
 * 编辑某版本里的一段，产出新版本。
 *
 * ★ segId 保持不变：段身份是 segId（全书唯一、永不复用），不是位置。
 *   换新 segId 会让之前的单段回退记录找不到这个段。
 * ★ 旧版本整版标 rejected：编辑等于「基于 vN 改出一版」，vN 不再是候选。
 * ★ 不接受空文本：把段改空等于删除内容，应该走 reject 或明确的新文本。
 */
export async function editSceneSeg(
  input: EditSceneSegInput,
): Promise<{ newVersion: number; relPath: string }> {
  const { root, db, project } = getContext()
  const text = input.newText.trim()
  if (text.length === 0) {
    throw new InkloomError('INVALID_INPUT', '段文本不能为空（不允许把段改空，请改用 reject）')
  }

  const relPath = await assertVersionExists(input)
  const scene = await readSceneFile(root, input.chapterNo, input.sceneNo, input.version)
  if (scene === null) {
    throw new InkloomError(
      'NOT_FOUND',
      `第 ${input.chapterNo} 章场景 ${input.sceneNo} v${input.version} 的文件不存在`,
    )
  }
  const idx = scene.segments.findIndex((s) => s.segId === input.segId)
  if (idx < 0) {
    throw new InkloomError('NOT_FOUND', `${relPath} 里没有段 ${input.segId}`)
  }

  const nextSegments = scene.segments.map((s, i) => (i === idx ? { segId: s.segId, text } : s))
  const newVersion = scene.version + 1
  const written = await writeSceneFile(
    root,
    { sceneNo: input.sceneNo, version: newVersion, segments: nextSegments },
    input.chapterNo,
  )

  await db.$transaction(async (tx) => {
    await tx.draftSegment.updateMany({
      where: {
        projectId: project.id,
        chapterNo: input.chapterNo,
        sceneNo: input.sceneNo,
        filePath: relPath,
      },
      data: { status: 'rejected', acceptedAt: null },
    })
    await tx.draftSegment.createMany({
      data: nextSegments.map((s, seq) => ({
        id: `seg_${input.chapterNo}_${input.sceneNo}_${newVersion}_${s.segId}`,
        projectId: project.id,
        chapterNo: input.chapterNo,
        sceneNo: input.sceneNo,
        segId: s.segId,
        seq,
        filePath: written.relPath,
        // ★ 每段自己的 hash，不是整场景文件的 hash
        contentHash: hashContent(s.text),
        wordCount: countWords(s.text),
        status: 'candidate',
      })),
    })
  })

  // 被编辑的旧版本等于被拒绝（内容已被新版本取代），同步进 review.json
  await markRejected(root, input.chapterNo, input.sceneNo, input.version)

  await initRepo(root)
  await commitAll(
    root,
    `feat(scene): 编辑第 ${input.chapterNo} 章场景 ${input.sceneNo} 段 ${input.segId} → v${newVersion}`,
  )
  return { newVersion, relPath: written.relPath }
}
