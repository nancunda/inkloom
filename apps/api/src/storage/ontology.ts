import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type ClassesFile,
  classesFileSchema,
  type GraphEdge,
  graphEdgeSchema,
  type OntologyNode,
  ontologyNodeSchema,
} from '@inkloom/shared'
import { readIfExists } from './atomic-write.js'
import { bookPaths, relativeToBook } from './paths.js'

export interface OntologyFiles {
  classesFile: ClassesFile | null
  nodes: OntologyNode[]
  edges: GraphEdge[]
  warnings: string[]
  /** 全部输入（含 watchFiles）的 POSIX 相对路径；不存在的文件也会列出 */
  files: string[]
  mtimeMax: number
  /** 逐文件 mtime 拼接的签名：单值 max 表达不了「删文件/新增更旧文件」 */
  signature: string
}

export function ontologyDir(root: string): string {
  return join(bookPaths(root).world, 'ontology')
}

async function mtimeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }
}

interface Parser<T> {
  safeParse: (v: unknown) => { success: true; data: T } | { success: false }
}

async function readJsonl<T>(
  file: string,
  rel: string,
  schema: Parser<T>,
  warnings: string[],
): Promise<T[]> {
  const raw = await readIfExists(file)
  if (raw === null) return []
  const out: T[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim()
    if (line.length === 0) continue
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      warnings.push(`${rel} 第 ${i + 1} 行不是合法 JSON，已跳过`)
      continue
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      warnings.push(`${rel} 第 ${i + 1} 行不符合 schema，已跳过`)
      continue
    }
    out.push(parsed.data)
  }
  return out
}

/**
 * 读图谱三件套。
 * ★ 所有文件都可缺失（老书没有任何 ontology 文件是正常状态）。
 * ★ watchFiles 是实体文件：它们变了，虚拟节点/边就变了，缓存必须失效。
 */
export async function readOntologyFiles(
  root: string,
  watchFiles: string[] = [],
): Promise<OntologyFiles> {
  const dir = ontologyDir(root)
  const classesPath = join(dir, 'classes.json')
  const nodesPath = join(dir, 'nodes.jsonl')
  const edgesPath = join(dir, 'edges.jsonl')
  const warnings: string[] = []

  // ★ 先取 mtime 再读内容：反过来会出现「旧内容 + 新 mtime」的缓存键，
  //   之后一直命中缓存，图永远陈旧
  const paths = [classesPath, nodesPath, edgesPath, ...watchFiles]
  const mtimes = await Promise.all(paths.map(mtimeOf))

  let classesFile: ClassesFile | null = null
  const rawClasses = await readIfExists(classesPath)
  if (rawClasses !== null) {
    // BOM 不是 JSON 空白，Windows 编辑器很常见；纯空白文件当缺失，不报假 warning
    const text = rawClasses.replace(/^\uFEFF/, '')
    if (text.trim().length > 0) {
      try {
        const parsed = classesFileSchema.safeParse(JSON.parse(text))
        if (parsed.success) classesFile = parsed.data
        else warnings.push('world/ontology/classes.json 不符合 schema，已忽略')
      } catch {
        warnings.push('world/ontology/classes.json 不是合法 JSON，已忽略')
      }
    }
  }

  const nodes = await readJsonl(
    nodesPath,
    'world/ontology/nodes.jsonl',
    ontologyNodeSchema,
    warnings,
  )
  const edges = await readJsonl(edgesPath, 'world/ontology/edges.jsonl', graphEdgeSchema, warnings)

  return {
    classesFile,
    nodes,
    edges,
    warnings,
    files: paths.map((p) => relativeToBook(root, p)),
    mtimeMax: Math.max(0, ...mtimes),
    signature: mtimes.map((m) => String(m)).join(':'),
  }
}
