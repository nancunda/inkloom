import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { countWords } from '@inkloom/core'
import { getContext } from '../services/context.js'
import { readIfExists } from '../storage/atomic-write.js'
import { bookPaths } from '../storage/paths.js'
import { latestSceneVersion, listSceneNos, readSceneFile, sceneRelPath } from '../storage/scenes.js'

/**
 * Agent 的「一次看全」快照。
 *
 * ★ 为什么不是一个个 read_element：agent 每多一次工具往返，就多一次
 *   上下文漂移与 token 成本；搭世界时需要同时看角色、规则、卷、蓝图。
 * ★ 只读文件，不读 SQLite：文件是真相，索引可能落后（尤其回退之后）。
 */
export interface SceneSummary {
  sceneNo: number
  latestVersion: number
  chars: number
  /** 最新候选稿的相对路径（chapters/ch-004/scenes/s1.v2.md） */
  file: string | null
}

/**
 * 一章的磁盘状态。
 *
 * ★ 不能只读 SQLite 的 Chapter 表：第 1 章刚生成、还没定稿时，
 *   `chapters/ch-001/scenes/sN.vM.md` 已经存在，而表里没有行。
 *   Agent 只看表会得出「一个字都没写」，E2E 里真实发生过。
 */
export interface ChapterSummary {
  chapterNo: number
  title: string | null
  status: string
  wordCount: number
  /** 定稿文件相对路径（chapters/ch-004.md）；只有候选场景时为 null。★ 给路径而不是让模型猜文件名 */
  file: string | null
  scenes: SceneSummary[]
}

export interface BookSnapshot {
  book: Record<string, unknown> | null
  characters: unknown
  relations: unknown
  signatures: unknown
  world: {
    rules: unknown
    powerSystem: unknown
    locations: unknown
    routes: unknown
  }
  story: {
    arcs: unknown
    blueprints: unknown[]
  }
  chapters: ChapterSummary[]
}

async function readJson(root: string, rel: string): Promise<unknown> {
  const raw = await readIfExists(join(root, rel))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

async function readObject(root: string, rel: string): Promise<Record<string, unknown> | null> {
  const v = await readJson(root, rel)
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

async function readBlueprints(root: string): Promise<unknown[]> {
  const dir = join(root, 'story', 'blueprints')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const v = await readJson(root, `story/blueprints/${name}`)
    if (v !== null) out.push(v)
  }
  return out
}

/** 扫描 chapters/ 目录：定稿 ch-NNN.md + 候选 scenes/sN.vM.md（文件是真相） */
export async function readChapters(root: string): Promise<ChapterSummary[]> {
  const dir = join(root, 'chapters')
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const byNo = new Map<number, ChapterSummary>()

  // 定稿：chapters/ch-001.md（首行一级标题即章名）
  for (const e of entries) {
    if (!e.isFile()) continue
    const m = /^ch-(\d+)\.md$/.exec(e.name)
    if (m?.[1] === undefined) continue
    const chapterNo = Number(m[1])
    const raw = (await readIfExists(join(dir, e.name))) ?? ''
    byNo.set(chapterNo, {
      chapterNo,
      title: /^#\s+(.+?)\s*$/m.exec(raw)?.[1] ?? null,
      status: 'finalized',
      wordCount: countWords(raw),
      file: `chapters/${e.name}`,
      scenes: [],
    })
  }

  // 候选：chapters/ch-001/scenes/sN.vM.md，每场取最大版本
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const m = /^ch-(\d+)$/.exec(e.name)
    if (m?.[1] === undefined) continue
    const chapterNo = Number(m[1])
    const scenes: SceneSummary[] = []
    for (const sceneNo of await listSceneNos(root, chapterNo)) {
      const version = await latestSceneVersion(root, chapterNo, sceneNo)
      if (version === null) continue
      const file = await readSceneFile(root, chapterNo, sceneNo, version)
      const chars = file === null ? 0 : countWords(file.segments.map((s) => s.text).join(''))
      scenes.push({
        sceneNo,
        latestVersion: version,
        chars,
        file: sceneRelPath(chapterNo, sceneNo, version),
      })
    }
    if (scenes.length === 0) continue
    const existing = byNo.get(chapterNo)
    byNo.set(chapterNo, {
      chapterNo,
      title: existing?.title ?? null,
      status: existing?.status ?? 'draft',
      wordCount: existing?.wordCount ?? scenes.reduce((n, s) => n + s.chars, 0),
      file: existing?.file ?? null,
      scenes,
    })
  }

  return [...byNo.values()].sort((a, b) => a.chapterNo - b.chapterNo)
}

export async function buildBookSnapshot(): Promise<BookSnapshot> {
  const { root } = getContext()

  return {
    book: await readObject(root, 'novel.json'),
    characters: await readJson(root, 'characters/index.json'),
    relations: await readJson(root, 'characters/relations.json'),
    signatures: await readJson(root, 'characters/signatures.json'),
    world: {
      rules: await readJson(root, 'world/rules.json'),
      powerSystem: await readJson(root, 'world/power-system.json'),
      locations: await readJson(root, 'world/locations.json'),
      routes: await readJson(root, 'world/routes.json'),
    },
    story: {
      arcs: await readJson(root, 'story/arcs.json'),
      blueprints: await readBlueprints(root),
    },
    chapters: await readChapters(root),
  }
}

/** 生成文字快照时截断，避免一次工具结果把上下文撑爆 */
export function renderSnapshot(snapshot: BookSnapshot, maxChars = 40_000): string {
  const text = JSON.stringify(snapshot, null, 2)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n…（已截断，共 ${text.length} 字符；需要细节请用 read_element）`
}

/** agent 日志放 .inkloom/agent/runs，和生成 run 的 .inkloom/runs 分开 */
export function agentRunDir(root: string): string {
  return join(bookPaths(root).inkloom, 'agent', 'runs')
}
