import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { collectSegIds, parseSceneFile, type SceneFile, serializeSceneFile } from '@inkloom/core'
import { atomicWrite, readIfExists } from './atomic-write.js'

const pad3 = (n: number): string => String(n).padStart(3, '0')

/** 候选稿路径（§2.7 一）。章号补 3 位，场景号与版本号不补 */
export function sceneRelPath(chapterNo: number, sceneNo: number, version: number): string {
  return `chapters/ch-${pad3(chapterNo)}/scenes/s${sceneNo}.v${version}.md`
}

/**
 * 写一个场景版本。
 * ★ 永远写新文件，**绝不覆盖旧版本**——回退依赖旧版本存在。
 */
export async function writeSceneFile(
  root: string,
  scene: SceneFile,
  chapterNo: number,
): Promise<{ relPath: string; newHash: string }> {
  const relPath = sceneRelPath(chapterNo, scene.sceneNo, scene.version)
  const abs = join(root, relPath)
  await mkdir(dirname(abs), { recursive: true })
  const { newHash } = await atomicWrite(abs, serializeSceneFile(scene))
  return { relPath, newHash }
}

export async function readSceneFile(
  root: string,
  chapterNo: number,
  sceneNo: number,
  version: number,
): Promise<SceneFile | null> {
  const raw = await readIfExists(join(root, sceneRelPath(chapterNo, sceneNo, version)))
  return raw === null ? null : parseSceneFile(raw)
}

/** 某章 scenes 目录下的全部文件名（不存在返回空） */
export async function listSceneDir(root: string, chapterNo: number): Promise<string[]> {
  const dir = join(root, 'chapters', `ch-${pad3(chapterNo)}`, 'scenes')
  try {
    return await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/** 某场景的全部版本号，升序 */
export async function listSceneVersions(
  root: string,
  chapterNo: number,
  sceneNo: number,
): Promise<number[]> {
  const re = new RegExp(`^s${sceneNo}\\.v(\\d+)\\.md$`)
  const versions: number[] = []
  for (const f of await listSceneDir(root, chapterNo)) {
    const m = re.exec(f)
    if (m?.[1] !== undefined) versions.push(Number(m[1]))
  }
  return versions.sort((a, b) => a - b)
}

export async function latestSceneVersion(
  root: string,
  chapterNo: number,
  sceneNo: number,
): Promise<number | null> {
  const vs = await listSceneVersions(root, chapterNo, sceneNo)
  return vs.length === 0 ? null : (vs[vs.length - 1] as number)
}

/** 某章出现过的全部场景号，升序 */
export async function listSceneNos(root: string, chapterNo: number): Promise<number[]> {
  const nos = new Set<number>()
  for (const f of await listSceneDir(root, chapterNo)) {
    const m = /^s(\d+)\.v\d+\.md$/.exec(f)
    if (m?.[1] !== undefined) nos.add(Number(m[1]))
  }
  return [...nos].sort((a, b) => a - b)
}

/**
 * 读出某章全部历史版本里的段 ID（含已删除的段）。
 *
 * ★ 为什么必须传全部历史而不是只传最新版本：
 * §2.7 要求段 ID「全书唯一且永不复用」。只统计活文件会让被删段的 ID 重新流入，
 * 单段回退时就会把「另一段」的历史文本回退进来，而且没有任何报错。
 * 历史文件（旧版本）就是墓碑，不需要单独的墓碑表。
 */
export async function collectChapterSegIds(root: string, chapterNo: number): Promise<Set<string>> {
  const scenes: SceneFile[] = []
  for (const fileName of await listSceneDir(root, chapterNo)) {
    if (!/^s\d+\.v\d+\.md$/.test(fileName)) continue
    const rel = `chapters/ch-${pad3(chapterNo)}/scenes/${fileName}`
    const raw = await readIfExists(join(root, rel))
    if (raw === null) continue
    try {
      scenes.push(parseSceneFile(raw))
    } catch {
      // 损坏的历史文件不影响 ID 收集（跳过即可，不阻塞反解）
    }
  }
  return collectSegIds(scenes)
}
