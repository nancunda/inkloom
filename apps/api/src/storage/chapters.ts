import { join } from 'node:path'
import {
  newSegId,
  parseChapterFile,
  type SceneFile,
  serializeChapterFile,
  splitParagraphs,
} from '@inkloom/core'
import { atomicWrite, readIfExists } from './atomic-write.js'
import { collectChapterSegIds, latestSceneVersion, listSceneNos, readSceneFile } from './scenes.js'

const pad3 = (n: number): string => String(n).padStart(3, '0')

export function chapterRelPath(chapterNo: number): string {
  return `chapters/ch-${pad3(chapterNo)}.md`
}

export interface MergeInput {
  chapterNo: number
  title: string
  scenes: { sceneNo: number; text: string }[]
}

/**
 * 定稿合并（§2.7 二）。
 *
 * 输入是「已接受的场景正文」（不含段标记），输出是干净的定稿文件。
 * 场景边界用 `<!-- scene:N -->` 保留——它是撤销定稿时反解的唯一依据。
 */
export async function mergeChapter(
  root: string,
  input: MergeInput,
): Promise<{ relPath: string; newHash: string }> {
  const relPath = chapterRelPath(input.chapterNo)
  const content = serializeChapterFile({
    title: input.title,
    scenes: input.scenes
      .filter((s) => s.text.trim().length > 0)
      .map((s) => ({ sceneNo: s.sceneNo, text: s.text })),
  })
  const { newHash } = await atomicWrite(join(root, relPath), content)
  return { relPath, newHash }
}

/**
 * 撤销定稿的反解（§2.7 三）。
 *
 * 语义：读 ch-NNN.md → 按场景边界切分 → 每场景重建一个 SceneFile。
 *
 * ★ 段 ID 是新分配的：定稿文件本来就不含段标记，旧 ID 已随定稿丢弃。
 *   这是**有意的代价**——正文一字节不丢，但旧的段级回退记录会失效。
 * ★ 新 ID 必须与该章**全部历史版本**里的 ID 查重（collectChapterSegIds），
 *   否则会复用被删段的 ID，导致后续单段回退取错文本。
 * ★ version = 该场景已有最新版本 + 1，保证不覆盖历史候选稿。
 */
export async function splitChapter(
  root: string,
  chapterNo: number,
): Promise<{ chapterNo: number; title: string; scenes: SceneFile[] } | null> {
  const raw = await readIfExists(join(root, chapterRelPath(chapterNo)))
  if (raw === null) return null

  const parsed = parseChapterFile(raw)
  const taken = await collectChapterSegIds(root, chapterNo)

  const scenes: SceneFile[] = []
  for (const s of parsed.scenes) {
    const paragraphs = splitParagraphs(s.text)
    if (paragraphs.length === 0) continue
    const latest = await latestSceneVersion(root, chapterNo, s.sceneNo)
    const segments = paragraphs.map((text) => {
      const segId = newSegId(Math.random, taken)
      taken.add(segId)
      return { segId, text }
    })
    scenes.push({ sceneNo: s.sceneNo, version: (latest ?? 0) + 1, segments })
  }

  return { chapterNo, title: parsed.title, scenes }
}

/**
 * 汇总某章所有场景的最新版本，拼成定稿所需的输入。
 * 这是 finalizeChapter 的前半段（纯存储层，不含 Git）。
 */
export async function collectChapterScenes(
  root: string,
  chapterNo: number,
): Promise<{ sceneNo: number; text: string }[]> {
  const out: { sceneNo: number; text: string }[] = []
  for (const sceneNo of await listSceneNos(root, chapterNo)) {
    const v = await latestSceneVersion(root, chapterNo, sceneNo)
    if (v === null) continue
    const scene = await readSceneFile(root, chapterNo, sceneNo, v)
    if (scene === null) continue
    const text = scene.segments
      .map((seg) => seg.text)
      .filter((t) => t.trim().length > 0)
      .join('\n\n')
    out.push({ sceneNo, text })
  }
  return out
}
