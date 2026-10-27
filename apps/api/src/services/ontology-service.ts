import { join } from 'node:path'
import { buildGraph, type GraphSnapshot, validateGraph } from '@inkloom/core'
import {
  type Character,
  characterRelationSchema,
  characterSchema,
  type Location,
  locationSchema,
  type PlotThread,
  plotThreadSchema,
  type Route,
  routeSchema,
  type StoryArc,
  storyArcSchema,
  type WorldRule,
  worldRuleSchema,
} from '@inkloom/shared'
import { readJsonElement } from '../storage/elements.js'
import { readOntologyFiles } from '../storage/ontology.js'
import { bookPaths } from '../storage/paths.js'
import { getContext } from './context.js'

interface GraphCache {
  root: string
  /** 逐文件 mtime 签名：任何文件增删改都会变 */
  key: string
  snapshot: GraphSnapshot
  warnings: string[]
}

let cache: GraphCache | null = null

export function clearGraphCache(): void {
  cache = null
}

export interface GraphData {
  snapshot: GraphSnapshot
  /** 存储层的容错告警（坏行/坏 JSON），给 UI 一个出口 */
  warnings: string[]
}

interface Parser<T> {
  safeParse: (v: unknown) => { success: true; data: T } | { success: false }
}

async function readArray<T>(root: string, rel: string, schema: Parser<T>): Promise<T[]> {
  let raw: unknown
  try {
    raw = await readJsonElement(root, rel)
  } catch {
    // 实体文件整体坏掉不该让图谱页整页 400：降级为空数组（其它页面会报具体错误）
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const item of raw) {
    const parsed = schema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/**
 * 图谱快照 + 容错告警。
 * ★ 缓存按 root + 逐文件 mtime 签名：任一文件（含实体文件）变化都会重建。
 * ★ 切片 1 不在这里加索引表（spec D1）。
 */
export async function getGraphData(): Promise<GraphData> {
  const { root } = getContext()
  const p = bookPaths(root)
  const watchFiles = [
    join(p.characters, 'index.json'),
    join(p.characters, 'relations.json'),
    join(p.world, 'rules.json'),
    join(p.world, 'locations.json'),
    join(p.world, 'routes.json'),
    join(p.story, 'threads.json'),
    join(p.story, 'arcs.json'),
  ]
  const files = await readOntologyFiles(root, watchFiles)
  if (cache !== null && cache.root === root && cache.key === files.signature) {
    return { snapshot: cache.snapshot, warnings: cache.warnings }
  }

  const characters = await readArray<Character>(root, 'characters/index.json', characterSchema)
  const relations = await readArray(root, 'characters/relations.json', characterRelationSchema)
  const locations = await readArray<Location>(root, 'world/locations.json', locationSchema)
  const routes = await readArray<Route>(root, 'world/routes.json', routeSchema)
  const rules = await readArray<WorldRule>(root, 'world/rules.json', worldRuleSchema)
  const threads = await readArray<PlotThread>(root, 'story/threads.json', plotThreadSchema)
  const arcs = await readArray<StoryArc>(root, 'story/arcs.json', storyArcSchema)

  const base = buildGraph({
    characters,
    relations,
    locations,
    routes,
    rules,
    threads,
    arcs,
    nodes: files.nodes,
    edges: files.edges,
    classesFile: files.classesFile,
    // files.files 已含 watchFiles，不要再拼一次
    builtFrom: { files: files.files, mtimeMax: files.mtimeMax },
  })
  const snapshot: GraphSnapshot = { ...base, issues: [...base.issues, ...validateGraph(base)] }
  cache = { root, key: files.signature, snapshot, warnings: files.warnings }
  return { snapshot, warnings: files.warnings }
}

export async function getGraphSnapshot(): Promise<GraphSnapshot> {
  return (await getGraphData()).snapshot
}
