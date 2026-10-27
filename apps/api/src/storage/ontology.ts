import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  type ClassesFile,
  classesFileSchema,
  type GraphEdge,
  graphEdgeSchema,
  type OntologyNode,
  ontologyNodeSchema,
} from '@inkloom/shared'
import { readIfExists } from './atomic-write.js'
import { bookPaths } from './paths.js'

export interface OntologyFiles {
  classesFile: ClassesFile | null
  nodes: OntologyNode[]
  edges: GraphEdge[]
  warnings: string[]
  files: string[]
  mtimeMax: number
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
  safeParse: (v: unknown) => { success: boolean; data?: T }
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
    if (!parsed.success || parsed.data === undefined) {
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

  let classesFile: ClassesFile | null = null
  const rawClasses = await readIfExists(classesPath)
  if (rawClasses !== null) {
    try {
      const parsed = classesFileSchema.safeParse(JSON.parse(rawClasses))
      if (parsed.success) classesFile = parsed.data
      else warnings.push('world/ontology/classes.json 不符合 schema，已忽略')
    } catch {
      warnings.push('world/ontology/classes.json 不是合法 JSON，已忽略')
    }
  }

  const nodes = await readJsonl(
    nodesPath,
    'world/ontology/nodes.jsonl',
    ontologyNodeSchema,
    warnings,
  )
  const edges = await readJsonl(edgesPath, 'world/ontology/edges.jsonl', graphEdgeSchema, warnings)

  const paths = [classesPath, nodesPath, edgesPath, ...watchFiles]
  const mtimes = await Promise.all(paths.map(mtimeOf))
  const toRel = (p: string): string => relative(root, p).split('\\').join('/')

  return {
    classesFile,
    nodes,
    edges,
    warnings,
    files: paths.map(toRel),
    mtimeMax: Math.max(0, ...mtimes),
  }
}
