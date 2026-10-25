import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { bookPaths } from './paths.js'

/**
 * 场景审阅状态的**文件真相**（Ruling 47）。
 *
 * ★ 为什么必须落文件：spec §3.9 把 candidate/accepted/rejected 放在 DraftSegment，
 *   而 §2.2 又说索引可随时删除重建。两者直接冲突——实测 `inkloom reindex` 之后
 *   已定稿的第 4 章变成「finalized 但有 4 个场景待确认」，用户看到的界面是自相矛盾的。
 *   「接受了哪一版」是**决策**，不是缓存，必须能从事后重建的索引里活下来。
 *
 * ★ 为什么放章节目录下而不是 .inkloom：跟着章节走，`cp -r` 拷走一章就能拷走审阅状态；
 *   .inkloom 里混着 index.sqlite 这种真的可丢弃的缓存，容易被人手滑删掉。
 */
export interface SceneReviewState {
  /** 被接受的版本号；null 表示尚未接受任何版本 */
  acceptedVersion: number | null
  /** 被显式拒绝的版本号（升序，去重） */
  rejectedVersions: number[]
  /** 接受时刻（ISO）；重新接受会刷新 */
  acceptedAt: string | null
}

export interface ChapterReviewState {
  chapterNo: number
  /** key 是场景号（字符串，JSON 对象键） */
  scenes: Record<string, SceneReviewState>
}

export function reviewFilePath(root: string, chapterNo: number): string {
  const dir = join(bookPaths(root).chapters, `ch-${String(chapterNo).padStart(3, '0')}`)
  return join(dir, 'review.json')
}

export function emptyChapterReview(chapterNo: number): ChapterReviewState {
  return { chapterNo, scenes: {} }
}

/**
 * 读审阅状态。文件不存在返回空状态（不是错误——没审阅过的章本来就没有这个文件）。
 *
 * ★ JSON 坏了直接抛错而不是静默返回空：静默返回空会把「文件被写坏」显示成
 *   「什么都没接受过」，用户会重新接受一遍，掩盖真正的问题。
 */
export async function readChapterReview(
  root: string,
  chapterNo: number,
): Promise<ChapterReviewState> {
  const path = reviewFilePath(root, chapterNo)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyChapterReview(chapterNo)
    throw e
  }
  const parsed = JSON.parse(raw) as ChapterReviewState
  return { chapterNo, scenes: parsed.scenes ?? {} }
}

export async function writeChapterReview(root: string, state: ChapterReviewState): Promise<void> {
  const path = reviewFilePath(root, state.chapterNo)
  await mkdir(dirname(path), { recursive: true })
  // 末行换行 + 2 空格缩进：这份文件会进 git，要人能读、diff 能看
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function ensureScene(state: ChapterReviewState, sceneNo: number): SceneReviewState {
  const key = String(sceneNo)
  const existing = state.scenes[key]
  if (existing !== undefined) return existing
  const fresh: SceneReviewState = { acceptedVersion: null, rejectedVersions: [], acceptedAt: null }
  state.scenes[key] = fresh
  return fresh
}

/**
 * 接受某版本：同场景其他版本自动从 rejected 名单里清掉该版本，并把它记为 accepted。
 *
 * ★ 不接受「多个 accepted」：定稿只能合并一个版本（Ruling 36），
 *   文件里也只存一个 acceptedVersion，结构上就禁止了歧义。
 */
export async function markAccepted(
  root: string,
  chapterNo: number,
  sceneNo: number,
  version: number,
): Promise<void> {
  const state = await readChapterReview(root, chapterNo)
  const scene = ensureScene(state, sceneNo)
  scene.acceptedVersion = version
  scene.rejectedVersions = scene.rejectedVersions.filter((v) => v !== version).sort((a, b) => a - b)
  scene.acceptedAt = new Date().toISOString()
  await writeChapterReview(root, state)
}

/** 拒绝某版本：记入名单；若它正是 accepted，则清空 accepted（不能既接受又拒绝） */
export async function markRejected(
  root: string,
  chapterNo: number,
  sceneNo: number,
  version: number,
): Promise<void> {
  const state = await readChapterReview(root, chapterNo)
  const scene = ensureScene(state, sceneNo)
  if (!scene.rejectedVersions.includes(version)) scene.rejectedVersions.push(version)
  scene.rejectedVersions.sort((a, b) => a - b)
  if (scene.acceptedVersion === version) {
    scene.acceptedVersion = null
    scene.acceptedAt = null
  }
  await writeChapterReview(root, state)
}
