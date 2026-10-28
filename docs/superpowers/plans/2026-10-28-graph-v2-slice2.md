# 图谱 2.0（切片 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「不像知识图谱」的本体图换成 Cytoscape 复合图（类=分组框、实例=节点、拖拽可保存），并把 `matchPattern` / `findPath` / `explainFact` 做成 core 纯函数，同时开放 HTTP 与 Agent 工具，让共创模块能真正查询图谱。

**Architecture:** 文件仍是唯一真相源：`getGraphData()` 产出 `GraphSnapshot`，前端在 `apps/web/src/lib/graph-elements.ts` 投影成 Cytoscape elements（后端不产出第二套 elements）；查询算法放 `packages/core/src/ontology/query.ts`，HTTP 与 Agent 工具共用同一实现。新增代码不改数据库、不加迁移。

**Tech Stack:** TypeScript / Hono / Vitest / React 19 / Cytoscape.js 3.34.4（+ @types/cytoscape）/ Tailwind。

**Spec:** `docs/superpowers/specs/2026-10-27-creator-and-graph-v2-design.md` §5（图谱 2.0）

## Global Constraints

- 不改 Prisma schema、不新增迁移；图谱只读文件，不读索引表（spec D1）。
- 后端**不**给 `/ontology/graph` 加 elements：投影只在前端做，避免两套。
- `instanceOf` 边不画（由 compound `parent` 表达）；`tombstone` 行不画；`retracted` 边画但淡出。
- 三栏布局不变（左类树 / 中画布 / 右详情），宽度沿用 `w-60` / `flex-1` / `w-80`。
- 图谱是只读的：Agent 工具描述里必须写「改设定请用 write_element」。
- 所有中文文案直接写进代码，风格与仓库一致（`★` 注释只用于真正会踩的坑）。
- 每个任务先写测试 → 跑红 → 实现 → 跑绿 → `pnpm tsc` + `pnpm exec biome check --write <files>` → 提交。
- 提交信息沿用 `feat(...)` / `fix(...)` / `docs(...)` 前缀，不写 emoji。

---

### Task 1: core 查询纯函数 `matchPattern` / `findPath` / `explainFact`

**Files:**
- Create: `packages/core/src/ontology/query.ts`
- Create: `packages/core/src/ontology/query.test.ts`
- Modify: `packages/core/src/index.ts`（加一行 export）

**Interfaces:**
- Consumes: `GraphSnapshot` / `GraphNode` / `GraphEdgeView`（`./types.js`）、`NodeType`（`@inkloom/shared`）
- Produces:
  ```ts
  export interface GraphPattern {
    classId?: string
    nodeType?: NodeType
    predicate?: string
    from?: string
    to?: string
    attr?: Record<string, string>
    limit?: number
  }
  export interface PatternResult { nodes: GraphNode[]; edges: GraphEdgeView[] }
  export function matchPattern(snap: GraphSnapshot, pattern: GraphPattern): PatternResult
  export function findPath(snap: GraphSnapshot, from: string, to: string, maxDepth?: number):
    { nodes: GraphNode[]; edges: GraphEdgeView[]; found: boolean }
  export function explainFact(snap: GraphSnapshot, from: string, predicate: string, to: string):
    { found: boolean; direct: boolean; via: string[]; virtual: boolean; reason: string }
  ```

- [ ] **Step 1: 写失败测试**

`packages/core/src/ontology/query.test.ts`：

```ts
import type { ClassesFile } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'
import { explainFact, findPath, matchPattern } from './query.js'

const classesFile: ClassesFile = {
  version: 1,
  classes: [
    { id: 'cls-character', name: '人物', parentId: null, kind: 'character', properties: [], rules: [] },
    { id: 'cls-sect', name: '宗门', parentId: null, kind: 'group', properties: [], rules: [] },
    { id: 'cls-sword', name: '剑修', parentId: 'cls-character', kind: 'character', properties: [], rules: [] },
  ],
  predicates: [
    { id: 'instanceOf', label: '属于类', domain: 'any', range: 'class', directed: true, transitive: false },
    { id: 'belongsTo', label: '隶属于', domain: 'any', range: 'any', directed: true, transitive: false },
    { id: 'ally', label: '同盟', domain: 'any', range: 'any', directed: true, transitive: true },
  ],
}

const node = (id: string, name: string) => ({
  id,
  type: 'concept' as const,
  name,
  createdAt: '2026-10-27T00:00:00.000Z',
})

function snap() {
  const src: GraphSource = {
    characters: [
      { id: 'c1', projectId: 'p', name: '林岚', role: 'protagonist', stateStale: false } as never,
      { id: 'c2', projectId: 'p', name: '玄真', role: 'supporting', stateStale: false } as never,
    ],
    relations: [
      {
        id: 'r1',
        projectId: 'p',
        fromId: 'c1',
        toId: 'c2',
        kind: 'master',
        strength: 3,
      } as never,
    ],
    locations: [],
    routes: [],
    rules: [],
    threads: [],
    arcs: [],
    nodes: [node('n1', '青云宗'), node('n2', '藏剑山庄'), node('n3', '落霞谷')],
    edges: [
      // n1 显式属于宗门：验证 classId 查询走类闭包，而不是只看默认类型映射
      {
        id: 'ed-0',
        from: 'n1',
        predicate: 'instanceOf',
        to: 'cls-sect',
        source: { kind: 'author' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-1',
        from: 'c1',
        predicate: 'belongsTo',
        to: 'n1',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-2',
        from: 'c2',
        predicate: 'belongsTo',
        to: 'n1',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-3',
        from: 'n1',
        predicate: 'ally',
        to: 'n2',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-4',
        from: 'n2',
        predicate: 'ally',
        to: 'n3',
        source: { kind: 'agent' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
    ],
    classesFile,
    builtFrom: { files: [], mtimeMax: 0 },
  }
  const g = buildGraph(src)
  // 给 n1 一个属性用于 attr 过滤
  const n1 = g.nodes.get('n1')
  if (n1 !== undefined) n1.attrs = { ...n1.attrs, tier: '一流' }
  return g
}

describe('matchPattern', () => {
  it('节点条件：类闭包 + 属性相等', () => {
    const s = snap()
    const byClass = matchPattern(s, { classId: 'cls-character' })
    expect(byClass.nodes.map((n) => n.id).sort()).toEqual(['c1', 'c2'])

    const byAttr = matchPattern(s, { classId: 'cls-sect', attr: { tier: '一流' } })
    expect(byAttr.nodes.map((n) => n.id)).toEqual(['n1'])
  })

  it('★ 边条件：返回匹配边与两端节点，limit 截断边', () => {
    const s = snap()
    const r = matchPattern(s, { predicate: 'belongsTo', limit: 1 })
    expect(r.edges).toHaveLength(1)
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['c1', 'n1'])

    const from = matchPattern(s, { from: 'c2', predicate: 'belongsTo' })
    expect(from.edges.map((e) => e.id)).toEqual(['ed-2'])
    expect(from.nodes.map((n) => n.id).sort()).toEqual(['c2', 'n1'])
  })

  it('没有边条件时返回节点间的诱导边', () => {
    const s = snap()
    const r = matchPattern(s, { classId: 'cls-sect' })
    expect(r.nodes.map((n) => n.id)).toEqual(['n1'])
    expect(r.edges).toEqual([])
  })

  it('retracted / tombstone 边不参与', () => {
    const s = snap()
    const e = s.edges.find((x) => x.id === 'ed-1')
    if (e !== undefined) e.retracted = true
    const r = matchPattern(s, { predicate: 'belongsTo' })
    expect(r.edges.map((x) => x.id)).not.toContain('ed-1')
  })
})

describe('findPath', () => {
  it('★ 找到最短路径并给出边序列', () => {
    const r = findPath(snap(), 'c1', 'n2')
    expect(r.found).toBe(true)
    expect(r.nodes.map((n) => n.id)).toEqual(['c1', 'n1', 'n2'])
    expect(r.edges.map((e) => e.id)).toEqual(['ed-1', 'ed-3'])
  })

  it('同长度时取字典序稳定结果', () => {
    const first = findPath(snap(), 'c1', 'n2')
    const second = findPath(snap(), 'c1', 'n2')
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id))
  })

  it('maxDepth 限制 + 找不到返回 found=false', () => {
    expect(findPath(snap(), 'c1', 'n2', 1).found).toBe(false)
    expect(findPath(snap(), 'nope', 'n2').found).toBe(false)
  })
})

describe('explainFact', () => {
  it('直接边 / 多跳 / 不存在', () => {
    // edges.jsonl 里的边是 virtual:false；virtual 只属于关系/路线等投影边
    const direct = explainFact(snap(), 'c1', 'belongsTo', 'n1')
    expect(direct).toMatchObject({ found: true, direct: true, virtual: false })
    expect(direct.reason).toContain('直接')

    // ally 是传递谓词：n1—ally→n2—ally→n3 才算 2 跳，混谓词不算
    const multi = explainFact(snap(), 'n1', 'ally', 'n3')
    expect(multi.found).toBe(true)
    expect(multi.direct).toBe(false)
    expect(multi.reason).toContain('2 跳')

    const missing = explainFact(snap(), 'c1', 'ally', 'nope')
    expect(missing.found).toBe(false)
    expect(missing.reason).toContain('没有')
  })

  it('instanceOf 走类闭包（子类实例也算）', () => {
    const r = explainFact(snap(), 'c1', 'instanceOf', 'cls-character')
    expect(r.found).toBe(true)
    expect(r.reason).toContain('子类')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit packages/core/src/ontology/query.test.ts`
Expected: FAIL — `Failed to resolve import "./query.js"`.

- [ ] **Step 3: 实现**

`packages/core/src/ontology/query.ts`：

```ts
import type { NodeType } from '@inkloom/shared'
import type { GraphEdgeView, GraphNode, GraphSnapshot } from './types.js'

/** 同步查询模式：节点条件与边条件可组合；全部为纯函数、零 IO */
export interface GraphPattern {
  classId?: string
  nodeType?: NodeType
  predicate?: string
  from?: string
  to?: string
  attr?: Record<string, string>
  limit?: number
}

export interface PatternResult {
  nodes: GraphNode[]
  edges: GraphEdgeView[]
}

export interface PathResult {
  nodes: GraphNode[]
  edges: GraphEdgeView[]
  found: boolean
}

export interface ExplainResult {
  found: boolean
  direct: boolean
  via: string[]
  virtual: boolean
  reason: string
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_DEPTH = 4
const MAX_DEPTH = 8

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT)
}

/** 参与推理的边：废止行（tombstone）与已被吊销（retracted）的边都不算 */
function liveEdges(snap: GraphSnapshot): GraphEdgeView[] {
  return snap.edges.filter((e) => e.tombstone !== true && e.retracted !== true)
}

/** 类闭包：自己 + 所有子孙类（instanceOf 指向子类，父类查询要能带出来） */
function classClosure(snap: GraphSnapshot, classId: string): Set<string> {
  const out = new Set<string>([classId])
  for (const child of snap.subclasses.get(classId) ?? []) out.add(child)
  return out
}

function nodeMatches(snap: GraphSnapshot, n: GraphNode, p: GraphPattern): boolean {
  if (p.nodeType !== undefined && n.type !== p.nodeType) return false
  if (p.classId !== undefined) {
    const closure = classClosure(snap, p.classId)
    const classes = snap.classOf.get(n.id) ?? []
    if (!classes.some((c) => closure.has(c))) return false
  }
  if (p.attr !== undefined) {
    for (const [k, v] of Object.entries(p.attr)) {
      if (n.attrs[k] !== v) return false
    }
  }
  return true
}

function hasEdgeCond(p: GraphPattern): boolean {
  return p.predicate !== undefined || p.from !== undefined || p.to !== undefined
}

/**
 * 节点条件与边条件可组合：
 * - 有边条件 → 返回匹配边 + 两端节点（limit 截断边数）；
 * - 没有边条件 → 返回匹配节点 + 它们之间的诱导边（limit 截断节点数）。
 */
export function matchPattern(snap: GraphSnapshot, pattern: GraphPattern): PatternResult {
  const limit = clampLimit(pattern.limit)
  const edges = liveEdges(snap)

  if (hasEdgeCond(pattern)) {
    const picked = edges
      .filter(
        (e) =>
          (pattern.predicate === undefined || e.predicate === pattern.predicate) &&
          (pattern.from === undefined || e.from === pattern.from) &&
          (pattern.to === undefined || e.to === pattern.to),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
    const ids = new Set<string>()
    for (const e of picked) {
      ids.add(e.from)
      ids.add(e.to)
    }
    const nodes = [...ids]
      .map((id) => snap.nodes.get(id))
      .filter((n): n is GraphNode => n !== undefined)
      .filter((n) => nodeMatches(snap, n, pattern))
    return { nodes, edges: picked }
  }

  const nodes = [...snap.nodes.values()]
    .filter((n) => nodeMatches(snap, n, pattern))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id))
    .slice(0, limit)
  const kept = new Set(nodes.map((n) => n.id))
  return {
    nodes,
    edges: edges
      .filter((e) => kept.has(e.from) && kept.has(e.to))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }
}

/** 邻接表：路径按无向遍历（探索「这两个东西怎么连上的」），边本身保留原方向 */
function adjacency(snap: GraphSnapshot): Map<string, { to: string; edge: GraphEdgeView }[]> {
  const out = new Map<string, { to: string; edge: GraphEdgeView }[]>()
  for (const e of liveEdges(snap)) {
    if (e.undirected === true) {
      const a = out.get(e.from) ?? []
      a.push({ to: e.to, edge: e })
      out.set(e.from, a)
      const b = out.get(e.to) ?? []
      b.push({ to: e.from, edge: e })
      out.set(e.to, b)
      continue
    }
    const a = out.get(e.from) ?? []
    a.push({ to: e.to, edge: e })
    out.set(e.from, a)
    const b = out.get(e.to) ?? []
    b.push({ to: e.from, edge: e })
    out.set(e.to, b)
  }
  for (const list of out.values()) {
    list.sort((x, y) => x.to.localeCompare(y.to) || x.edge.id.localeCompare(y.edge.id))
  }
  return out
}

/** BFS 最短路径（边数最少）；同长度按邻接表排序保证结果稳定 */
export function findPath(
  snap: GraphSnapshot,
  from: string,
  to: string,
  maxDepth = DEFAULT_DEPTH,
): PathResult {
  const depthCap = Math.min(Math.max(Math.trunc(maxDepth), 1), MAX_DEPTH)
  if (from === to) {
    const n = snap.nodes.get(from)
    return { nodes: n === undefined ? [] : [n], edges: [], found: n !== undefined }
  }
  const adj = adjacency(snap)
  const prev = new Map<string, { from: string; edge: GraphEdgeView }>()
  const depth = new Map<string, number>([[from, 0]])
  const queue = [from]
  let found = false

  while (queue.length > 0) {
    const cur = queue.shift() as string
    const d = depth.get(cur) ?? 0
    if (d >= depthCap) continue
    for (const step of adj.get(cur) ?? []) {
      if (depth.has(step.to)) continue
      depth.set(step.to, d + 1)
      prev.set(step.to, { from: cur, edge: step.edge })
      if (step.to === to) {
        found = true
        break
      }
      queue.push(step.to)
    }
    if (found) break
  }

  if (!found) return { nodes: [], edges: [], found: false }

  const nodeIds: string[] = []
  const edges: GraphEdgeView[] = []
  let cursor = to
  for (;;) {
    nodeIds.push(cursor)
    const p = prev.get(cursor)
    if (p === undefined) break
    edges.push(p.edge)
    cursor = p.from
  }
  nodeIds.reverse()
  edges.reverse()
  const nodes = nodeIds
    .map((id) => snap.nodes.get(id))
    .filter((n): n is GraphNode => n !== undefined)
  return { nodes, edges, found: nodes.length === nodeIds.length }
}

function predicateLabel(snap: GraphSnapshot, predicate: string): string {
  return snap.predicates.find((p) => p.id === predicate)?.label ?? predicate
}

function nameOf(snap: GraphSnapshot, id: string): string {
  return (
    snap.nodes.get(id)?.name ??
    snap.classes.find((c) => c.id === id)?.name ??
    id
  )
}

/** 解释一条事实：直接边 → 传递谓词多跳 → instanceOf 类闭包 → 不存在 */
export function explainFact(
  snap: GraphSnapshot,
  from: string,
  predicate: string,
  to: string,
): ExplainResult {
  const label = predicateLabel(snap, predicate)
  const direct = liveEdges(snap).find(
    (e) => e.from === from && e.predicate === predicate && e.to === to,
  )
  if (direct !== undefined) {
    return {
      found: true,
      direct: true,
      via: [from, to],
      virtual: direct.virtual,
      reason: `直接边：${nameOf(snap, from)} —${label}→ ${nameOf(snap, to)}${direct.virtual ? '（既有数据投影的虚拟边）' : ''}`,
    }
  }

  if (predicate === 'instanceOf') {
    const classes = snap.classOf.get(from) ?? []
    if (classes.includes(to)) {
      return {
        found: true,
        direct: false,
        via: [from, to],
        virtual: false,
        reason: `子类推导：${nameOf(snap, from)} 属于「${nameOf(snap, to)}」（含子类）`,
      }
    }
  }

  const transitive = snap.predicates.find((p) => p.id === predicate)?.transitive === true
  if (transitive) {
    const adj = adjacency(snap)
    const visited = new Set<string>([from])
    const queue: { id: string; hops: string[] }[] = [{ id: from, hops: [from] }]
    while (queue.length > 0) {
      const cur = queue.shift() as { id: string; hops: string[] }
      if (cur.hops.length > 4) continue
      for (const step of adj.get(cur.id) ?? []) {
        if (step.edge.predicate !== predicate) continue
        if (visited.has(step.to)) continue
        const hops = [...cur.hops, step.to]
        if (step.to === to) {
          return {
            found: true,
            direct: false,
            via: hops,
            virtual: step.edge.virtual,
            reason: `经 ${hops.length - 1} 跳（传递关系 ${label}）：${hops.map((id) => nameOf(snap, id)).join(' → ')}`,
          }
        }
        visited.add(step.to)
        queue.push({ id: step.to, hops })
      }
    }
  }

  return {
    found: false,
    direct: false,
    via: [],
    virtual: false,
    reason: `没有找到：${nameOf(snap, from)} —${label}→ ${nameOf(snap, to)}（直接边与已知推导都不成立）`,
  }
}
```

`packages/core/src/index.ts` 在 `export * from './ontology/graph.js'` 后加一行：

```ts
export * from './ontology/query.js'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project unit packages/core/src/ontology/query.test.ts`
Expected: PASS（4 + 3 + 2 共 9 个用例）

- [ ] **Step 5: 类型与格式**

Run: `pnpm tsc` → 无输出
Run: `pnpm exec biome check --write packages/core/src/ontology/query.ts packages/core/src/ontology/query.test.ts packages/core/src/index.ts`

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/ontology/query.ts packages/core/src/ontology/query.test.ts packages/core/src/index.ts
git commit -m "feat(core): ontology query, shortest path and fact explanation"
```

---

### Task 2: 图谱查询 HTTP（path / query / explain）

**Files:**
- Modify: `apps/api/src/routes/ontology.ts`（文末追加三个路由）
- Modify: `apps/api/src/routes/ontology.http.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes: `matchPattern` / `findPath` / `explainFact`（`@inkloom/core`）、`getGraphSnapshot()`（已有）
- Produces:
  - `GET /api/ontology/path?from=&to=&maxDepth=` → `{ found, nodes, edges }`
  - `POST /api/ontology/query`（body=`GraphPattern`）→ `{ nodes, edges }`
  - `GET /api/ontology/explain?from=&predicate=&to=` → `ExplainResult`

- [ ] **Step 1: 写失败测试**

在 `apps/api/src/routes/ontology.http.test.ts` 的 `describe('/api/ontology', ...)` 结束括号**之后**追加：

```ts
describe('/api/ontology 查询', () => {
  it('★ 最短路径：c1 → 青云宗（belongsTo）', async () => {
    const r = await app().request('/api/ontology/path?from=c1&to=grp-qingyun')
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      found: boolean
      nodes: { id: string }[]
      edges: { id: string }[]
    }
    expect(j.found).toBe(true)
    expect(j.nodes.map((n) => n.id)).toEqual(['c1', 'grp-qingyun'])
    expect(j.edges.map((e) => e.id)).toEqual(['ed-bbbbbb'])
  })

  it('路径缺参 → 400；找不到 → found=false', async () => {
    expect((await app().request('/api/ontology/path?from=c1')).status).toBe(400)
    const j = (await (await app().request('/api/ontology/path?from=c1&to=nope')).json()) as {
      found: boolean
    }
    expect(j.found).toBe(false)
  })

  it('★ POST /query 按类与谓词查', async () => {
    const byClass = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify({ classId: 'cls-sect' }),
    })
    expect(byClass.status).toBe(200)
    const j1 = (await byClass.json()) as { nodes: { id: string }[] }
    expect(j1.nodes.map((n) => n.id)).toEqual(['grp-qingyun'])

    const byEdge = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify({ predicate: 'belongsTo', from: 'c1' }),
    })
    const j2 = (await byEdge.json()) as { nodes: { id: string }[]; edges: { id: string }[] }
    expect(j2.edges.map((e) => e.id)).toEqual(['ed-bbbbbb'])
    expect(j2.nodes.map((n) => n.id).sort()).toEqual(['c1', 'grp-qingyun'])
  })

  it('query 体不是对象 → 400', async () => {
    const r = await app().request('/api/ontology/query', {
      method: 'POST',
      body: JSON.stringify(['x']),
    })
    expect(r.status).toBe(400)
  })

  it('★ explain：直接边与不存在', async () => {
    const ok = await app().request(
      '/api/ontology/explain?from=c1&predicate=belongsTo&to=grp-qingyun',
    )
    const j = (await ok.json()) as { found: boolean; direct: boolean; reason: string }
    expect(j.found).toBe(true)
    expect(j.direct).toBe(true)
    expect(j.reason).toContain('直接')

    const miss = await app().request('/api/ontology/explain?from=c1&predicate=ally&to=nope')
    expect(((await miss.json()) as { found: boolean }).found).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:int -- apps/api/src/routes/ontology.http.test.ts`
Expected: FAIL — 三个路径 404。

- [ ] **Step 3: 实现**

`apps/api/src/routes/ontology.ts` 顶部 import 改为：

```ts
import { explainFact, findPath, matchPattern } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { clearGraphCache, getGraphData } from '../services/ontology-service.js'
```

文末追加：

```ts
/** 查询相关的公共取参：缺参直接 400，避免把 undefined 当成 id 去查 */
function required(raw: string | undefined, key: string): string {
  const v = (raw ?? '').trim()
  if (v.length === 0) throw new InkloomError('INVALID_INPUT', `缺少 ${key}`)
  return v
}

function depthOf(raw: string | undefined): number {
  const n = Number(raw ?? '4')
  if (!Number.isInteger(n)) return 4
  return Math.min(Math.max(n, 1), 8)
}

ontologyRoutes.get('/ontology/path', async (c) => {
  const from = required(c.req.query('from'), 'from')
  const to = required(c.req.query('to'), 'to')
  const { snapshot } = await getGraphData()
  return c.json(findPath(snapshot, from, to, depthOf(c.req.query('maxDepth'))))
})

ontologyRoutes.post('/ontology/query', async (c) => {
  const body = (await c.req.json().catch(() => null)) as unknown
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InkloomError('INVALID_INPUT', '请求体必须是 GraphPattern 对象')
  }
  const { snapshot } = await getGraphData()
  return c.json(matchPattern(snapshot, body as Parameters<typeof matchPattern>[1]))
})

ontologyRoutes.get('/ontology/explain', async (c) => {
  const from = required(c.req.query('from'), 'from')
  const predicate = required(c.req.query('predicate'), 'predicate')
  const to = required(c.req.query('to'), 'to')
  const { snapshot } = await getGraphData()
  return c.json(explainFact(snapshot, from, predicate, to))
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test:int -- apps/api/src/routes/ontology.http.test.ts`
Expected: PASS（既有 10 + 新增 5）

- [ ] **Step 5: 类型与格式**

Run: `pnpm tsc`
Run: `pnpm exec biome check --write apps/api/src/routes/ontology.ts apps/api/src/routes/ontology.http.test.ts`

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/ontology.ts apps/api/src/routes/ontology.http.test.ts
git commit -m "feat(api): ontology path, pattern query and explain endpoints"
```

---

### Task 3: Agent 图谱工具 `query_graph` / `find_path` / `explain_fact`

**Files:**
- Create: `apps/api/src/agent/tool-result.ts`（从 tools.ts 抽 `ok` / `fail` / `clip`）
- Create: `apps/api/src/agent/graph-tools.ts`
- Create: `apps/api/src/agent/graph-tools.test.ts`
- Modify: `apps/api/src/agent/tools.ts`（删本地 `ok/fail/clip`、引用新模块、返回数组加三个工具）

**Interfaces:**
- Consumes: `getGraphSnapshot()`、`matchPattern` / `findPath` / `explainFact`
- Produces:
  ```ts
  export function createGraphTools(): AgentTool[]
  // 工具名：query_graph / find_path / explain_fact
  ```

- [ ] **Step 1: 写失败测试**

`apps/api/src/agent/graph-tools.test.ts`：

```ts
import type { GraphSnapshot } from '@inkloom/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ snapshot: vi.fn() }))

vi.mock('../services/ontology-service.js', () => ({
  getGraphSnapshot: h.snapshot,
}))

import { createGraphTools } from './graph-tools.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'

function tool(name: string): AgentTool {
  const found = createGraphTools().find((t) => t.name === name)
  if (found === undefined) throw new Error(`没有工具 ${name}`)
  return found as AgentTool
}

function textOf(res: { content: { type: string }[] }): string {
  const first = res.content[0] as { type: string; text?: string } | undefined
  return first?.text ?? ''
}

const snap = {
  nodes: new Map([
    ['c1', { id: 'c1', type: 'character', name: '林岚', attrs: {}, virtual: true }],
    ['c2', { id: 'c2', type: 'character', name: '玄真', attrs: {}, virtual: true }],
  ]),
  edges: [
    {
      id: 'ed-1',
      from: 'c1',
      predicate: 'belongsTo',
      to: 'c2',
      virtual: true,
      source: { kind: 'agent' },
    },
  ],
  classOf: new Map([
    ['c1', ['cls-character']],
    ['c2', ['cls-character']],
  ]),
  subclasses: new Map(),
  classes: [{ id: 'cls-character', name: '人物', parentId: null, kind: 'character', properties: [], rules: [] }],
  predicates: [
    { id: 'belongsTo', label: '隶属', domain: 'any', range: 'any', directed: true, transitive: false },
  ],
  issues: [],
  builtFrom: { files: [], mtimeMax: 0 },
} as unknown as GraphSnapshot

describe('graph tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.snapshot.mockResolvedValue(snap)
  })

  it('★ query_graph 返回摘要与 JSON', async () => {
    const res = await tool('query_graph').execute('1', { predicate: 'belongsTo' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('1 条边')
    expect(textOf(res)).toContain('林岚')
    expect(textOf(res)).toContain('belongsTo')
  })

  it('find_path 找到时给逐跳文本', async () => {
    const res = await tool('find_path').execute('2', { from: 'c1', to: 'c2' })
    expect(textOf(res)).toContain('林岚')
    expect(textOf(res)).toContain('玄真')
    expect(textOf(res)).toContain('隶属')
  })

  it('★ find_path 找不到时 isError，并提示用 query_graph', async () => {
    const res = await tool('find_path').execute('3', { from: 'c1', to: 'nope' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('query_graph')
  })

  it('explain_fact 不存在时 isError', async () => {
    const res = await tool('explain_fact').execute('4', {
      from: 'c1',
      predicate: 'ally',
      to: 'c2',
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('没有找到')
  })

  it('工具描述写明只读', () => {
    expect(tool('query_graph').description).toContain('write_element')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/graph-tools.test.ts`
Expected: FAIL — 找不到 `./graph-tools.js`。

- [ ] **Step 3: 抽出工具结果助手**

`apps/api/src/agent/tool-result.ts`：

```ts
import type { AgentToolResult } from '@earendil-works/pi-agent-core'

export function ok(
  text: string,
  details: Record<string, unknown> = {},
  terminate = false,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }],
    details,
    ...(terminate ? { terminate: true } : {}),
  }
}

export function fail(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details, isError: true }
}

/** 摘要压成一行并截断：搜索列表里不要塞换行 */
export function clip(text: string, max = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}
```

`apps/api/src/agent/tools.ts` 删掉本地 `clip` / `ok` / `fail` 三个定义（约 25 行），改为：

```ts
import { clip, fail, ok } from './tool-result.js'
```

- [ ] **Step 4: 实现三个工具**

`apps/api/src/agent/graph-tools.ts`：

```ts
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { explainFact, findPath, matchPattern, type PatternResult } from '@inkloom/core'
import { Type } from 'typebox'
import { getGraphSnapshot } from '../services/ontology-service.js'
import { fail, ok } from './tool-result.js'

const READONLY = '图谱是只读视图；要改设定请用 write_element，不要在对话里改图。'

const QUERY_GRAPH = Type.Object({
  classId: Type.Optional(Type.String({ description: '类 id，例如 cls-character；含子类' })),
  nodeType: Type.Optional(
    Type.String({ description: '节点类型：character/group/place/rule/item/concept/class' }),
  ),
  predicate: Type.Optional(Type.String({ description: '谓词 id，例如 belongsTo / instanceOf' })),
  from: Type.Optional(Type.String({ description: '边的起点节点 id' })),
  to: Type.Optional(Type.String({ description: '边的终点节点 id（可为类 id）' })),
  attr: Type.Optional(
    Type.Record(Type.String(), Type.String(), { description: '属性相等过滤，如 {"tier":"一流"}' }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: '默认 50' })),
})

const FIND_PATH = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: '默认 4' })),
})

const EXPLAIN_FACT = Type.Object({
  from: Type.String({ minLength: 1 }),
  predicate: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
})

function renderQuery(result: PatternResult): string {
  const nodeLines = result.nodes.map(
    (n) => `- ${n.name}（${n.id}，${n.type}${n.virtual ? '，虚拟' : ''}）`,
  )
  const edgeLines = result.edges.map(
    (e) => `- ${e.from} —${e.predicate}→ ${e.to}${e.virtual ? '（虚拟）' : ''}`,
  )
  const head = `${result.nodes.length} 个节点 · ${result.edges.length} 条边`
  return `${head}\n${nodeLines.join('\n')}${edgeLines.length > 0 ? `\n${edgeLines.join('\n')}` : ''}`
}

export function createGraphTools(): AgentTool[] {
  const queryGraph: AgentTool<typeof QUERY_GRAPH> = {
    name: 'query_graph',
    label: '查询图谱',
    description: `按类/类型/谓词/端点/属性查询本体图，返回节点与边。${READONLY}`,
    parameters: QUERY_GRAPH,
    execute: async (_id, params) => {
      const snap = await getGraphSnapshot().catch((e: unknown) => e as Error)
      if (snap instanceof Error) return fail(`图谱不可用：${snap.message}`)
      const pattern = {
        ...(params.classId === undefined ? {} : { classId: params.classId }),
        ...(params.nodeType === undefined ? {} : { nodeType: params.nodeType }),
        ...(params.predicate === undefined ? {} : { predicate: params.predicate }),
        ...(params.from === undefined ? {} : { from: params.from }),
        ...(params.to === undefined ? {} : { to: params.to }),
        ...(params.attr === undefined ? {} : { attr: params.attr }),
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }
      const result = matchPattern(snap, pattern)
      if (result.nodes.length === 0 && result.edges.length === 0) {
        return fail('没有匹配的节点/边。可以放宽条件，或先用 read_book 看类与谓词。')
      }
      return ok(renderQuery(result), {
        nodeCount: result.nodes.length,
        edgeCount: result.edges.length,
      })
    },
  }

  const findPathTool: AgentTool<typeof FIND_PATH> = {
    name: 'find_path',
    label: '查最短路径',
    description: `查两个节点之间边数最少的路径（最多 8 跳）。${READONLY}`,
    parameters: FIND_PATH,
    execute: async (_id, params) => {
      const snap = await getGraphSnapshot().catch((e: unknown) => e as Error)
      if (snap instanceof Error) return fail(`图谱不可用：${snap.message}`)
      const r = findPath(snap, params.from, params.to, params.maxDepth ?? 4)
      if (!r.found) {
        return fail(
          `没有找到 ${params.from} → ${params.to} 的路径（最多 ${params.maxDepth ?? 4} 跳）。可以用 query_graph 查它们各自的直接关系。`,
        )
      }
      const hops = r.edges.map((e, i) => {
        const fromName = snap.nodes.get(r.nodes[i]?.id ?? e.from)?.name ?? e.from
        const toName = snap.nodes.get(r.nodes[i + 1]?.id ?? e.to)?.name ?? e.to
        const label = snap.predicates.find((p) => p.id === e.predicate)?.label ?? e.predicate
        return `${i + 1}. ${fromName} —${label}→ ${toName}${e.virtual ? '（虚拟）' : ''}`
      })
      return ok(
        `找到路径：${r.nodes.map((n) => n.name).join(' → ')}（${r.edges.length} 跳）\n${hops.join('\n')}`,
        { hops: r.edges.length },
      )
    },
  }

  const explainFactTool: AgentTool<typeof EXPLAIN_FACT> = {
    name: 'explain_fact',
    label: '解释事实',
    description: `解释 from —predicate→ to 是否成立（直接边/传递/子类推导）。${READONLY}`,
    parameters: EXPLAIN_FACT,
    execute: async (_id, params) => {
      const snap = await getGraphSnapshot().catch((e: unknown) => e as Error)
      if (snap instanceof Error) return fail(`图谱不可用：${snap.message}`)
      const r = explainFact(snap, params.from, params.predicate, params.to)
      return r.found ? ok(r.reason, { direct: r.direct, virtual: r.virtual }) : fail(r.reason)
    },
  }

  return [queryGraph, findPathTool, explainFactTool]
}
```

`apps/api/src/agent/tools.ts` 顶部加 `import { createGraphTools } from './graph-tools.js'`，返回数组改为：

```ts
  return [
    readBook,
    readElementTool,
    webSearchTool,
    readUrlTool,
    readLoreTool,
    ...createGraphTools(),
    writeElementTool,
    writeBlueprintTool,
    ...
  ]
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run --project unit apps/api/src/agent/graph-tools.test.ts`
Expected: PASS（5 个用例）

Run: `pnpm vitest run --project unit apps/api/src/agent/web-tools.test.ts apps/api/src/agent/plan-tools.test.ts`
Expected: PASS（确认抽出 `ok/fail` 没破坏既有工具）

- [ ] **Step 6: 类型与格式**

Run: `pnpm tsc`
Run: `pnpm exec biome check --write apps/api/src/agent/tool-result.ts apps/api/src/agent/graph-tools.ts apps/api/src/agent/graph-tools.test.ts apps/api/src/agent/tools.ts`

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/agent/tool-result.ts apps/api/src/agent/graph-tools.ts apps/api/src/agent/graph-tools.test.ts apps/api/src/agent/tools.ts
git commit -m "feat(agent): query_graph, find_path and explain_fact tools"
```

---

### Task 4: `read_book` 追加图谱概况（含已批准资料卡）

**Files:**
- Create: `apps/api/src/agent/graph-summary.ts`
- Create: `apps/api/src/agent/graph-summary.test.ts`
- Modify: `apps/api/src/agent/tools.ts`（`readBook.execute` 拼接概况）

**Interfaces:**
- Consumes: `getGraphData()`、`listLore()`、`getContext()`
- Produces: `export async function renderGraphSummary(): Promise<string>`（≤ 800 字，失败时返回一行提示，不阻断 read_book）

- [ ] **Step 1: 写失败测试**

`apps/api/src/agent/graph-summary.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  graph: vi.fn(),
  lore: vi.fn(),
}))

vi.mock('../services/ontology-service.js', () => ({ getGraphData: h.graph }))
vi.mock('../services/lore-service.js', () => ({ listLore: h.lore }))
vi.mock('../services/context.js', () => ({
  getContext: () => ({ root: 'C:/book', project: { id: 'p1' }, db: {} }),
}))

import { renderGraphSummary } from './graph-summary.js'

const graph = {
  snapshot: {
    nodes: new Map([
      ['c1', { id: 'c1', type: 'character', name: '林岚', attrs: {}, virtual: true }],
      ['n1', { id: 'n1', type: 'group', name: '青云宗', attrs: {}, virtual: false }],
    ]),
    edges: [{ id: 'e1', from: 'c1', predicate: 'belongsTo', to: 'n1', virtual: true }],
    classOf: new Map([
      ['c1', ['cls-character']],
      ['n1', ['cls-group', 'cls-sect']],
    ]),
    subclasses: new Map(),
    classes: [
      { id: 'cls-character', name: '人物', kind: 'character' },
      { id: 'cls-sect', name: '宗门', kind: 'group' },
    ],
    predicates: [],
    issues: [
      { severity: 'error', code: 'EDGE_ENDPOINT_MISSING', subject: 'ed-x', message: '边端点不存在' },
      { severity: 'warning', code: 'DUP_NODE', subject: 'c1', message: '重复节点' },
    ],
    builtFrom: { files: [], mtimeMax: 0 },
  },
  warnings: [],
  signature: 'sig',
}

describe('renderGraphSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.graph.mockResolvedValue(graph)
    h.lore.mockResolvedValue([
      { id: 'lr-aaa', title: '剑冢考据', url: 'https://a', snippet: '', content: null, provider: 'tavily', approved: true },
    ])
  })

  it('★ 包含节点/边/类计数、error 问题与已批准资料卡', async () => {
    const text = await renderGraphSummary()
    expect(text).toContain('2 节点')
    expect(text).toContain('1 边')
    expect(text).toContain('EDGE_ENDPOINT_MISSING')
    expect(text).not.toContain('DUP_NODE')
    expect(text).toContain('lr-aaa')
    expect(text).toContain('剑冢考据')
  })

  it('★ 图谱不可用时不抛错', async () => {
    h.graph.mockRejectedValue(new Error('尚未打开任何书'))
    const text = await renderGraphSummary()
    expect(text).toContain('图谱概况不可用')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/graph-summary.test.ts`
Expected: FAIL — `./graph-summary.js` 不存在。

- [ ] **Step 3: 实现**

`apps/api/src/agent/graph-summary.ts`：

```ts
import type { GraphSnapshot } from '@inkloom/core'
import { getContext } from '../services/context.js'
import { listLore } from '../services/lore-service.js'
import { getGraphData } from '../services/ontology-service.js'

function classCounts(snap: GraphSnapshot): { id: string; name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const ids of snap.classOf.values()) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return snap.classes
    .map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/**
 * read_book 末尾的图谱概况（≤ 800 字）。
 * ★ 失败只降级成一行提示：图谱是辅助信息，不能把 read_book 一起拖垮。
 */
export async function renderGraphSummary(): Promise<string> {
  try {
    const { snapshot } = await getGraphData()
    const { db, project } = getContext()
    const lore = await listLore(db, project.id, { approved: true, limit: 5 })
    const errors = snapshot.issues.filter((i) => i.severity === 'error')

    const lines: string[] = ['## 图谱概况']
    lines.push(
      `${snapshot.nodes.size} 节点 · ${snapshot.edges.length} 边 · ${snapshot.classes.length} 类 · ${snapshot.issues.length} 问题（error ${errors.length}）`,
    )
    const top = classCounts(snapshot).slice(0, 8)
    if (top.length > 0) {
      lines.push(`各类实例：${top.map((c) => `${c.name} ${c.count}`).join(' · ')}`)
    }
    for (const issue of errors.slice(0, 3)) {
      lines.push(`- [${issue.code}] ${issue.message}`)
    }
    if (lore.length > 0) {
      lines.push(`已批准资料卡：${lore.map((l) => `${l.id} ${l.title}`).join(' · ')}`)
    } else {
      lines.push('已批准资料卡：无（web_search 搜到的卡要先请作者批准）')
    }
    return lines.join('\n').slice(0, 800)
  } catch (e) {
    return `## 图谱概况\n图谱概况不可用：${(e as Error).message}`
  }
}
```

`apps/api/src/agent/tools.ts` 的 `readBook`：

```ts
    execute: async () => {
      const snap = await buildBookSnapshot()
      const summary = await renderGraphSummary()
      return ok(`${renderSnapshot(snap)}\n\n${summary}`, {
        characters: Array.isArray(snap.characters) ? snap.characters.length : 0,
      })
    },
```

顶部加：

```ts
import { renderGraphSummary } from './graph-summary.js'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run --project unit apps/api/src/agent/graph-summary.test.ts apps/api/src/agent/web-tools.test.ts`
Expected: PASS

- [ ] **Step 5: 类型与格式**

Run: `pnpm tsc`
Run: `pnpm exec biome check --write apps/api/src/agent/graph-summary.ts apps/api/src/agent/graph-summary.test.ts apps/api/src/agent/tools.ts`

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/agent/graph-summary.ts apps/api/src/agent/graph-summary.test.ts apps/api/src/agent/tools.ts
git commit -m "feat(agent): append graph overview and approved lore to read_book"
```

---

### Task 5: 前端投影层 `toGraphElements` + 测试基建

**Files:**
- Modify: `apps/web/package.json`（加 `cytoscape` / `@types/cytoscape`）
- Modify: `vitest.config.ts`（unit project include 加 `apps/web/src/**/*.test.ts`）
- Create: `apps/web/src/lib/graph-elements.ts`
- Create: `apps/web/src/lib/graph-elements.test.ts`

**Interfaces:**
- Consumes: `OntologyGraphData`（`../api/types`）
- Produces:
  ```ts
  export interface GraphElementNodeData {
    id: string
    label: string
    kind: 'class' | 'instance'
    nodeType?: string
    classId?: string
    color?: string
    instanceCount?: number
    virtual?: boolean
    parent?: string
  }
  export interface GraphElementEdgeData {
    id: string
    source: string
    target: string
    label: string
    predicate: string
    virtual: boolean
    retracted: boolean
  }
  export interface GraphElements {
    nodes: { data: GraphElementNodeData }[]
    edges: { data: GraphElementEdgeData }[]
  }
  export function toGraphElements(graph: OntologyGraphData): GraphElements
  export function filterElements(
    elements: GraphElements,
    filter: { nodeTypes?: ReadonlySet<string>; predicates?: ReadonlySet<string> },
  ): GraphElements
  export function nodesWithinHops(elements: GraphElements, anchor: string, hops: number): Set<string>
  export function searchNodes(elements: GraphElements, text: string): string[]
  ```

- [ ] **Step 1: 装依赖**

```bash
pnpm --filter @inkloom/web add cytoscape@^3.34.4
pnpm --filter @inkloom/web add -D @types/cytoscape@^3.31.0
```

Expected: `apps/web/package.json` 出现两个依赖；`pnpm-lock.yaml` 更新。若 `pnpm` 报 Prisma postinstall 的 EPERM，先确认没有 API 进程占用（`Get-NetTCPConnection -LocalPort 8787`），停掉再重试。

- [ ] **Step 2: 让 unit 项目跑 web 测试**

`vitest.config.ts` 的 unit include 改为：

```ts
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/api/src/**/*.test.ts',
            'apps/web/src/**/*.test.ts',
          ],
```

- [ ] **Step 3: 写失败测试**

`apps/web/src/lib/graph-elements.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { OntologyGraphData } from '../api/types'
import { filterElements, nodesWithinHops, searchNodes, toGraphElements } from './graph-elements'

function graph(over: Partial<OntologyGraphData> = {}): OntologyGraphData {
  return {
    nodes: [
      {
        id: 'c1',
        type: 'character',
        name: '林岚',
        attrs: {},
        virtual: true,
        classIds: ['cls-character'],
      },
      {
        id: 'grp',
        type: 'group',
        name: '青云宗',
        attrs: {},
        virtual: false,
        classIds: ['cls-group', 'cls-sect'],
      },
      { id: 'l1', type: 'place', name: '寒山关', attrs: {}, virtual: true, classIds: ['cls-place'] },
    ],
    edges: [
      { id: 'e-inst', from: 'grp', predicate: 'instanceOf', to: 'cls-sect', virtual: false },
      { id: 'e-belong', from: 'c1', predicate: 'belongsTo', to: 'grp', virtual: false },
      { id: 'e-retract', from: 'c1', predicate: 'enemy', to: 'l1', virtual: false, retracted: true },
      { id: 'e-tomb', from: 'c1', predicate: 'ally', to: 'l1', virtual: false, tombstone: true },
      { id: 'e-dangling', from: 'c1', predicate: 'ally', to: 'ghost', virtual: true },
    ],
    classes: [
      {
        id: 'cls-character',
        name: '人物',
        parentId: null,
        kind: 'character',
        properties: [],
        rules: [],
      },
      { id: 'cls-group', name: '组织', parentId: null, kind: 'group', properties: [], rules: [] },
      { id: 'cls-sect', name: '宗门', parentId: 'cls-group', kind: 'group', properties: [], rules: [] },
    ],
    predicates: [
      { id: 'belongsTo', label: '隶属', domain: 'any', range: 'any', directed: true },
      { id: 'enemy', label: '敌对', domain: 'any', range: 'any', directed: true },
    ],
    issues: [],
    warnings: [],
    total: 3,
    truncated: false,
    signature: 's',
    builtAt: '2026-10-27T00:00:00.000Z',
    ...over,
  }
}

describe('toGraphElements', () => {
  it('★ 类变分组节点，实例挂最具体的类；instanceOf 不画', () => {
    const g = toGraphElements(graph())
    const classIds = g.nodes.filter((n) => n.data.kind === 'class').map((n) => n.data.id)
    expect(classIds).toEqual(['cls-character', 'cls-group', 'cls-sect', 'cls-concept'])

    expect(g.nodes.find((n) => n.data.id === 'grp')?.data.parent).toBe('cls-sect')
    expect(g.nodes.find((n) => n.data.id === 'c1')?.data.parent).toBe('cls-character')

    expect(g.edges.map((e) => e.data.predicate)).not.toContain('instanceOf')
  })

  it('★ 缺失的类补一个 cls-concept；悬空边与 tombstone 不画', () => {
    const g = toGraphElements(graph())
    expect(g.nodes.find((n) => n.data.id === 'cls-concept')).toMatchObject({
      data: { kind: 'class', label: '概念' },
    })
    expect(g.nodes.find((n) => n.data.id === 'l1')?.data.parent).toBe('cls-concept')
    expect(g.edges.map((e) => e.data.id)).toEqual(['e-belong', 'e-retract'])
  })

  it('边标签用中文谓词；虚拟/废止带标记', () => {
    const g = toGraphElements(graph())
    expect(g.edges.find((e) => e.data.id === 'e-belong')?.data.label).toBe('隶属')
    expect(g.edges.find((e) => e.data.id === 'e-retract')?.data.retracted).toBe(true)
  })
})

describe('filterElements / hops / search', () => {
  it('按类型与谓词过滤：空了的类分组框一并收起，边两端都得在', () => {
    const g = toGraphElements(graph())
    const out = filterElements(g, { nodeTypes: new Set(['character', 'group']) })
    // c1 挂 cls-character、grp 挂 cls-sect；cls-group 没有存活实例，应被收起
    expect(out.nodes.map((n) => n.data.id)).toEqual(['cls-character', 'cls-sect', 'c1', 'grp'])
    expect(out.edges.map((e) => e.data.id)).toEqual(['e-belong'])

    const noEnemy = filterElements(g, { predicates: new Set(['belongsTo']) })
    expect(noEnemy.edges.map((e) => e.data.id)).toEqual(['e-belong'])
  })

  it('★ N 跳邻居含锚点本身', () => {
    const g = toGraphElements(graph())
    expect([...nodesWithinHops(g, 'c1', 1)].sort()).toEqual(['c1', 'grp', 'l1'])
    expect([...nodesWithinHops(g, 'c1', 0)]).toEqual(['c1'])
  })

  it('搜名字与 id，大小写不敏感', () => {
    const g = toGraphElements(graph())
    expect(searchNodes(g, '青云')).toEqual(['grp'])
    expect(searchNodes(g, 'C1')).toEqual(['c1'])
    expect(searchNodes(g, '')).toEqual([])
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/web/src/lib/graph-elements.test.ts`
Expected: FAIL — `./graph-elements` 不存在。

- [ ] **Step 5: 实现**

`apps/web/src/lib/graph-elements.ts`：

```ts
import type { OntologyGraphData, OntologyNodeRow } from '../api/types'

/** rel:<kind> 的中文（与详情栏同一口径） */
const REL_LABEL: Record<string, string> = {
  master: '师徒',
  disciple: '弟子',
  kin: '亲族',
  ally: '同盟',
  enemy: '敌对',
  rival: '竞争',
  lover: '情爱',
}

const TYPE_COLOR: Record<string, string> = {
  character: '#1f2937',
  group: '#b45309',
  place: '#0f766e',
  rule: '#be123c',
  item: '#7c3aed',
  concept: '#4b5563',
  class: '#a1a1a1',
}

export interface GraphElementNodeData {
  id: string
  label: string
  kind: 'class' | 'instance'
  nodeType?: string
  classId?: string
  color?: string
  instanceCount?: number
  virtual?: boolean
  parent?: string
}

export interface GraphElementEdgeData {
  id: string
  source: string
  target: string
  label: string
  predicate: string
  virtual: boolean
  retracted: boolean
}

export interface GraphElements {
  nodes: { data: GraphElementNodeData }[]
  edges: { data: GraphElementEdgeData }[]
}

function predicateLabel(predicate: string, labels: Map<string, string>): string {
  if (predicate.startsWith('rel:')) {
    const kind = predicate.slice(4)
    return REL_LABEL[kind] ?? kind
  }
  return labels.get(predicate) ?? predicate
}

/**
 * GraphSnapshot（HTTP 返回的扁平数组）→ Cytoscape elements。
 * ★ 只在这里做投影：后端不加 elements，避免两套真相。
 */
export function toGraphElements(graph: OntologyGraphData): GraphElements {
  const labels = new Map(graph.predicates.map((p) => [p.id, p.label]))
  const classIds = new Set(graph.classes.map((c) => c.id))
  const nodes: { data: GraphElementNodeData }[] = []

  for (const c of graph.classes) {
    nodes.push({
      data: {
        id: c.id,
        label: c.name,
        kind: 'class',
        ...(c.instanceCount === undefined ? {} : { instanceCount: c.instanceCount }),
      },
    })
  }
  const needRoot = graph.nodes.some((n) => (n.classIds.at(-1) ?? 'cls-concept') === 'cls-concept')
  if (needRoot && !classIds.has('cls-concept')) {
    nodes.push({ data: { id: 'cls-concept', label: '概念', kind: 'class' } })
  }

  for (const n of graph.nodes) {
    const parent = n.classIds.at(-1) ?? 'cls-concept'
    nodes.push({
      data: {
        id: n.id,
        label: n.name,
        kind: 'instance',
        nodeType: n.type,
        classId: parent,
        color: TYPE_COLOR[n.type] ?? '#737373',
        ...(n.virtual ? { virtual: true } : {}),
        parent,
      },
    })
  }

  const nodeIds = new Set(nodes.map((n) => n.data.id))
  const edges = graph.edges
    .filter(
      (e) =>
        e.tombstone !== true &&
        e.predicate !== 'instanceOf' &&
        nodeIds.has(e.from) &&
        nodeIds.has(e.to),
    )
    .map((e) => ({
      data: {
        id: e.id,
        source: e.from,
        target: e.to,
        label: predicateLabel(e.predicate, labels),
        predicate: e.predicate,
        virtual: e.virtual === true,
        retracted: e.retracted === true,
      },
    }))

  return { nodes, edges }
}

export function filterElements(
  elements: GraphElements,
  filter: { nodeTypes?: ReadonlySet<string>; predicates?: ReadonlySet<string> },
): GraphElements {
  const types =
    filter.nodeTypes === undefined || filter.nodeTypes.size === 0 ? null : filter.nodeTypes
  const instances = elements.nodes.filter(
    (n) =>
      n.data.kind === 'instance' &&
      (types === null || (n.data.nodeType !== undefined && types.has(n.data.nodeType))),
  )
  // ★ 分组框只在还有实例时保留；空框既占地方，又会让人以为过滤没生效
  const parentIds = new Set<string>()
  for (const n of instances) {
    if (n.data.parent !== undefined) parentIds.add(n.data.parent)
  }
  const classes = elements.nodes.filter(
    (n) => n.data.kind === 'class' && parentIds.has(n.data.id),
  )
  const nodes = [...classes, ...instances]
  const ids = new Set(nodes.map((n) => n.data.id))
  const edges = elements.edges.filter(
    (e) =>
      ids.has(e.data.source) &&
      ids.has(e.data.target) &&
      (filter.predicates === undefined ||
        filter.predicates.size === 0 ||
        filter.predicates.has(e.data.predicate)),
  )
  return { nodes, edges }
}

/** BFS：锚点 N 跳内的节点（含锚点）；hops=0 只回锚点 */
export function nodesWithinHops(
  elements: GraphElements,
  anchor: string,
  hops: number,
): Set<string> {
  const adj = new Map<string, string[]>()
  for (const e of elements.edges) {
    const a = adj.get(e.data.source) ?? []
    a.push(e.data.target)
    adj.set(e.data.source, a)
    const b = adj.get(e.data.target) ?? []
    b.push(e.data.source)
    adj.set(e.data.target, b)
  }
  const seen = new Set<string>([anchor])
  let frontier = [anchor]
  for (let d = 0; d < hops; d += 1) {
    const next: string[] = []
    for (const id of frontier) {
      for (const to of adj.get(id) ?? []) {
        if (seen.has(to)) continue
        seen.add(to)
        next.push(to)
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return seen
}

/** 按名字/ID 搜实例节点（类节点不参与，避免把整个分组框高亮） */
export function searchNodes(elements: GraphElements, text: string): string[] {
  const q = text.trim().toLowerCase()
  if (q.length === 0) return []
  return elements.nodes
    .filter((n) => n.data.kind === 'instance')
    .filter((n) => n.data.label.toLowerCase().includes(q) || n.data.id.toLowerCase().includes(q))
    .map((n) => n.data.id)
}

/** 详情栏用：取最具体的类名 */
export function primaryClass(n: OntologyNodeRow): string {
  return n.classIds.at(-1) ?? 'cls-concept'
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm vitest run --project unit apps/web/src/lib/graph-elements.test.ts`
Expected: PASS（3 + 3 共 6 个用例）

- [ ] **Step 7: 类型与格式**

Run: `pnpm tsc`
Run: `pnpm exec biome check --write apps/web/src/lib/graph-elements.ts apps/web/src/lib/graph-elements.test.ts vitest.config.ts`

- [ ] **Step 8: 提交**

```bash
git add apps/web/package.json pnpm-lock.yaml vitest.config.ts apps/web/src/lib/graph-elements.ts apps/web/src/lib/graph-elements.test.ts
git commit -m "feat(web): project ontology snapshot to cytoscape elements"
```

---

### Task 6: `GraphCanvas` + 布局位置持久化 + 主题

**Files:**
- Create: `apps/web/src/components/graph/graph-theme.ts`
- Create: `apps/web/src/components/graph/useGraphLayout.ts`
- Create: `apps/web/src/components/graph/GraphCanvas.tsx`

**Interfaces:**
- Consumes: `GraphElements`（Task 5）
- Produces:
  ```ts
  export type GraphLayoutName = 'cose' | 'breadthfirst' | 'concentric' | 'grid' | 'preset'
  export interface GraphCanvasHandle {
    fit(): void
    runLayout(name: GraphLayoutName): void
    focus(id: string): void
    highlight(ids: string[]): void
    resetHighlight(): void
    positions(): Record<string, { x: number; y: number }>
  }
  export function useGraphLayout(bookId: string, signature: string): {
    preset: Record<string, { x: number; y: number }> | undefined
    save(positions: Record<string, { x: number; y: number }>): void
    clear(): void
  }
  ```

- [ ] **Step 1: 主题常量**

`apps/web/src/components/graph/graph-theme.ts`：

```ts
import type { Stylesheet } from 'cytoscape'

export const TYPE_LABEL: Record<string, string> = {
  character: '人物',
  group: '组织',
  place: '地点',
  rule: '规则',
  item: '物品',
  concept: '概念',
  class: '类',
}

export const TYPE_COLOR: Record<string, string> = {
  character: '#1f2937',
  group: '#b45309',
  place: '#0f766e',
  rule: '#be123c',
  item: '#7c3aed',
  concept: '#4b5563',
  class: '#a1a1a1',
}

export const REL_LABEL: Record<string, string> = {
  master: '师徒',
  disciple: '弟子',
  kin: '亲族',
  ally: '同盟',
  enemy: '敌对',
  rival: '竞争',
  lover: '情爱',
}

/** 谓词中文名；rel:* 按 kind 映射，未注册的原样输出 */
export function predicateLabel(predicate: string, labels: Map<string, string>): string {
  if (predicate.startsWith('rel:')) {
    const kind = predicate.slice(4)
    return REL_LABEL[kind] ?? kind
  }
  return labels.get(predicate) ?? predicate
}

/**
 * Cytoscape 样式。
 * ★ @types/cytoscape 落后于运行时，个别属性会报类型错；只在字面量上断言，不要改成 any。
 */
export const GRAPH_STYLE = [
  {
    selector: 'node[kind="class"]',
    style: {
      'background-color': '#f5f5f5',
      'background-opacity': 0.65,
      'border-color': '#b3b3b3',
      'border-width': 1,
      'border-style': 'dashed',
      label: 'data(label)',
      'font-size': 11,
      color: '#525252',
      'text-valign': 'top',
      'text-margin-y': -4,
      padding: 14,
    },
  },
  {
    selector: 'node[kind="instance"]',
    style: {
      'background-color': '#ffffff',
      'border-width': 2,
      'border-color': 'data(color)',
      shape: 'round-rectangle',
      width: 96,
      height: 30,
      label: 'data(label)',
      'font-size': 11,
      color: '#262626',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'ellipsis',
      'text-max-width': 84,
    },
  },
  {
    selector: 'node[kind="instance"][?virtual]',
    style: { 'border-style': 'dashed' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.2,
      'line-color': '#8a8a8a',
      'target-arrow-color': '#8a8a8a',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 9,
      color: '#737373',
      'text-background-color': '#ffffff',
      'text-background-opacity': 0.9,
      'text-background-padding': '2px',
    },
  },
  {
    selector: 'edge[?virtual]',
    style: { 'line-style': 'dashed', 'line-color': '#c4c4c4', 'target-arrow-color': '#c4c4c4' },
  },
  {
    selector: 'edge[?retracted]',
    style: { 'line-style': 'dotted', opacity: 0.25 },
  },
  { selector: '.dimmed', style: { opacity: 0.15 } },
  {
    selector: 'node.hl',
    style: { 'border-color': '#f59e0b', 'border-width': 3 },
  },
  {
    selector: 'edge.hl',
    style: { 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b', width: 2.4 },
  },
  { selector: 'node:selected', style: { 'border-color': '#2563eb', 'border-width': 3 } },
] as unknown as Stylesheet[]
```

- [ ] **Step 2: 位置持久化 hook**

`apps/web/src/components/graph/useGraphLayout.ts`：

```ts
import { useCallback, useMemo } from 'react'

type Positions = Record<string, { x: number; y: number }>

function keyOf(bookId: string, signature: string): string {
  return `inkloom:graph-layout:${bookId}:${signature}`
}

function parse(raw: string | null): Positions | undefined {
  if (raw === null) return undefined
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
    const out: Positions = {}
    for (const [id, pos] of Object.entries(v as Record<string, unknown>)) {
      if (typeof pos !== 'object' || pos === null) continue
      const p = pos as { x?: unknown; y?: unknown }
      if (typeof p.x === 'number' && typeof p.y === 'number') out[id] = { x: p.x, y: p.y }
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * 拖拽位置存 localStorage，key 带 content signature：
 * 书改了（signature 变）就丢弃旧坐标，避免节点全挤在旧位置。
 */
export function useGraphLayout(bookId: string, signature: string) {
  const preset = useMemo(() => {
    if (typeof window === 'undefined') return undefined
    try {
      return parse(window.localStorage.getItem(keyOf(bookId, signature)))
    } catch {
      return undefined
    }
  }, [bookId, signature])

  const save = useCallback(
    (positions: Positions) => {
      try {
        window.localStorage.setItem(keyOf(bookId, signature), JSON.stringify(positions))
      } catch {
        // 隐私模式/配额满：布局只是便利，失败不打扰作者
      }
    },
    [bookId, signature],
  )

  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(keyOf(bookId, signature))
    } catch {
      // 同上
    }
  }, [bookId, signature])

  return { preset, save, clear }
}
```

- [ ] **Step 3: 画布组件**

`apps/web/src/components/graph/GraphCanvas.tsx`：

```tsx
import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
  type LayoutOptions,
} from 'cytoscape'
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { GraphElements } from '../../lib/graph-elements'
import { GRAPH_STYLE } from './graph-theme'

export type GraphLayoutName = 'cose' | 'breadthfirst' | 'concentric' | 'grid' | 'preset'

export interface GraphCanvasHandle {
  fit(): void
  runLayout(name: GraphLayoutName): void
  focus(id: string): void
  highlight(ids: string[]): void
  resetHighlight(): void
  positions(): Record<string, { x: number; y: number }>
}

interface Props {
  elements: GraphElements
  layout: GraphLayoutName
  preset?: Record<string, { x: number; y: number }> | undefined
  onSelect: (id: string | null) => void
  onContext: (id: string) => void
  onPositions?: (positions: Record<string, { x: number; y: number }>) => void
}

const LAYOUTS: Record<Exclude<GraphLayoutName, 'preset'>, LayoutOptions> = {
  cose: {
    name: 'cose',
    animate: false,
    fit: true,
    padding: 36,
    nodeRepulsion: () => 12000,
    idealEdgeLength: () => 100,
  } as LayoutOptions,
  breadthfirst: {
    name: 'breadthfirst',
    directed: true,
    animate: false,
    padding: 36,
    spacingFactor: 1.1,
  },
  concentric: {
    name: 'concentric',
    animate: false,
    padding: 36,
    levelWidth: () => 2,
  },
  grid: { name: 'grid', animate: false, padding: 36 },
}

function elementDefs(elements: GraphElements): ElementDefinition[] {
  // ★ 复合节点必须先有 parent：类在前、实例在后、边最后
  const classNodes = elements.nodes.filter((n) => n.data.kind === 'class')
  const instances = elements.nodes.filter((n) => n.data.kind === 'instance')
  return [
    ...classNodes.map((n) => ({ group: 'nodes' as const, data: n.data })),
    ...instances.map((n) => ({ group: 'nodes' as const, data: n.data })),
    ...elements.edges.map((e) => ({ group: 'edges' as const, data: { ...e.data } })),
  ]
}

function positionsOf(cy: Core): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  cy.nodes().forEach((n) => {
    out[n.id()] = { x: n.position('x'), y: n.position('y') }
  })
  return out
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(
  { elements, layout, preset, onSelect, onContext, onPositions },
  ref,
) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  const cbRef = useRef({ onSelect, onContext, onPositions })
  cbRef.current = { onSelect, onContext, onPositions }
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const presetRef = useRef(preset)
  presetRef.current = preset

  const applyLayout = (cy: Core, name: GraphLayoutName): void => {
    if (name === 'preset') return
    cy.layout(LAYOUTS[name]).run()
  }

  useImperativeHandle(
    ref,
    () => ({
      fit: () => cyRef.current?.fit(undefined, 36),
      runLayout: (name) => {
        const cy = cyRef.current
        if (cy === null) return
        applyLayout(cy, name)
      },
      focus: (id) => {
        const cy = cyRef.current
        if (cy === null) return
        const node = cy.getElementById(id)
        if (node.empty()) return
        node.select()
        cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.1) }, { duration: 200 })
      },
      highlight: (ids) => {
        const cy = cyRef.current
        if (cy === null) return
        cy.elements().addClass('dimmed').removeClass('hl')
        const picked = cy.collection()
        for (const id of ids) {
          const el = cy.getElementById(id)
          if (!el.empty()) picked.merge(el)
        }
        picked.removeClass('dimmed').addClass('hl')
        if (picked.length > 0) {
          cy.animate({ fit: { eles: picked, padding: 60 } }, { duration: 200 })
        }
      },
      resetHighlight: () => {
        cyRef.current?.elements().removeClass('dimmed').removeClass('hl')
      },
      positions: () => (cyRef.current === null ? {} : positionsOf(cyRef.current)),
    }),
    [],
  )

  useEffect(() => {
    const box = boxRef.current
    if (box === null) return

    const cy = cytoscape({
      container: box,
      style: GRAPH_STYLE,
      wheelSensitivity: 0.2,
      boxSelectionEnabled: true,
      selectionType: 'single',
      elements: [],
    })
    cyRef.current = cy

    cy.on('tap', 'node', (e: EventObject) => {
      cbRef.current.onSelect(e.target.id())
    })
    cy.on('tap', (e: EventObject) => {
      if (e.target === cy) cbRef.current.onSelect(null)
    })
    cy.on('dbltap', 'node', (e: EventObject) => {
      cy.animate({ center: { eles: e.target }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 200 })
    })
    cy.on('cxttap', 'node', (e: EventObject) => {
      cbRef.current.onContext(e.target.id())
    })
    cy.on('dragfree', 'node', () => {
      cbRef.current.onPositions?.(positionsOf(cy))
    })

    const ro = new ResizeObserver(() => {
      cy.resize()
    })
    ro.observe(box)

    return () => {
      ro.disconnect()
      cy.destroy()
      cyRef.current = null
    }
  }, [])

  useEffect(() => {
    const cy = cyRef.current
    if (cy === null) return
    cy.batch(() => {
      cy.elements().remove()
      cy.add(elementDefs(elements))
    })

    const saved = presetRef.current
    if (saved !== undefined) {
      cy.nodes().forEach((n) => {
        const p = saved[n.id()]
        if (p !== undefined) n.position(p)
      })
      cy.fit(undefined, 36)
    }
    applyLayout(cy, layoutRef.current)
  }, [elements])

  return <div ref={boxRef} className="h-full w-full" data-testid="graph-canvas" />
})
```

- [ ] **Step 4: 类型与格式**

Run: `pnpm tsc`
Expected: 无输出。若 `EventObject` / `Stylesheet` 在 `@types/cytoscape` 里名字不同，按实际导出改名（3.31 里是 `EventObject`、`Stylesheet`）。
Run: `pnpm exec biome check --write apps/web/src/components/graph/graph-theme.ts apps/web/src/components/graph/useGraphLayout.ts apps/web/src/components/graph/GraphCanvas.tsx`
Run: `pnpm --filter @inkloom/web build`
Expected: 构建成功（Cytoscape 能被打进 bundle）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/graph/graph-theme.ts apps/web/src/components/graph/useGraphLayout.ts apps/web/src/components/graph/GraphCanvas.tsx
git commit -m "feat(web): cytoscape canvas with persistent layout positions"
```

---

### Task 7: 图谱页面改造（工具栏 / 图例 / 侧栏 / 详情 / 路径）

**Files:**
- Modify: `apps/web/src/lib/graph-elements.ts`（追加 `inducedIds`）
- Modify: `apps/web/src/lib/graph-elements.test.ts`（追加 1 个用例）
- Modify: `apps/web/src/api/types.ts`（追加 `OntologyPathData`）
- Modify: `apps/web/src/api/hooks.ts`（追加 `useOntologyPath`）
- Modify: `apps/web/src/components/graph/GraphCanvas.tsx`（右键坐标 / 位置记忆 / 筛选后复位 / 双击折叠类）
- Modify: `apps/web/src/components/graph/graph-theme.ts`（折叠态样式）
- Modify: `apps/web/src/pages/AgentPage.tsx`（`TOOL_LABEL` 加三个图谱工具）
- Create: `apps/web/src/components/graph/GraphToolbar.tsx`
- Create: `apps/web/src/components/graph/GraphLegend.tsx`
- Create: `apps/web/src/components/graph/GraphSidebar.tsx`
- Create: `apps/web/src/components/graph/GraphDetail.tsx`
- Create: `apps/web/src/components/graph/GraphPathPanel.tsx`
- Modify: `apps/web/src/pages/OntologyPage.tsx`（整体重写，删掉 React Flow 投影）

**Interfaces:**
- Consumes: `GraphElements` / `toGraphElements` / `filterElements` / `nodesWithinHops` / `searchNodes`（Task 5）、`GraphCanvas` / `GraphCanvasHandle` / `GraphLayoutName` / `GraphCanvas` 的 `onPositions`、`useGraphLayout` / `TYPE_LABEL` / `predicateLabel`（Task 6）、`GET /api/ontology/path`（Task 2）
- Produces:
  ```ts
  export function inducedIds(elements: GraphElements, nodeIds: ReadonlySet<string>): string[]
  export interface OntologyPathData {
    found: boolean
    nodes: OntologyNodeRow[]
    edges: OntologyEdgeRow[]
  }
  export function useOntologyPath(from: string | null, to: string | null, maxDepth?: number)
  ```
  组件：`GraphToolbar`（布局/搜索/类型/谓词/跳数/路径状态）、`GraphLegend`（无 props）、`GraphSidebar`（类树 + 统计）、`GraphDetail`（节点/类详情）、`GraphPathPanel`（逐跳路径）。

- [ ] **Step 1: 给投影层补 `inducedIds`（失败测试）**

`apps/web/src/lib/graph-elements.test.ts` 第 1 行 import 改为：

```ts
import { filterElements, inducedIds, nodesWithinHops, searchNodes, toGraphElements } from './graph-elements'
```

在 `describe('filterElements / hops / search', ...)` 的最后一个用例之后追加：

```ts
  it('★ inducedIds 带出节点与两端都在的边', () => {
    const g = toGraphElements(graph())
    expect(inducedIds(g, new Set(['c1', 'grp'])).sort()).toEqual(['c1', 'e-belong', 'grp'])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/web/src/lib/graph-elements.test.ts`
Expected: FAIL — `inducedIds is not a function`（或导入报错）。

- [ ] **Step 3: 实现 `inducedIds`**

在 `apps/web/src/lib/graph-elements.ts` 的 `searchNodes` 之后追加：

```ts
/** 高亮用：给定节点集合，返回节点本身 + 两端都在集合内的边；其余元素交给画布淡出 */
export function inducedIds(elements: GraphElements, nodeIds: ReadonlySet<string>): string[] {
  const out = new Set<string>(nodeIds)
  for (const e of elements.edges) {
    if (nodeIds.has(e.data.source) && nodeIds.has(e.data.target)) out.add(e.data.id)
  }
  return [...out]
}
```

Run: `pnpm vitest run --project unit apps/web/src/lib/graph-elements.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 4: 补路径查询类型与 hook**

`apps/web/src/api/types.ts` 在 `OntologyClassesData` 之后追加：

```ts
/** GET /api/ontology/path 的响应：found=false 时 nodes/edges 为空数组 */
export interface OntologyPathData {
  found: boolean
  nodes: OntologyNodeRow[]
  edges: OntologyEdgeRow[]
}
```

`apps/web/src/api/hooks.ts` 的类型 import 里加 `OntologyPathData`（按字母序放在 `OntologyGraphData` 之后），并在 `useOntologyClasses` 之后追加：

```ts
/** 两个端点都选好才开始查；maxDepth 默认 4（与 core 默认一致） */
export function useOntologyPath(from: string | null, to: string | null, maxDepth = 4) {
  const search = new URLSearchParams()
  if (from !== null) search.set('from', from)
  if (to !== null) search.set('to', to)
  search.set('maxDepth', String(maxDepth))
  return useQuery({
    queryKey: ['ontology', 'path', from, to, maxDepth],
    queryFn: () => api<OntologyPathData>(`/ontology/path?${search.toString()}`),
    enabled: from !== null && to !== null,
  })
}
```

- [ ] **Step 5: 修画布的三件事（右键坐标 / 位置记忆 / 筛选后复位）**

`apps/web/src/components/graph/GraphCanvas.tsx` 按下面六处替换。改完不要在 Task 6 的代码上再叠别的逻辑。

**5.1 `onContext` 带上画布内坐标**

```tsx
  onContext: (id: string, at: { x: number; y: number }) => void
```

（原来是 `onContext: (id: string) => void`。）

**5.2 加一个本次会话的坐标快照**

在 `const presetRef = useRef(preset)` 之后追加：

```tsx
  /** 本次会话里已经拖过/布局过的坐标：筛选导致元素重建时用它复位 */
  const posRef = useRef<Record<string, { x: number; y: number }>>({})
```

**5.3 布局完成时只在用户主动换布局时落盘**

```tsx
  /** persist=true 只用于用户主动换布局：布局完成就把坐标存下来 */
  const applyLayout = (cy: Core, name: GraphLayoutName, persist: boolean): void => {
    if (name === 'preset') return
    const l = cy.layout(LAYOUTS[name])
    if (persist) {
      l.one('layoutstop', () => {
        posRef.current = positionsOf(cy)
        cbRef.current.onPositions?.(posRef.current)
      })
    }
    l.run()
  }
```

**5.4 命令式 `runLayout` 走持久化分支**

```tsx
      runLayout: (name) => {
        const cy = cyRef.current
        if (cy === null) return
        applyLayout(cy, name, true)
      },
```

**5.5 右键给坐标，拖拽同步快照**

```tsx
    cy.on('cxttap', 'node', (e: EventObject) => {
      const at = e.target.renderedPosition() as { x: number; y: number }
      cbRef.current.onContext(e.target.id(), at)
    })
    cy.on('dragfree', 'node', () => {
      posRef.current = positionsOf(cy)
      cbRef.current.onPositions?.(posRef.current)
    })
```

**5.6 数据变化：先布局给新节点占位，再把已知坐标搬回去**

```tsx
  useEffect(() => {
    const cy = cyRef.current
    if (cy === null) return
    cy.batch(() => {
      cy.elements().remove()
      cy.add(elementDefs(elements))
    })

    // ★ 过滤只该增减元素，不该把作者拖好的图推倒重来：跑完布局再把已知坐标覆盖回去
    const known = { ...(presetRef.current ?? {}), ...posRef.current }
    applyLayout(cy, layoutRef.current, false)
    cy.nodes().forEach((n) => {
      const p = known[n.id()]
      if (p !== undefined) n.position(p)
    })
    posRef.current = positionsOf(cy)
    cy.fit(undefined, 36)
  }, [elements])
```

**5.7 双击类节点折叠 / 展开**

把 Task 6 的 dbltap 处理器换成：

```tsx
    cy.on('dbltap', 'node', (e: EventObject) => {
      const node = e.target
      if (node.data('kind') === 'class') {
        // 类分组框双击折叠：隐藏/显示所有后代，框自己留下当标题
        const collapsed = node.data('collapsed') === true
        node.data('collapsed', !collapsed)
        node.descendants().style('display', collapsed ? 'element' : 'none')
        return
      }
      cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 200 })
    })
```

**5.8 折叠态给个视觉标记**

`apps/web/src/components/graph/graph-theme.ts` 在 `node[kind="instance"][?virtual]` 规则之后插入：

```ts
  {
    selector: 'node[kind="class"][?collapsed]',
    style: { 'border-style': 'solid', 'background-opacity': 0.9 },
  },
```

- [ ] **Step 6: 工具栏**

`apps/web/src/components/graph/GraphToolbar.tsx`：

```tsx
import type { GraphLayoutName } from './GraphCanvas'
import { TYPE_LABEL } from './graph-theme'

export interface PredicateOption {
  id: string
  label: string
}

interface Props {
  layout: GraphLayoutName
  onLayout: (name: GraphLayoutName) => void
  search: string
  onSearch: (text: string) => void
  hits: number
  types: ReadonlySet<string>
  onTypes: (next: Set<string>) => void
  predicates: ReadonlySet<string>
  onPredicates: (next: Set<string>) => void
  predicateOptions: PredicateOption[]
  hops: number
  onHops: (n: number) => void
  anchorName: string | null
  pathFromName: string | null
  pathToName: string | null
  onClearPath: () => void
  highlighted: number
  onClearHighlight: () => void
  onFit: () => void
  onResetPositions: () => void
}

const LAYOUT_LABEL: Record<GraphLayoutName, string> = {
  cose: '力导向',
  breadthfirst: '层级',
  concentric: '同心圆',
  grid: '网格',
  preset: '手动位置',
}

/** 与 TYPE_LABEL 的键保持一致；类节点不参与类型过滤 */
const NODE_TYPES = ['character', 'group', 'place', 'rule', 'item', 'concept']

const BTN = 'rounded border border-neutral-300 px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100'

function chip(active: boolean): string {
  return `rounded border px-1.5 py-0.5 text-[11px] ${
    active
      ? 'border-neutral-900 bg-neutral-900 text-white'
      : 'border-neutral-300 text-neutral-600 hover:bg-neutral-100'
  }`
}

function toggle(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

export function GraphToolbar(p: Props) {
  return (
    <header className="shrink-0 border-b border-neutral-200 bg-white px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-[11px] text-neutral-500">
          布局
          <select
            value={p.layout}
            onChange={(e) => p.onLayout(e.target.value as GraphLayoutName)}
            className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-[11px]"
          >
            {(Object.keys(LAYOUT_LABEL) as GraphLayoutName[])
              .filter((name) => name !== 'preset')
              .map((name) => (
                <option key={name} value={name}>
                  {LAYOUT_LABEL[name]}
                </option>
              ))}
          </select>
        </label>
        <span className="text-[10px] text-neutral-400">切换布局会重置拖拽位置</span>

        <label className="flex items-center gap-1 text-[11px] text-neutral-500">
          <input
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            placeholder="搜名字 / ID"
            aria-label="搜索节点名"
            className="w-36 rounded border border-neutral-300 px-2 py-0.5 text-[11px] focus:border-neutral-500 focus:outline-none"
          />
          {p.search.trim().length > 0 &&
            (p.hits > 0 ? (
              <span className="text-neutral-400">{p.hits} 个命中</span>
            ) : (
              <span className="text-rose-600">没有匹配</span>
            ))}
        </label>

        <button type="button" onClick={p.onFit} className={BTN}>
          适应视图
        </button>
        <button type="button" onClick={p.onResetPositions} className={BTN}>
          重新布局并清除位置
        </button>
        <div className="ml-auto flex items-center gap-2">
          {p.highlighted > 0 && (
            <span className="text-[11px] text-amber-700">高亮 {p.highlighted} 项</span>
          )}
          <button type="button" onClick={p.onClearHighlight} className={BTN}>
            清除高亮
          </button>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[10px] text-neutral-400">类型</span>
        <button type="button" onClick={() => p.onTypes(new Set())} className={chip(p.types.size === 0)}>
          全部
        </button>
        {NODE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => p.onTypes(toggle(p.types, t))}
            className={chip(p.types.has(t))}
          >
            {TYPE_LABEL[t] ?? t}
          </button>
        ))}

        <details className="relative">
          <summary className="cursor-pointer text-[11px] text-neutral-500">
            谓词（{p.predicates.size === 0 ? '全部' : p.predicates.size}）
          </summary>
          <div className="absolute z-20 mt-1 max-h-56 w-48 overflow-y-auto rounded border border-neutral-300 bg-white p-1.5 shadow-md">
            <button
              type="button"
              onClick={() => p.onPredicates(new Set())}
              className="block w-full rounded px-1 py-0.5 text-left text-[11px] text-neutral-500 hover:bg-neutral-100"
            >
              全部谓词
            </button>
            {p.predicateOptions.map((o) => (
              <label
                key={o.id}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
              >
                <input
                  type="checkbox"
                  checked={p.predicates.has(o.id)}
                  onChange={() => p.onPredicates(toggle(p.predicates, o.id))}
                />
                {o.label}
              </label>
            ))}
          </div>
        </details>

        <label className="flex items-center gap-1 text-[11px] text-neutral-500">
          只看
          <select
            value={p.hops}
            onChange={(e) => p.onHops(Number(e.target.value))}
            disabled={p.anchorName === null}
            className="rounded border border-neutral-300 bg-white px-1 py-0.5 text-[11px] disabled:opacity-50"
          >
            <option value={0}>不限</option>
            <option value={1}>1 跳邻居</option>
            <option value={2}>2 跳邻居</option>
            <option value={3}>3 跳邻居</option>
          </select>
        </label>
        <span className="text-[10px] text-neutral-400">
          {p.anchorName === null ? '先点一个节点作为锚点' : `锚点：${p.anchorName}`}
        </span>

        {(p.pathFromName !== null || p.pathToName !== null) && (
          <span className="flex items-center gap-1 text-[11px] text-neutral-600">
            路径：{p.pathFromName ?? '未设起点'} → {p.pathToName ?? '未设终点'}
            <button
              type="button"
              onClick={p.onClearPath}
              className="text-[11px] text-neutral-500 underline decoration-dotted hover:text-neutral-900"
            >
              清除
            </button>
          </span>
        )}
      </div>
    </header>
  )
}
```

- [ ] **Step 7: 图例**

`apps/web/src/components/graph/GraphLegend.tsx`：

```tsx
import { TYPE_COLOR, TYPE_LABEL } from './graph-theme'

const NODE_TYPES = ['character', 'group', 'place', 'rule', 'item', 'concept']

/** 画布左下角的图例：颜色表达类型，线型表达数据来源 */
export function GraphLegend() {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-neutral-200 bg-white/95 px-3 py-2 text-[10px] leading-4 text-neutral-500">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {NODE_TYPES.map((t) => (
          <span key={t} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm border-2"
              style={{ borderColor: TYPE_COLOR[t] }}
            />
            {TYPE_LABEL[t] ?? t}
          </span>
        ))}
      </div>
      <p className="mt-1 border-t border-neutral-100 pt-1">
        虚线框 / 虚线边 = 既有数据的只读投影 · 淡出边 = 已废止 · 浅灰框 = 类分组
      </p>
    </div>
  )
}
```

- [ ] **Step 8: 左栏（类树 + 统计）**

`apps/web/src/components/graph/GraphSidebar.tsx`：

```tsx
import type { ReactNode } from 'react'
import type { OntologyClassRow } from '../../api/types'

interface Props {
  classes: OntologyClassRow[]
  active: string | null
  onPick: (id: string | null) => void
  issuesOnly: boolean
  onIssuesOnly: (value: boolean) => void
  stats: { nodes: number; total: number; edges: number; issues: number; truncated: boolean }
}

function ClassTree({
  classes,
  active,
  onPick,
}: {
  classes: OntologyClassRow[]
  active: string | null
  onPick: (id: string | null) => void
}) {
  const byParent = new Map<string | null, OntologyClassRow[]>()
  for (const c of classes) {
    const list = byParent.get(c.parentId) ?? []
    list.push(c)
    byParent.set(c.parentId, list)
  }

  const row = (c: OntologyClassRow, depth: number, key: string): ReactNode => (
    <button
      key={key}
      type="button"
      onClick={() => onPick(active === c.id ? null : c.id)}
      className={`flex w-full items-center rounded px-2 py-1 text-left text-[12px] ${
        active === c.id ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
      }`}
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="truncate">{c.name}</span>
      <span
        className={`ml-auto shrink-0 text-[10px] ${
          active === c.id ? 'text-neutral-300' : 'text-neutral-400'
        }`}
      >
        {c.instanceCount ?? 0}
      </span>
    </button>
  )

  const render = (parent: string | null, depth: number): ReactNode[] =>
    (byParent.get(parent) ?? []).flatMap((c) => [row(c, depth, c.id), ...render(c.id, depth + 1)])

  // 父类缺失或成环的类进不了树：不能让他俩直接消失（spec §6：图仍可渲染，该分支标红）
  const reachable = new Set<string>()
  const walk = (parent: string | null): void => {
    for (const c of byParent.get(parent) ?? []) {
      if (reachable.has(c.id)) continue
      reachable.add(c.id)
      walk(c.id)
    }
  }
  walk(null)
  const orphans = classes.filter((c) => !reachable.has(c.id))

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={() => onPick(null)}
        className={`flex w-full items-center rounded px-2 py-1 text-left text-[12px] ${
          active === null ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
        }`}
      >
        全部节点
      </button>
      {render(null, 0)}
      {orphans.length > 0 && (
        <>
          <p className="mt-2 px-2 text-[10px] text-rose-600">孤立类（父类缺失或成环）</p>
          {orphans.map((c) => row(c, 0, c.id))}
        </>
      )}
    </div>
  )
}

export function GraphSidebar({ classes, active, onPick, issuesOnly, onIssuesOnly, stats }: Props) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/60">
      <div className="border-b border-neutral-200 px-3 py-3">
        <h1 className="text-sm font-semibold text-neutral-900">图谱</h1>
        <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">
          类—实例—边：同类的实例装进一个分组框，拖动位置会记住。
        </p>
        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
          <input
            type="checkbox"
            checked={issuesOnly}
            onChange={(e) => onIssuesOnly(e.target.checked)}
          />
          只看有问题的节点
        </label>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-3">
        {classes.length === 0 ? (
          <p className="px-1 text-[11px] text-neutral-400">读取类表…</p>
        ) : (
          <ClassTree classes={classes} active={active} onPick={onPick} />
        )}
      </div>
      <div className="border-t border-neutral-200 px-3 py-2 text-[10px] leading-4 text-neutral-500">
        {stats.total === 0
          ? '—'
          : `${stats.nodes}/${stats.total} 节点 · ${stats.edges} 边 · ${stats.issues} 问题`}
        {stats.truncated && (
          <p className="text-amber-700">
            节点太多，只画了前 {stats.nodes} 个；用类或问题筛选缩小范围
          </p>
        )}
      </div>
    </aside>
  )
}
```

- [ ] **Step 9: 详情栏（从页面搬出来）**

`apps/web/src/components/graph/GraphDetail.tsx`：

```tsx
import type { OntologyDetailData, OntologyEdgeRow } from '../../api/types'
import type { ModuleId } from '../../stores/session'
import { predicateLabel, TYPE_LABEL } from './graph-theme'

/** 虚拟节点/边的来源文件 → 该去哪个模块改（spec §5.2 要求给出口） */
const ORIGIN: Record<string, { label: string; module: ModuleId }> = {
  'characters/index.json': { label: '角色卡', module: 'cast' },
  'characters/relations.json': { label: '关系网络', module: 'cast' },
  'world/locations.json': { label: '世界地图', module: 'world' },
  'world/routes.json': { label: '世界地图', module: 'world' },
  'world/rules.json': { label: '世界规则', module: 'world' },
  'story/threads.json': { label: '线索轨迹', module: 'story' },
  'story/arcs.json': { label: '故事弧', module: 'story' },
}

/** 节点详情可能是「类」（instanceOf 的端点），两种情况分开渲染 */
export function GraphDetail({
  detail,
  classNames,
  nodeNames,
  predicateLabels,
  onGoModule,
}: {
  detail: OntologyDetailData
  classNames: Map<string, string>
  nodeNames: Map<string, string>
  predicateLabels: Map<string, string>
  onGoModule: (module: ModuleId) => void
}) {
  /** 端点名字：服务端给的 > 节点 > 类 > 裸 id（悬空端点只能退回 id） */
  const edgeNameOf = (e: OntologyEdgeRow, side: 'from' | 'to'): string =>
    (side === 'from' ? e.fromName : e.toName) ?? nameOf(side === 'from' ? e.from : e.to)
  const nameOf = (id: string): string => nodeNames.get(id) ?? classNames.get(id) ?? id

  if (detail.node === null) {
    return (
      <div className="space-y-3">
        <div>
          <p className="text-[13px] font-medium text-neutral-900">类「{detail.class.name}」</p>
          <p className="mt-0.5 text-[10px] text-neutral-500">
            {detail.class.id} · {detail.class.instanceCount} 个实例
          </p>
        </div>
        <div>
          <p className="mb-1 text-[10px] font-medium text-neutral-400">实例</p>
          {detail.instances.length === 0 ? (
            <p className="text-[11px] text-neutral-500">还没有节点属于这个类。</p>
          ) : (
            <ul className="space-y-0.5">
              {detail.instances.map((id) => (
                <li key={id} className="text-[11px] leading-5 text-neutral-600">
                  {nameOf(id)}
                </li>
              ))}
            </ul>
          )}
        </div>
        {detail.issues.length > 0 && (
          <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-5 text-amber-800">
            {detail.issues.map((i) => (
              <p key={`${i.code}-${i.subject}`}>{i.message}</p>
            ))}
          </div>
        )}
      </div>
    )
  }

  const node = detail.node
  const origin = node.sourceFile === undefined ? undefined : ORIGIN[node.sourceFile]
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[13px] font-medium text-neutral-900">{node.name}</p>
        <p className="mt-0.5 text-[10px] text-neutral-500">
          {TYPE_LABEL[node.type] ?? node.type} ·{' '}
          {node.virtual ? '虚拟节点（来自原文件）' : '图谱节点'} · {node.id}
        </p>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-medium text-neutral-400">所属类</p>
        <p className="text-[11px] text-neutral-700">
          {node.classIds.map((id) => classNames.get(id) ?? id).join(' · ') || '未分类'}
        </p>
      </div>

      <div>
        <p className="mb-1 text-[10px] font-medium text-neutral-400">属性</p>
        {Object.keys(node.attrs).length === 0 ? (
          <p className="text-[11px] text-neutral-500">—</p>
        ) : (
          <ul className="space-y-0.5">
            {Object.entries(node.attrs).map(([k, v]) => (
              <li key={k} className="text-[11px] leading-5 text-neutral-600">
                <span className="text-neutral-400">{k}</span>：{v}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="mb-1 text-[10px] font-medium text-neutral-400">
          关系（{detail.edges.length}）
        </p>
        {detail.edges.length === 0 ? (
          <p className="text-[11px] text-neutral-500">这个节点还没有边。</p>
        ) : (
          <ul className="space-y-0.5">
            {detail.edges.map((e) => (
              <li key={e.id} className="text-[11px] leading-5 text-neutral-600">
                {e.from === node.id ? '→' : '←'} {predicateLabel(e.predicate, predicateLabels)}{' '}
                {e.from === node.id ? edgeNameOf(e, 'to') : edgeNameOf(e, 'from')}
                {e.sinceChapter === undefined ? '' : ` · 第 ${e.sinceChapter} 章起`}
                {e.retracted === true ? ' · 已废止' : ''}
                {e.virtual ? <span className="ml-1 text-[10px] text-neutral-400">只读</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {node.sourceFile !== undefined && (
        <p className="text-[10px] leading-4 text-neutral-500">
          来源：{origin?.label ?? node.sourceFile}
          {origin !== undefined && (
            <button
              type="button"
              onClick={() => onGoModule(origin.module)}
              className="ml-1 underline decoration-dotted hover:text-neutral-900"
            >
              去「{origin.label}」修改
            </button>
          )}
        </p>
      )}

      {detail.issues.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-5 text-amber-800">
          {detail.issues.map((i) => (
            <p key={`${i.code}-${i.subject}`}>{i.message}</p>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 10: 路径面板**

`apps/web/src/components/graph/GraphPathPanel.tsx`：

```tsx
import type { OntologyPathData } from '../../api/types'
import { predicateLabel } from './graph-theme'

interface Props {
  fromName: string
  toName: string
  path: OntologyPathData | undefined
  loading: boolean
  error: string | null
  predicateLabels: Map<string, string>
  onClear: () => void
}

export function GraphPathPanel({
  fromName,
  toName,
  path,
  loading,
  error,
  predicateLabels,
  onClear,
}: Props) {
  const names = new Map((path?.nodes ?? []).map((n) => [n.id, n.name]))
  const nameOf = (id: string): string => names.get(id) ?? id

  return (
    <section className="border-b border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium text-neutral-500">
          路径 · {fromName} → {toName}
        </p>
        <button
          type="button"
          onClick={onClear}
          className="ml-auto text-[11px] text-neutral-500 hover:text-neutral-900"
        >
          关闭
        </button>
      </div>
      {loading && <p className="mt-1 text-[11px] text-neutral-400">查最短路径…</p>}
      {error !== null && <p className="mt-1 text-[11px] text-rose-700">{error}</p>}
      {path !== undefined &&
        !loading &&
        (path.found ? (
          <ol className="mt-1 space-y-0.5">
            {path.edges.map((e) => (
              <li key={e.id} className="text-[11px] leading-5 text-neutral-700">
                {nameOf(e.from)}{' '}
                <span className="text-neutral-400">
                  —{predicateLabel(e.predicate, predicateLabels)}→
                </span>{' '}
                {nameOf(e.to)}
                {e.virtual ? <span className="ml-1 text-[10px] text-neutral-400">只读</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-[11px] text-neutral-500">
            最多 4 跳内没有通路；试试放宽类型 / 谓词筛选。
          </p>
        ))}
    </section>
  )
}
```

- [ ] **Step 11: 重写页面**

`apps/web/src/pages/OntologyPage.tsx` 整体替换为（删除 React Flow 的 import、`flow` useMemo、`col-` 标题节点与本地常量）：

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBook, useOntologyGraph, useOntologyNode, useOntologyPath } from '../api/hooks'
import {
  GraphCanvas,
  type GraphCanvasHandle,
  type GraphLayoutName,
} from '../components/graph/GraphCanvas'
import { GraphDetail } from '../components/graph/GraphDetail'
import { GraphLegend } from '../components/graph/GraphLegend'
import { GraphPathPanel } from '../components/graph/GraphPathPanel'
import { GraphSidebar } from '../components/graph/GraphSidebar'
import { GraphToolbar } from '../components/graph/GraphToolbar'
import { useGraphLayout } from '../components/graph/useGraphLayout'
import {
  filterElements,
  inducedIds,
  nodesWithinHops,
  searchNodes,
  toGraphElements,
} from '../lib/graph-elements'
import { useSessionStore } from '../stores/session'

interface ContextMenu {
  id: string
  x: number
  y: number
}

export function OntologyPage() {
  const [classId, setClassId] = useState<string | null>(null)
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [layout, setLayout] = useState<GraphLayoutName>('cose')
  const [types, setTypes] = useState<Set<string>>(new Set())
  const [predicates, setPredicates] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [hops, setHops] = useState(0)
  const [pathFrom, setPathFrom] = useState<string | null>(null)
  const [pathTo, setPathTo] = useState<string | null>(null)
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const canvasRef = useRef<GraphCanvasHandle | null>(null)
  const setModule = useSessionStore((s) => s.setModule)

  const { data: book } = useBook()
  const { data, isLoading, error } = useOntologyGraph({
    classId: classId ?? undefined,
    issuesOnly,
  })
  const detail = useOntologyNode(selected)
  const path = useOntologyPath(pathFrom, pathTo)

  const base = useMemo(
    () => (data === undefined ? { nodes: [], edges: [] } : toGraphElements(data)),
    [data],
  )
  const filtered = useMemo(
    () => filterElements(base, { nodeTypes: types, predicates }),
    [base, types, predicates],
  )

  const classNames = useMemo(() => new Map((data?.classes ?? []).map((c) => [c.id, c.name])), [data])
  const nodeNames = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n.name])), [data])
  const predicateLabels = useMemo(
    () => new Map((data?.predicates ?? []).map((p) => [p.id, p.label])),
    [data],
  )
  const predicateOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of base.edges) seen.set(e.data.predicate, e.data.label)
    return [...seen]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  }, [base])

  const { preset, save, clear } = useGraphLayout(book?.id ?? 'none', data?.signature ?? 'none')

  /** 详情栏/工具栏都要显示名字：节点优先，类其次，兜底 id */
  const nameOf = (id: string | null): string =>
    id === null ? '—' : (nodeNames.get(id) ?? classNames.get(id) ?? id)

  // 换了筛选后，右栏不能还停在一个已经不在画布上的节点
  useEffect(() => {
    if (selected === null || data === undefined) return
    if (!filtered.nodes.some((n) => n.data.id === selected)) setSelected(null)
  }, [filtered, selected, data])

  const hits = useMemo(() => searchNodes(filtered, search), [filtered, search])

  useEffect(() => {
    if (hits[0] !== undefined) canvasRef.current?.focus(hits[0])
  }, [hits])

  // 高亮优先级：路径 > 搜索 > N 跳邻居；都没有就不高亮
  const highlightNodes = useMemo<Set<string> | null>(() => {
    const found = path.data
    if (found?.found === true) return new Set(found.nodes.map((n) => n.id))
    if (hits.length > 0) return new Set(hits)
    if (selected !== null && hops > 0) return nodesWithinHops(filtered, selected, hops)
    return null
  }, [path.data, hits, selected, hops, filtered])

  const highlightIds = useMemo(
    () => (highlightNodes === null ? [] : inducedIds(filtered, highlightNodes)),
    [filtered, highlightNodes],
  )

  // 元素重建会清掉 class，所以 filtered 也要在依赖里
  useEffect(() => {
    const handle = canvasRef.current
    if (handle === null) return
    handle.resetHighlight()
    if (highlightIds.length > 0) handle.highlight(highlightIds)
  }, [highlightIds, filtered])

  const changeLayout = (name: GraphLayoutName): void => {
    setLayout(name)
    canvasRef.current?.runLayout(name)
  }

  const clearHighlight = (): void => {
    setSearch('')
    setHops(0)
    setPathFrom(null)
    setPathTo(null)
  }

  const resetPositions = (): void => {
    clear()
    canvasRef.current?.runLayout(layout === 'preset' ? 'cose' : layout)
  }

  // 类节点不是图里的实体，路径端点只能是实例
  const menuKind =
    menu === null ? undefined : filtered.nodes.find((n) => n.data.id === menu.id)?.data.kind

  return (
    <div className="flex h-full min-h-0 w-full bg-white">
      <GraphSidebar
        classes={data?.classes ?? []}
        active={classId}
        onPick={setClassId}
        issuesOnly={issuesOnly}
        onIssuesOnly={setIssuesOnly}
        stats={{
          nodes: data?.nodes.length ?? 0,
          total: data?.total ?? 0,
          edges: data?.edges.length ?? 0,
          issues: data?.issues.length ?? 0,
          truncated: data?.truncated === true,
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <GraphToolbar
          layout={layout}
          onLayout={changeLayout}
          search={search}
          onSearch={setSearch}
          hits={hits.length}
          types={types}
          onTypes={setTypes}
          predicates={predicates}
          onPredicates={setPredicates}
          predicateOptions={predicateOptions}
          hops={hops}
          onHops={setHops}
          anchorName={selected === null ? null : nameOf(selected)}
          pathFromName={pathFrom === null ? null : nameOf(pathFrom)}
          pathToName={pathTo === null ? null : nameOf(pathTo)}
          onClearPath={() => {
            setPathFrom(null)
            setPathTo(null)
          }}
          highlighted={highlightIds.length}
          onClearHighlight={clearHighlight}
          onFit={() => canvasRef.current?.fit()}
          onResetPositions={resetPositions}
        />

        <div className="relative min-h-0 flex-1">
          {isLoading && <p className="p-6 text-sm text-neutral-500">构建图谱…</p>}
          {error !== null && <p className="p-6 text-sm text-rose-700">{error.message}</p>}

          {data !== undefined && filtered.nodes.length === 0 && (
            <div className="p-6">
              {data.nodes.length === 0 ? (
                <>
                  <p className="text-sm text-neutral-600">这本书还没有入图的实体。</p>
                  <p className="mt-2 text-[11px] leading-5 text-neutral-500">
                    图谱由现有实体自动生成：先去「角色 / 世界 /
                    故事」建内容，这里就会出现人物、地点、规则节点。
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-neutral-600">当前筛选下没有节点。</p>
                  <button
                    type="button"
                    onClick={() => {
                      setTypes(new Set())
                      setPredicates(new Set())
                      setSearch('')
                      setClassId(null)
                      setIssuesOnly(false)
                    }}
                    className="mt-2 rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
                  >
                    清除全部筛选
                  </button>
                </>
              )}
            </div>
          )}

          {data !== undefined && filtered.nodes.length > 0 && (
            <>
              <GraphCanvas
                ref={canvasRef}
                elements={filtered}
                layout={layout}
                preset={preset}
                onSelect={(id) => {
                  setSelected(id)
                  setMenu(null)
                }}
                onContext={(id, at) => setMenu({ id, x: at.x, y: at.y })}
                onPositions={save}
              />
              <GraphLegend />
              {menu !== null && (
                <div
                  className="absolute z-10 w-44 rounded border border-neutral-300 bg-white py-1 text-[11px] shadow-md"
                  style={{ left: menu.x, top: menu.y }}
                >
                  <p className="truncate px-2 py-1 text-[10px] text-neutral-400">
                    {nameOf(menu.id)}
                  </p>
                  {menuKind !== 'class' && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setPathFrom(menu.id)
                          if (pathTo === menu.id) setPathTo(null)
                          setMenu(null)
                        }}
                        className="block w-full px-2 py-1 text-left text-neutral-700 hover:bg-neutral-100"
                      >
                        设为路径起点
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPathTo(menu.id)
                          if (pathFrom === menu.id) setPathFrom(null)
                          setMenu(null)
                        }}
                        className="block w-full px-2 py-1 text-left text-neutral-700 hover:bg-neutral-100"
                      >
                        设为路径终点
                      </button>
                    </>
                  )}
                  {menuKind === 'class' && (
                    <p className="px-2 py-1 text-[10px] text-neutral-400">类节点不能作为路径端点</p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(menu.id)
                      setMenu(null)
                    }}
                    className="block w-full px-2 py-1 text-left text-neutral-700 hover:bg-neutral-100"
                  >
                    查看详情
                  </button>
                </div>
              )}
            </>
          )}

          {data !== undefined && (data.warnings.length > 0 || data.issues.length > 0) && (
            <div className="pointer-events-none absolute right-2 top-2 flex w-80 flex-col gap-1">
              {data.warnings.length > 0 && (
                <div className="pointer-events-auto rounded border border-neutral-300 bg-white/95 px-3 py-2 text-[11px] leading-5 text-neutral-700">
                  {data.warnings.slice(0, 3).map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                  {data.warnings.length > 3 && <p>另有 {data.warnings.length - 3} 条</p>}
                </div>
              )}
              {data.issues.length > 0 && (
                <div className="pointer-events-auto rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                  {data.issues.slice(0, 3).map((i) => (
                    <p key={`${i.code}-${i.subject}`}>
                      [{i.code}] {i.message}
                    </p>
                  ))}
                  {data.issues.length > 3 && <p>另有 {data.issues.length - 3} 条问题</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/60">
        {pathFrom !== null && pathTo !== null && (
          <GraphPathPanel
            fromName={nameOf(pathFrom)}
            toName={nameOf(pathTo)}
            path={path.data}
            loading={path.isLoading}
            error={path.error === null ? null : path.error.message}
            predicateLabels={predicateLabels}
            onClear={() => {
              setPathFrom(null)
              setPathTo(null)
            }}
          />
        )}
        <div className="border-b border-neutral-200 px-4 py-3">
          <p className="text-[11px] font-medium text-neutral-500">节点详情</p>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {selected === null ? (
            <p className="text-[11px] leading-5 text-neutral-500">
              点画布上的节点查看属性、关系与来源；右键节点可设路径起终点。
            </p>
          ) : detail.data === undefined ? (
            <p className="text-[11px] text-neutral-400">
              {detail.isLoading ? '读取…' : '没有数据'}
            </p>
          ) : (
            <GraphDetail
              detail={detail.data}
              classNames={classNames}
              nodeNames={nodeNames}
              predicateLabels={predicateLabels}
              onGoModule={setModule}
            />
          )}
        </div>
      </aside>
    </div>
  )
}
```

- [ ] **Step 12: 聊天里的工具名**

`apps/web/src/pages/AgentPage.tsx` 的 `TOOL_LABEL` 在 `read_lore: '读资料卡',` 之后加三行：

```ts
  query_graph: '查图谱',
  find_path: '查路径',
  explain_fact: '解释关系',
```

- [ ] **Step 13: 类型、格式与构建**

Run: `pnpm tsc`
Expected: 无输出。若 biome 的 `useExhaustiveDependencies` 对高亮 effect 报依赖，按提示补依赖；不要删 `filtered`（元素重建必须重放高亮）。
Run: `pnpm exec biome check --write apps/web/src/lib/graph-elements.ts apps/web/src/lib/graph-elements.test.ts apps/web/src/api/types.ts apps/web/src/api/hooks.ts apps/web/src/components/graph/GraphCanvas.tsx apps/web/src/components/graph/graph-theme.ts apps/web/src/components/graph/GraphToolbar.tsx apps/web/src/components/graph/GraphLegend.tsx apps/web/src/components/graph/GraphSidebar.tsx apps/web/src/components/graph/GraphDetail.tsx apps/web/src/components/graph/GraphPathPanel.tsx apps/web/src/pages/OntologyPage.tsx apps/web/src/pages/AgentPage.tsx`
Run: `pnpm test`
Expected: PASS（405 个单元用例：Task 1 的 9 + Task 3 的 5 + Task 4 的 2 + Task 5 的 6 + Task 7 的 1，加上既有 382）。
Run: `pnpm --filter @inkloom/web build`
Expected: 构建成功。

- [ ] **Step 14: 提交**

```bash
git add apps/web/src/lib/graph-elements.ts apps/web/src/lib/graph-elements.test.ts apps/web/src/api/types.ts apps/web/src/api/hooks.ts apps/web/src/components/graph apps/web/src/pages/OntologyPage.tsx apps/web/src/pages/AgentPage.tsx
git commit -m "feat(web): rebuild ontology page on cytoscape with filters and paths"
```

---

### Task 8: 全量验证、真机验收与 README

**Files:**
- Modify: `README.md`（图谱章节、表格行、验证计数、截图引用）
- Create: `docs/screenshots/accept-ontology-v2.png`（验收截图）

**Interfaces:**
- Consumes: 前七个任务的全部产出
- Produces: 一份可复现的验收记录；无新代码

- [ ] **Step 1: 全量验证**

Run: `pnpm verify`
Expected: `biome`、`tsc`（含 web）、`check-deps` 全过；单元 405、集成 338。数字不符时先查是不是漏跑用例，确认后把实际数字写进 README 的验证行。

- [ ] **Step 2: 起服务**

```powershell
$api = Start-Process pnpm -ArgumentList 'api' -PassThru
$web = Start-Process pnpm -ArgumentList 'web' -PassThru
Start-Sleep -Seconds 8
Invoke-RestMethod http://127.0.0.1:8787/api/book | ConvertTo-Json -Depth 2
Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object -First 1
```

Expected: `/api/book` 返回七霞；5173 在监听。两个 PID 记下来，Step 8 用。

- [ ] **Step 3: 浏览器验收（逐项过，任何一项不过就停下来修）**

打开 `http://localhost:5173` → 选「七霞」→ 左栏「图谱」。

1. 画布出现浅灰虚线**类分组框**，实例是圆角矩形节点，父级框随子节点扩大；看不到 `instanceOf` 边。
2. 拖一个实例到框外另一点 → F5 → 该节点仍在拖到的位置（localStorage 里能看到 `inkloom:graph-layout:*`）。
3. 双击类分组框 → 框内子节点收起，边框变实线；再双击恢复。
4. 布局切「层级」→ 节点重排；工具栏提示「切换布局会重置拖拽位置」。
5. 类型点「人物」→ 只剩人物实例与它们所在的类框（空类框消失）；点「全部」恢复。
6. 谓词下拉勾「隶属」→ 只剩 `belongsTo` 边；点「全部谓词」恢复。
7. 点一个节点 → 「只看 1 跳邻居」→ 其余元素淡出；点「清除高亮」恢复。
8. 搜索框输入「青云」→ 命中节点高亮并居中；输入 `zzzz` → 显示「没有匹配」。
9. 右键节点 → 「设为路径起点」，再右键另一个 → 「设为路径终点」：有通路时右栏逐跳列出「A —隶属→ B」，画布只剩路径高亮；无通路时右栏显示「最多 4 跳内没有通路」。
10. 点类节点 → 右栏显示类详情与实例列表；点实例 → 显示属性、关系与来源。
11. 左栏类树点「宗门」→ 画布只剩该类实例；再点「全部节点」恢复。
12. 在画布空白处按住拖出选框 → 框住的节点被选中（蓝色选中态）；点空白取消。

- [ ] **Step 4: 截图存档**

用 browser-use 在 1440×900 下截整页，要求图里能同时看到类分组框、至少一条边标签与右栏详情（或路径面板）。把返回的 png 复制到仓库：

```powershell
Copy-Item <browser-use 返回的 png 路径> docs/screenshots/accept-ontology-v2.png
```

- [ ] **Step 5: HTTP 端点验收**

```powershell
$g = Invoke-RestMethod http://127.0.0.1:8787/api/ontology/graph
$g.nodes.Count
$q = Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/ontology/query -ContentType 'application/json' -Body '{"limit":5}'
$q.nodes.Count
$first = $g.nodes[0]
$cls = $first.classIds[-1]
$e = Invoke-RestMethod "http://127.0.0.1:8787/api/ontology/explain?from=$($first.id)&predicate=instanceOf&to=$cls"
$e | ConvertTo-Json -Depth 3
$ids = @($g.nodes | Select-Object -First 2 -ExpandProperty id)
$p = Invoke-RestMethod "http://127.0.0.1:8787/api/ontology/path?from=$($ids[0])&to=$($ids[1])&maxDepth=4"
$p.found
```

Expected: `$q.nodes.Count` ≤ 5；`$e.reason` 非空且包含类名；`$p.found` 是 `True` 或 `False`（都算通过，只要不是 500）。

- [ ] **Step 6: 对话里的图谱工具**

共创页发一句：

> 先用 query_graph 查 nodeType=character、limit=5 的节点，再对第一个节点用 explain_fact 解释它 instanceOf 所属类的关系。

Expected: 消息里出现「查图谱」与「解释关系」两张工具卡；回答点名书里真实存在的角色，并说明属于哪个类。模型没调工具时，重发一次并明确要求「必须调用 query_graph」。

- [ ] **Step 7: README**

(a) 表格里的图谱行，原文：

```markdown
| **图谱** | 类—实例—边：人物/地点/规则自动入图；点节点看属性、来源与关系 |
```

改为：

```markdown
| **图谱** | Cytoscape 复合图：类=分组框、实例=节点、拖拽记住位置；按类型/谓词/跳数过滤，右键查两点路径 |
```

(b) 「## 图谱：看得见的世界模型」整节（从图片到「图谱只读」那条 bullet）替换为：

```markdown
## 图谱：看得见的世界模型

![图谱](docs/screenshots/accept-ontology-v2.png)

- 画布是 Cytoscape 复合图：每个类一个分组框，实例挂在最具体的类里；`instanceOf` 用父子关系表达，不再单独画边
- 位置会记住：拖过的坐标存在浏览器本地，key 是 `inkloom:graph-layout:<bookId>:<signature>`；书内容一变旧坐标自动作废
- 布局可切：力导向 / 层级 / 同心圆 / 网格；双击类框折叠；切换布局会重置拖拽位置（工具栏有提示）
- 过滤与搜索：节点类型多选、谓词多选、左栏类树、「只看 N 跳邻居」；搜索命中会高亮并聚焦
- 路径：右键节点设起点 / 终点，右栏逐跳显示「林岚 —师徒→ 玄真」，其余节点淡出
- 人物、地点、规则、线索、卷是**虚拟节点**：来自各自文件，改要去原模块改
- 势力、物品、概念可以写进 `world/ontology/nodes.jsonl`；类与谓词在 `world/ontology/classes.json`
- 跨类型边在 `world/ontology/edges.jsonl`（append-only，带章节区间与来源）
- 坏行不会整页报错：跳过该行并在页面底部列出「第几行坏了」
- 图谱只读：Agent 用 `query_graph` / `find_path` / `explain_fact` 查；改设定走 `write_element`
- 同一套推理也是 HTTP 接口：`GET /api/ontology/path`、`POST /api/ontology/query`、`GET /api/ontology/explain`
```

(c) 验证命令的注释，原文：

```markdown
pnpm verify      # biome + tsc（含 web）+ check-deps + 382 单元 + 333 集成
```

改为（数字用 Step 1 的实际结果）：

```markdown
pnpm verify      # biome + tsc（含 web）+ check-deps + 405 单元 + 338 集成
```

- [ ] **Step 8: 收尾与提交**

```powershell
Stop-Process -Id $api.Id, $web.Id
```

```bash
git add README.md docs/screenshots/accept-ontology-v2.png
git commit -m "docs: record graph v2 slice 2 acceptance"
```

Expected: `git status` 干净；`docs/screenshots/accept-ontology-v2.png` 已入库。

---

## 验收对照（spec §5 / §9）

| spec 条目 | 落在哪个任务 | 怎么验 |
|---|---|---|
| §5.1 投影规则（类分组、最具体类、instanceOf 不画、虚拟/废止样式） | Task 5 + Task 7 | `graph-elements.test.ts` 7 例；Step 3 第 1 项 |
| §5.2 组件拆分与命令式句柄 | Task 6 + Task 7 | 五个组件文件；`GraphCanvasHandle` 六方法 |
| §5.3 布局与位置持久化 | Task 6 + Task 7 | Step 3 第 2/4 项；`useGraphLayout` key 含 signature |
| §5.4 过滤、搜索、路径 | Task 7 | Step 3 第 5–9/11 项 |
| §5.5 core 纯函数 | Task 1 | `query.test.ts` 9 例 |
| §5.6 三个 HTTP 端点 | Task 2 | `ontology.http.test.ts` + Step 5 |
| §5.7 Agent 工具 | Task 3 | `graph-tools.test.ts` 5 例 + Step 6 |
| §5.8 read_book 概况 | Task 4 | `graph-summary.test.ts` 2 例（≤800 字、失败降级） |
| §5.9 页面改造 | Task 7 | 删除 React Flow 投影；三栏宽度不变 |
| §9-6 默认 cose / 可折叠 / 可拖 / 框选 / 路径 / 刷新保留 | Task 6 + Task 7 | Step 3 第 1–4/9/12 项 |
| §9-7 图谱工具用七霞真书核对 | Task 8 | Step 6 |
| §9-10 verify 全绿 | Task 8 | Step 1 |
