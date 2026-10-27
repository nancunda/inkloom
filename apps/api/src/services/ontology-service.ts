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
  /** mtimeMax + 文件数：单靠 mtime 表达不了「文件被删/新增更旧文件」 */
  key: string
  snapshot: GraphSnapshot
}

let cache: GraphCache | null = null

export function clearGraphCache(): void {
  cache = null
}

interface Parser<T> {
  safeParse: (v: unknown) => { success: true; data: T } | { success: false }
}

async function readArray<T>(root: string, rel: string, schema: Parser<T>): Promise<T[]> {
  const raw = await readJsonElement(root, rel)
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const item of raw) {
    const parsed = schema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/**
 * 图谱快照。
 * ★ 缓存按 root + mtimeMax + 文件数：任一文件（含实体文件）变化都会重建。
 * ★ 切片 1 不在这里加索引表（spec D1）。
 */
export async function getGraphSnapshot(): Promise<GraphSnapshot> {
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
  const key = `${files.mtimeMax}:${files.files.length}`
  if (cache !== null && cache.root === root && cache.key === key) return cache.snapshot

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
  cache = { root, key, snapshot }
  return snapshot
}
