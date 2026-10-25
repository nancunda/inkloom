import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readIfExists } from '../storage/atomic-write.js'
import { readJsonElement } from '../storage/elements.js'
import { bookPaths } from '../storage/paths.js'
import { readAllRevisionFiles } from '../storage/revisions.js'

export type ExportFormat = 'json' | 'md' | 'txt'

export interface ExportResult {
  content: string
  filename: string
  mime: string
}

const ELEMENT_FILES = [
  'characters/index.json',
  'characters/relations.json',
  'characters/signatures.json',
  'world/rules.json',
  'world/locations.json',
  'world/routes.json',
  'story/arcs.json',
  'story/threads.json',
  'story/techniques.json',
  'styles/default.json',
]

async function listSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function collectJson(root: string): Promise<string> {
  const novel = await readJsonElement(root, 'novel.json')

  const elements: Record<string, unknown> = {}
  for (const rel of ELEMENT_FILES) {
    const v = await readJsonElement(root, rel)
    if (v !== null) elements[rel] = v
  }

  const blueprints: Record<string, unknown> = {}
  for (const name of await listSafe(join(bookPaths(root).story, 'blueprints'))) {
    if (!name.endsWith('.json')) continue
    const v = await readJsonElement(root, `story/blueprints/${name}`)
    if (v !== null) blueprints[name] = v
  }

  const revisions: Record<string, unknown[]> = {}
  for (const rel of await readAllRevisionFiles(root)) {
    const raw = await readIfExists(join(root, rel))
    if (raw === null) continue
    revisions[rel] = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as unknown]
        } catch {
          return []
        }
      })
  }

  const chapters: Record<string, string> = {}
  for (const name of await listSafe(bookPaths(root).chapters)) {
    if (!/^ch-\d+\.md$/.test(name)) continue
    const raw = await readIfExists(join(bookPaths(root).chapters, name))
    if (raw !== null) chapters[name] = raw
  }

  // 注意：不导出 .inkloom/index.sqlite —— 索引是派生物，不是数据
  return `${JSON.stringify({ project: novel, elements, blueprints, chapters, revisions }, null, 2)}\n`
}

async function collectMarkdown(root: string): Promise<string> {
  const novel = await readJsonElement(root, 'novel.json')
  const name = (novel as { name?: string } | null)?.name ?? '未命名'
  const parts: string[] = [`# ${name}\n`]
  const names = (await listSafe(bookPaths(root).chapters))
    .filter((n) => /^ch-\d+\.md$/.test(n))
    .sort()
  for (const n of names) {
    const raw = await readIfExists(join(bookPaths(root).chapters, n))
    if (raw !== null) parts.push(raw.trim(), '\n')
  }
  return parts.join('\n')
}

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const MD_HEADING_RE = /^#{1,6}\s+/gm

function toPlainText(markdown: string): string {
  return `${markdown
    .replace(HTML_COMMENT_RE, '')
    .replace(MD_HEADING_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`
}

/**
 * 导出（P0-12）：
 *   json → 整书（元数据 + 全部要素 + 蓝图 + 章节原文 + 全部要素历史）
 *   md   → 正文合并为单文件（保留场景边界注释）
 *   txt  → 纯文本（去 Markdown 标记与 HTML 注释）
 */
export async function exportBook(format: ExportFormat, root: string): Promise<ExportResult> {
  const novel = await readJsonElement(root, 'novel.json')
  const name = (novel as { name?: string } | null)?.name ?? '未命名'

  if (format === 'json') {
    return { content: await collectJson(root), filename: `${name}.json`, mime: 'application/json' }
  }
  const md = await collectMarkdown(root)
  if (format === 'md') {
    return { content: md, filename: `${name}.md`, mime: 'text/markdown' }
  }
  return { content: toPlainText(md), filename: `${name}.txt`, mime: 'text/plain' }
}
