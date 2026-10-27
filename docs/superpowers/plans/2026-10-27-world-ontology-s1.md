# S1 世界模型与图谱（切片 1：只读图谱）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有实体投影成一张可浏览的类—实例—边图谱，并在前端提供只读的图谱页（类树 + 画布 + 详情 + 校验问题）。

**Architecture:** 实例仍住在各自文件；`classes.json` / `nodes.jsonl` / `edges.jsonl` 是新增真相；`packages/core` 里用纯函数把这些文件与现有实体聚合成 `GraphSnapshot`，API 只负责读文件、缓存与序列化，前端用 React Flow 渲染。切片 1 不做事件、提案、推导，也不新增 Prisma 表。

**Tech Stack:** TypeScript 7、Zod 4、Hono、React 19、React Flow（`@xyflow/react`）、TanStack Query、Vitest、Biome。

**Spec:** `docs/superpowers/specs/2026-10-27-world-ontology-and-events-design.md`（下称 spec）

## Global Constraints

- 文件是唯一事实源；索引可丢弃。切片 1 不新增 Prisma 表（spec D1）。
- 既有 12 个实体文件的 schema 一个字段都不改（spec D2）；人物/地点/规则/线索/卷是虚拟节点，人物关系/路线是虚拟边，只读。
- `packages/core` 零 IO：不 import `node:fs`、`node:path`、数据库、网络；只接受普通对象。
- 所有新文件写入必须走 `writeQueue` + 原子写；切片 1 只读，不写 canon。
- 类 id 形如 `cls-*`，边 id 形如 `ed-` + 6 位小写 hex，附加节点 id 形如 `grp-* / itm-* / cpt-*`，事件 id `evt-*`（切片 2 才用）。
- 类上限 20、谓词上限 20、单继承（spec §4.1）。
- 界面全中文；不引入新依赖（React Flow 已存在）。
- 每个任务结束前跑：`pnpm exec biome check .`、`pnpm tsc`、相关测试。
- 提交信息用中文或英文均可，但必须以 `feat(ontology):` / `test(ontology):` / `docs(ontology):` 开头。

## 文件结构（切片 1）

```
packages/shared/src/ontology.ts           新增：类/谓词/节点/边/issue 的 Zod 与类型
packages/shared/src/ontology.test.ts      新增
packages/shared/src/index.ts              修改：export * from './ontology.js'

packages/core/src/ontology/defaults.ts    新增：默认类与谓词（类文件缺失时使用）
packages/core/src/ontology/types.ts       新增：GraphNode/GraphEdgeView/GraphSnapshot...
packages/core/src/ontology/graph.ts       新增：buildGraph
packages/core/src/ontology/validate.ts    新增：validateGraph（切片 1 的 5 类问题）
packages/core/src/ontology/graph.test.ts  新增
packages/core/src/ontology/validate.test.ts 新增
packages/core/src/index.ts                修改：导出 ontology

apps/api/src/storage/ontology.ts          新增：读 classes.json / nodes.jsonl / edges.jsonl（容错 + mtime）
apps/api/src/storage/ontology.int.test.ts 新增
apps/api/src/services/ontology-service.ts 新增：读实体 + buildGraph + validate + 缓存
apps/api/src/routes/ontology.ts           新增：/api/ontology/*
apps/api/src/routes/ontology.http.test.ts 新增
apps/api/src/app.ts                       修改：挂载路由

apps/web/src/api/types.ts                 修改：Ontology* 类型
apps/web/src/api/hooks.ts                 修改：useOntologyGraph / useOntologyNode / useOntologyClasses
apps/web/src/pages/OntologyPage.tsx       新增：图谱页（三栏）
apps/web/src/shell/AppShell.tsx           修改：模块表 + 渲染
apps/web/src/stores/session.ts            修改：ModuleId 增加 'ontology'

README.md                                 修改：模块表与「图谱」一节
docs/screenshots/accept-ontology.png      新增：真实书截图
```

---

### Task 1: 共享 schema —— 类、谓词、附加节点、边

**Files:**
- Create: `packages/shared/src/ontology.ts`
- Create: `packages/shared/src/ontology.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 无（只依赖 `zod`）
- Produces: `ClassesFile`、`ClassDef`、`ClassRule`、`PredicateDef`、`OntologyNode`、`GraphEdge`、`NodeType`、`classesFileSchema`、`ontologyNodeSchema`、`graphEdgeSchema`、`nodeTypeSchema`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  classesFileSchema,
  graphEdgeSchema,
  nodeTypeSchema,
  ontologyNodeSchema,
} from './ontology.js'

describe('ontology schema', () => {
  it('附加节点补默认值', () => {
    const n = ontologyNodeSchema.parse({
      id: 'grp-qingyun',
      type: 'group',
      name: '青云宗',
      createdAt: '2026-10-27T00:00:00.000Z',
    })
    expect(n.aliases).toEqual([])
    expect(n.attrs).toEqual({})
    expect(n.summary).toBe('')
  })

  it('节点 id 必须带类型前缀', () => {
    expect(() =>
      ontologyNodeSchema.parse({
        id: '青云宗',
        type: 'group',
        name: '青云宗',
        createdAt: '2026-10-27T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('边 id 必须是 ed- + 6 位小写 hex', () => {
    const base = {
      from: 'c1',
      predicate: 'belongsTo',
      to: 'grp-qingyun',
      source: { kind: 'author' },
      createdAt: '2026-10-27T00:00:00.000Z',
    }
    expect(graphEdgeSchema.parse({ ...base, id: 'ed-7f3c91' }).id).toBe('ed-7f3c91')
    expect(() => graphEdgeSchema.parse({ ...base, id: 'ed-XYZ' })).toThrow()
  })

  it('类文件：默认 version=1，类规则默认 hard', () => {
    const f = classesFileSchema.parse({
      version: 1,
      classes: [
        {
          id: 'cls-sect',
          name: '宗门',
          kind: 'group',
          rules: [{ id: 'r1', kind: 'requiresEdge', predicate: 'belongsTo', message: '必须有归属' }],
        },
      ],
      predicates: [{ id: 'belongsTo', label: '隶属于' }],
    })
    expect(f.classes[0]?.parentId).toBeNull()
    expect(f.classes[0]?.properties).toEqual([])
    expect(f.classes[0]?.rules[0]?.severity).toBe('hard')
    expect(f.predicates[0]?.domain).toBe('any')
    expect(f.predicates[0]?.transitive).toBe(false)
  })

  it('nodeType 只允许 7 种', () => {
    expect(nodeTypeSchema.options).toHaveLength(7)
    expect(() => nodeTypeSchema.parse('event')).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run --project unit packages/shared/src/ontology.test.ts`
Expected: FAIL，`Cannot find module './ontology.js'`

- [ ] **Step 3: 写实现**

```ts
import { z } from 'zod'

/** 图上的节点类型；事件不进图节点（spec §4.1） */
export const NODE_TYPES = [
  'character',
  'group',
  'place',
  'rule',
  'item',
  'concept',
  'class',
] as const
export const nodeTypeSchema = z.enum(NODE_TYPES)
export type NodeType = z.infer<typeof nodeTypeSchema>

export const CLASS_KINDS = ['character', 'group', 'place', 'rule', 'item', 'concept'] as const
export const classKindSchema = z.enum(CLASS_KINDS)
export type ClassKind = z.infer<typeof classKindSchema>

export const CLASS_RULE_KINDS = [
  'range',
  'requires',
  'requiresEdge',
  'forbidsEdge',
  'disjointWith',
] as const

export const classRuleSchema = z.object({
  id: z.string().min(1).max(64),
  severity: z.enum(['hard', 'soft']).default('hard'),
  kind: z.enum(CLASS_RULE_KINDS),
  property: z.string().min(1).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  predicate: z.string().min(1).optional(),
  classId: z.string().min(1).optional(),
  message: z.string().min(1).max(200),
})
export type ClassRule = z.infer<typeof classRuleSchema>

export const classDefSchema = z.object({
  id: z.string().regex(/^cls-[a-z0-9-]+$/, '类 id 形如 cls-sect'),
  name: z.string().min(1).max(40),
  parentId: z.string().regex(/^cls-[a-z0-9-]+$/).nullable().default(null),
  kind: classKindSchema,
  properties: z
    .array(
      z.object({
        key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
        range: z.enum(['string', 'number', 'string[]', 'ref']).default('string'),
        cardinality: z.enum(['one', 'many']).default('one'),
      }),
    )
    .default([]),
  rules: z.array(classRuleSchema).default([]),
})
export type ClassDef = z.infer<typeof classDefSchema>

export const predicateDefSchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, '谓词 id 用小驼峰/下划线'),
  label: z.string().min(1).max(20),
  domain: z.union([z.literal('any'), z.array(z.string())]).default('any'),
  range: z.union([z.literal('any'), z.literal('class'), z.array(z.string())]).default('any'),
  directed: z.boolean().default(true),
  transitive: z.boolean().default(false),
  inverseOf: z.string().optional(),
})
export type PredicateDef = z.infer<typeof predicateDefSchema>

export const classesFileSchema = z.object({
  version: z.literal(1),
  classes: z.array(classDefSchema).default([]),
  predicates: z.array(predicateDefSchema).default([]),
})
export type ClassesFile = z.infer<typeof classesFileSchema>

export const ontologyNodeSchema = z.object({
  id: z.string().regex(/^[a-z]{2,4}-[a-z0-9][a-z0-9-]*$/, '节点 id 形如 grp-qingyun'),
  type: z.enum(['group', 'item', 'concept']),
  name: z.string().min(1).max(80),
  aliases: z.array(z.string().min(1).max(80)).default([]),
  summary: z.string().max(500).default(''),
  attrs: z.record(z.string(), z.string()).default({}),
  createdAt: z.string().datetime(),
})
export type OntologyNode = z.infer<typeof ontologyNodeSchema>

export const graphEdgeSchema = z.object({
  id: z.string().regex(/^ed-[a-f0-9]{6}$/, '边 id 形如 ed-7f3c91'),
  from: z.string().min(1),
  predicate: z.string().min(1),
  to: z.string().min(1),
  sinceChapter: z.number().int().positive().optional(),
  untilChapter: z.number().int().positive().optional(),
  source: z.object({
    kind: z.enum(['chapter', 'author', 'agent']),
    ref: z.string().optional(),
  }),
  confidence: z.number().int().min(1).max(5).optional(),
  retracts: z.string().optional(),
  createdAt: z.string().datetime(),
})
export type GraphEdge = z.infer<typeof graphEdgeSchema>
```

在 `packages/shared/src/index.ts` 末尾加一行：

```ts
export * from './ontology.js'
```

- [ ] **Step 4: 跑测试与类型检查**

Run: `pnpm vitest run --project unit packages/shared/src/ontology.test.ts && pnpm tsc`
Expected: 5 passed；tsc 无输出

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/ontology.ts packages/shared/src/ontology.test.ts packages/shared/src/index.ts
git commit -m "feat(ontology): shared schemas for classes, nodes and edges"
```

---

### Task 2: core 图构建 —— 虚拟节点/边、默认类、类闭包

**Files:**
- Create: `packages/core/src/ontology/types.ts`
- Create: `packages/core/src/ontology/defaults.ts`
- Create: `packages/core/src/ontology/graph.ts`
- Create: `packages/core/src/ontology/graph.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `ClassDef` / `PredicateDef` / `ClassesFile` / `GraphEdge` / `OntologyNode` / `NodeType`；既有 `Character` / `CharacterRelation` / `Location` / `Route` / `WorldRule` / `PlotThread` / `StoryArc`
- Produces:
  - `GraphNode { id; type; name; aliases?; attrs; virtual; sourceFile? }`
  - `GraphEdgeView extends GraphEdge { virtual: boolean; undirected?: boolean; retracted?: boolean; sourceFile?: string }`
  - `GraphIssue { severity: 'error' | 'warning'; code: string; subject: string; message: string }`
  - `GraphSnapshot { nodes: Map<string, GraphNode>; edges: GraphEdgeView[]; classOf: Map<string, string[]>; subclasses: Map<string, string[]>; classes: ClassDef[]; predicates: PredicateDef[]; issues: GraphIssue[]; builtFrom: { files: string[]; mtimeMax: number } }`
  - `GraphSource { characters; relations; locations; routes; rules; threads; arcs; nodes; edges; classesFile; builtFrom }`
  - `buildGraph(src: GraphSource): GraphSnapshot`
  - `DEFAULT_CLASSES_FILE: ClassesFile`

- [ ] **Step 1: 写失败测试**

```ts
import type {
  CharacterRelation,
  ClassesFile,
  GraphEdge,
  Location,
  OntologyNode,
  Route,
} from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'

const char = (id: string, name: string) => ({
  id,
  projectId: 'p1',
  name,
  role: 'supporting',
  stateStale: false,
}) as const

function source(over: Partial<GraphSource> = {}): GraphSource {
  return {
    characters: [char('c1', '林岚'), char('c2', '裴无咎')],
    relations: [
      {
        id: 'r1',
        projectId: 'p1',
        fromId: 'c1',
        toId: 'c2',
        kind: 'enemy',
        strength: 4,
        sinceChapter: 3,
      } as CharacterRelation,
    ],
    locations: [
      { id: 'l1', projectId: 'p1', name: '寒山关', type: 'mountain' } as Location,
    ],
    routes: [
      {
        id: 'rt1',
        projectId: 'p1',
        fromId: 'l1',
        toId: 'l2',
        mode: 'walk',
        days: 3,
        bidirectional: true,
      } as Route,
    ],
    rules: [],
    threads: [],
    arcs: [],
    nodes: [],
    edges: [],
    classesFile: null,
    builtFrom: { files: [], mtimeMax: 0 },
    ...over,
  }
}

describe('buildGraph', () => {
  it('★ 现有实体变成虚拟节点，关系/路线变成虚拟边', () => {
    const g = buildGraph(source())
    expect(g.nodes.get('c1')).toMatchObject({ type: 'character', name: '林岚', virtual: true })
    expect(g.nodes.get('l1')).toMatchObject({ type: 'place', virtual: true })
    const rel = g.edges.find((e) => e.id === 'rel-r1')
    expect(rel).toMatchObject({ from: 'c1', predicate: 'rel:enemy', to: 'c2', virtual: true })
    const route = g.edges.find((e) => e.id === 'rt-rt1')
    expect(route).toMatchObject({ predicate: 'route', undirected: true, virtual: true })
    expect(g.classOf.get('c1')).toContain('cls-character')
  })

  it('★ 附加节点进图，instanceOf + 父类形成类闭包', () => {
    const classes: ClassesFile = {
      version: 1,
      classes: [
        { id: 'cls-character', name: '人物', parentId: null, kind: 'character', properties: [], rules: [] },
        { id: 'cls-group', name: '组织', parentId: null, kind: 'group', properties: [], rules: [] },
        { id: 'cls-sect', name: '宗门', parentId: 'cls-group', kind: 'group', properties: [], rules: [] },
      ],
      predicates: [{ id: 'instanceOf', label: '属于类', domain: 'any', range: 'class', directed: true, transitive: false }],
    }
    const node: OntologyNode = {
      id: 'grp-qingyun',
      type: 'group',
      name: '青云宗',
      aliases: [],
      summary: '',
      attrs: {},
      createdAt: '2026-10-27T00:00:00.000Z',
    }
    const edge: GraphEdge = {
      id: 'ed-123abc',
      from: 'grp-qingyun',
      predicate: 'instanceOf',
      to: 'cls-sect',
      source: { kind: 'author' },
      createdAt: '2026-10-27T00:00:00.000Z',
    }
    const g = buildGraph(source({ nodes: [node], edges: [edge], classesFile: classes }))
    expect(g.nodes.get('grp-qingyun')?.virtual).toBe(false)
    expect(g.classOf.get('grp-qingyun')).toEqual(['cls-group', 'cls-sect'])
  })

  it('被 retracts 指向的边标 retracted', () => {
    const edges: GraphEdge[] = [
      {
        id: 'ed-aaaaaa',
        from: 'c1',
        predicate: 'instanceOf',
        to: 'cls-character',
        source: { kind: 'author' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
      {
        id: 'ed-bbbbbb',
        from: 'c1',
        predicate: 'instanceOf',
        to: 'cls-character',
        retracts: 'ed-aaaaaa',
        source: { kind: 'author' },
        createdAt: '2026-10-27T00:00:00.000Z',
      },
    ]
    const g = buildGraph(source({ edges }))
    expect(g.edges.find((e) => e.id === 'ed-aaaaaa')?.retracted).toBe(true)
    expect(g.edges.find((e) => e.id === 'ed-bbbbbb')?.retracted).toBe(false)
  })

  it('重复节点记 warning，不中断构建', () => {
    const node: OntologyNode = {
      id: 'c1',
      type: 'group',
      name: '撞车',
      aliases: [],
      summary: '',
      attrs: {},
      createdAt: '2026-10-27T00:00:00.000Z',
    }
    const g = buildGraph(source({ nodes: [node] }))
    expect(g.issues).toContainEqual(
      expect.objectContaining({ code: 'DUP_NODE', subject: 'c1', severity: 'warning' }),
    )
    expect(g.nodes.get('c1')?.name).toBe('林岚')
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run --project unit packages/core/src/ontology/graph.test.ts`
Expected: FAIL，`Cannot find module './graph.js'`

- [ ] **Step 3: 写类型与默认类**

`packages/core/src/ontology/types.ts`：

```ts
import type {
  Character,
  CharacterRelation,
  ClassesFile,
  ClassDef,
  GraphEdge,
  Location,
  NodeType,
  OntologyNode,
  PlotThread,
  PredicateDef,
  Route,
  StoryArc,
  WorldRule,
} from '@inkloom/shared'

export interface GraphNode {
  id: string
  type: NodeType
  name: string
  aliases?: string[]
  attrs: Record<string, string>
  virtual: boolean
  sourceFile?: string
}

export interface GraphEdgeView extends GraphEdge {
  virtual: boolean
  /** 虚拟路线：双向时匹配忽略方向 */
  undirected?: boolean
  retracted?: boolean
  sourceFile?: string
}

export interface GraphIssue {
  severity: 'error' | 'warning'
  code: string
  subject: string
  message: string
}

export interface GraphSource {
  characters: Character[]
  relations: CharacterRelation[]
  locations: Location[]
  routes: Route[]
  rules: WorldRule[]
  threads: PlotThread[]
  arcs: StoryArc[]
  nodes: OntologyNode[]
  edges: GraphEdge[]
  classesFile: ClassesFile | null
  builtFrom: { files: string[]; mtimeMax: number }
}

export interface GraphSnapshot {
  nodes: Map<string, GraphNode>
  edges: GraphEdgeView[]
  classOf: Map<string, string[]>
  subclasses: Map<string, string[]>
  classes: ClassDef[]
  predicates: PredicateDef[]
  issues: GraphIssue[]
  builtFrom: { files: string[]; mtimeMax: number }
}
```

`packages/core/src/ontology/defaults.ts`：

```ts
import type { ClassesFile } from '@inkloom/shared'

/**
 * 类文件缺失时的默认本体（spec §4.1）。
 * ★ 只读默认值，不落盘；作者一旦创建 classes.json 就以文件为准。
 */
export const DEFAULT_CLASSES_FILE: ClassesFile = {
  version: 1,
  classes: [
    { id: 'cls-character', name: '人物', parentId: null, kind: 'character', properties: [], rules: [] },
    { id: 'cls-group', name: '组织', parentId: null, kind: 'group', properties: [], rules: [] },
    { id: 'cls-sect', name: '宗门', parentId: 'cls-group', kind: 'group', properties: [], rules: [] },
    { id: 'cls-place', name: '地点', parentId: null, kind: 'place', properties: [], rules: [] },
    { id: 'cls-rule', name: '规则', parentId: null, kind: 'rule', properties: [], rules: [] },
    { id: 'cls-item', name: '物品', parentId: null, kind: 'item', properties: [], rules: [] },
    { id: 'cls-concept', name: '概念', parentId: null, kind: 'concept', properties: [], rules: [] },
  ],
  predicates: [
    { id: 'instanceOf', label: '属于类', domain: 'any', range: 'class', directed: true, transitive: false },
    { id: 'belongsTo', label: '隶属于', domain: ['cls-character', 'cls-group'], range: ['cls-group'], directed: true, transitive: true },
    { id: 'controls', label: '控制', domain: ['cls-group'], range: ['cls-place'], directed: true, transitive: false },
    { id: 'violates', label: '违反', domain: ['cls-character'], range: ['cls-rule'], directed: true, transitive: false },
    { id: 'mentorOf', label: '师父', domain: ['cls-character'], range: ['cls-character'], directed: true, transitive: false, inverseOf: 'apprenticeOf' },
    { id: 'apprenticeOf', label: '徒弟', domain: ['cls-character'], range: ['cls-character'], directed: true, transitive: false, inverseOf: 'mentorOf' },
  ],
}
```

- [ ] **Step 4: 写 buildGraph**

`packages/core/src/ontology/graph.ts`：

```ts
import type {
  Character,
  ClassDef,
  GraphEdge,
  Location,
  NodeType,
  OntologyNode,
  PlotThread,
  Route,
  StoryArc,
  WorldRule,
} from '@inkloom/shared'
import { DEFAULT_CLASSES_FILE } from './defaults.js'
import type {
  GraphEdgeView,
  GraphIssue,
  GraphNode,
  GraphSnapshot,
  GraphSource,
} from './types.js'

const DEFAULT_CLASS_BY_TYPE: Partial<Record<NodeType, string>> = {
  character: 'cls-character',
  group: 'cls-group',
  place: 'cls-place',
  rule: 'cls-rule',
  item: 'cls-item',
  concept: 'cls-concept',
}

function compact(input: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v.length > 0) out[k] = v
  }
  return out
}

/** 从类本身往上走，返回祖先 id（防环） */
function classAncestors(id: string, byId: Map<string, ClassDef>): string[] {
  const out: string[] = []
  const seen = new Set<string>([id])
  let cur = byId.get(id)?.parentId ?? null
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    const def = byId.get(cur)
    if (def === undefined) break
    out.push(cur)
    cur = def.parentId
  }
  return out
}

function characterNode(c: Character): GraphNode {
  return {
    id: c.id,
    type: 'character',
    name: c.name,
    attrs: compact({
      role: c.role,
      personality: c.personality,
      motivation: c.motivation,
      curLocation: c.curLocation,
      curMental: c.curMental,
      stateChapter: c.stateChapter === undefined ? undefined : String(c.stateChapter),
    }),
    virtual: true,
    sourceFile: 'characters/index.json',
  }
}

function locationNode(l: Location): GraphNode {
  return {
    id: l.id,
    type: 'place',
    name: l.name,
    attrs: compact({ kind: l.type, region: l.region }),
    virtual: true,
    sourceFile: 'world/locations.json',
  }
}

function ruleNode(r: WorldRule): GraphNode {
  return {
    id: r.id,
    type: 'rule',
    name: r.name,
    attrs: compact({ category: r.category, priority: r.priority }),
    virtual: true,
    sourceFile: 'world/rules.json',
  }
}

function threadNode(t: PlotThread): GraphNode {
  return {
    id: t.id,
    type: 'concept',
    name: t.title,
    attrs: compact({ kind: 'thread', status: t.status }),
    virtual: true,
    sourceFile: 'story/threads.json',
  }
}

function arcNode(a: StoryArc): GraphNode {
  return {
    id: a.id,
    type: 'concept',
    name: a.name,
    attrs: compact({
      kind: 'arc',
      startChapter: String(a.startChapter),
      endChapter: String(a.endChapter),
      purpose: a.purpose,
    }),
    virtual: true,
    sourceFile: 'story/arcs.json',
  }
}

function routeEdge(r: Route): GraphEdgeView {
  return {
    id: `rt-${r.id}`,
    from: r.fromId,
    predicate: 'route',
    to: r.toId,
    source: { kind: 'author', ref: 'world/routes.json' },
    virtual: true,
    undirected: r.bidirectional,
    sourceFile: 'world/routes.json',
  }
}

export function buildGraph(src: GraphSource): GraphSnapshot {
  const classesFile = src.classesFile ?? DEFAULT_CLASSES_FILE
  const classById = new Map(classesFile.classes.map((c) => [c.id, c]))
  const nodes = new Map<string, GraphNode>()
  const duplicateNodeIds: string[] = []

  const add = (node: GraphNode): void => {
    if (nodes.has(node.id)) {
      duplicateNodeIds.push(node.id)
      return
    }
    nodes.set(node.id, node)
  }

  for (const c of src.characters) add(characterNode(c))
  for (const l of src.locations) add(locationNode(l))
  for (const r of src.rules) add(ruleNode(r))
  for (const t of src.threads) add(threadNode(t))
  for (const a of src.arcs) add(arcNode(a))
  for (const n of src.nodes) {
    add({
      id: n.id,
      type: n.type,
      name: n.name,
      aliases: n.aliases,
      attrs: n.attrs,
      virtual: false,
      sourceFile: 'world/ontology/nodes.jsonl',
    })
  }

  const edges: GraphEdgeView[] = []
  for (const r of src.relations) {
    edges.push({
      id: `rel-${r.id}`,
      from: r.fromId,
      predicate: `rel:${r.kind}`,
      to: r.toId,
      ...(r.sinceChapter === undefined ? {} : { sinceChapter: r.sinceChapter }),
      ...(r.untilChapter === undefined ? {} : { untilChapter: r.untilChapter }),
      source: { kind: 'author', ref: 'characters/relations.json' },
      virtual: true,
      sourceFile: 'characters/relations.json',
    })
  }
  for (const r of src.routes) edges.push(routeEdge(r))

  const retracted = new Set(
    src.edges.map((e) => e.retracts).filter((v): v is string => v !== undefined),
  )
  for (const e of src.edges) {
    edges.push({
      ...e,
      virtual: false,
      retracted: retracted.has(e.id),
      sourceFile: 'world/ontology/edges.jsonl',
    })
  }
  edges.sort((a, b) => a.id.localeCompare(b.id))

  const classOf = new Map<string, string[]>()
  for (const node of nodes.values()) {
    const direct = new Set<string>()
    const base = DEFAULT_CLASS_BY_TYPE[node.type]
    if (base !== undefined) direct.add(base)
    for (const e of edges) {
      if (e.retracted === true || e.predicate !== 'instanceOf' || e.from !== node.id) continue
      if (classById.has(e.to)) direct.add(e.to)
    }
    const all = new Set<string>()
    for (const id of direct) {
      all.add(id)
      for (const a of classAncestors(id, classById)) all.add(a)
    }
    classOf.set(node.id, [...all])
  }

  const subclasses = new Map<string, string[]>()
  for (const c of classesFile.classes) {
    for (const a of classAncestors(c.id, classById)) {
      const list = subclasses.get(a) ?? []
      list.push(c.id)
      subclasses.set(a, list)
    }
  }

  const issues: GraphIssue[] = duplicateNodeIds.map((id) => ({
    severity: 'warning',
    code: 'DUP_NODE',
    subject: id,
    message: `节点 ${id} 重复定义，已保留第一次出现的节点`,
  }))

  return {
    nodes,
    edges,
    classOf,
    subclasses,
    classes: classesFile.classes,
    predicates: classesFile.predicates,
    issues,
    builtFrom: src.builtFrom,
  }
}
```

在 `packages/core/src/index.ts` 末尾加：

```ts
export * from './ontology/defaults.js'
export * from './ontology/graph.js'
export * from './ontology/types.js'
```

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run --project unit packages/core/src/ontology/graph.test.ts`
Expected: 4 passed

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/ontology packages/core/src/index.ts
git commit -m "feat(ontology): build graph from existing entities and ontology files"
```

---

### Task 3: core 校验 —— 悬空边、坏谓词、重复边、类环

**Files:**
- Create: `packages/core/src/ontology/validate.ts`
- Create: `packages/core/src/ontology/validate.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 2 的 `GraphSnapshot` / `GraphSource` / `buildGraph`；Task 1 的 `GraphEdge`
- Produces: `validateGraph(snap: GraphSnapshot): GraphIssue[]`，问题码：`CLASS_PARENT_MISSING`、`CLASS_CYCLE`、`EDGE_ENDPOINT_MISSING`、`EDGE_BAD_PREDICATE`、`DUP_EDGE`

- [ ] **Step 1: 写失败测试**

```ts
import type { GraphEdge } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, type GraphSource } from './graph.js'
import { validateGraph } from './validate.js'

const edge = (over: Partial<GraphEdge>): GraphEdge => ({
  id: 'ed-aaaaaa',
  from: 'c1',
  predicate: 'instanceOf',
  to: 'cls-character',
  source: { kind: 'author' },
  createdAt: '2026-10-27T00:00:00.000Z',
  ...over,
})

function snap(edges: GraphEdge[], classesFile: GraphSource['classesFile'] = null) {
  const src: GraphSource = {
    characters: [
      { id: 'c1', projectId: 'p1', name: '林岚', role: 'protagonist', stateStale: false } as never,
    ],
    relations: [],
    locations: [],
    routes: [],
    rules: [],
    threads: [],
    arcs: [],
    nodes: [],
    edges,
    classesFile,
    builtFrom: { files: [], mtimeMax: 0 },
  }
  return buildGraph(src)
}

describe('validateGraph', () => {
  it('★ 悬空边报 EDGE_ENDPOINT_MISSING；虚拟边不检查', () => {
    const s = snap([edge({ to: 'nobody' })])
    expect(validateGraph(s)).toContainEqual(
      expect.objectContaining({ code: 'EDGE_ENDPOINT_MISSING', subject: 'ed-aaaaaa' }),
    )
  })

  it('未知谓词报 EDGE_BAD_PREDICATE', () => {
    const s = snap([edge({ predicate: 'nope' })])
    expect(validateGraph(s)).toContainEqual(
      expect.objectContaining({ code: 'EDGE_BAD_PREDICATE', subject: 'ed-aaaaaa' }),
    )
  })

  it('同一 from/predicate/to/sinceChapter 重复报 DUP_EDGE', () => {
    const s = snap([
      edge({ id: 'ed-aaaaaa' }),
      edge({ id: 'ed-bbbbbb' }),
    ])
    expect(validateGraph(s).filter((i) => i.code === 'DUP_EDGE')).toHaveLength(1)
  })

  it('父类缺失与类环', () => {
    const s = snap([], {
      version: 1,
      classes: [
        { id: 'cls-a', name: 'A', parentId: 'cls-missing', kind: 'concept', properties: [], rules: [] },
        { id: 'cls-b', name: 'B', parentId: 'cls-c', kind: 'concept', properties: [], rules: [] },
        { id: 'cls-c', name: 'C', parentId: 'cls-b', kind: 'concept', properties: [], rules: [] },
      ],
      predicates: [],
    })
    const codes = validateGraph(s).map((i) => i.code)
    expect(codes).toContain('CLASS_PARENT_MISSING')
    expect(codes).toContain('CLASS_CYCLE')
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run --project unit packages/core/src/ontology/validate.test.ts`
Expected: FAIL，`Cannot find module './validate.js'`

- [ ] **Step 3: 写实现**

```ts
import type { GraphIssue, GraphSnapshot } from './types.js'

/**
 * 结构校验（切片 1）。
 * ★ 只检查 canon 边：虚拟边由各自 schema（relations/routes）保证，重复报错只会是噪音。
 * ★ 切片 3 再补 domain/range、规则校验。
 */
export function validateGraph(snap: GraphSnapshot): GraphIssue[] {
  const issues: GraphIssue[] = []
  const classById = new Map(snap.classes.map((c) => [c.id, c]))

  for (const c of snap.classes) {
    if (c.parentId !== null && !classById.has(c.parentId)) {
      issues.push({
        severity: 'error',
        code: 'CLASS_PARENT_MISSING',
        subject: c.id,
        message: `类 ${c.id} 的父类 ${c.parentId} 不存在`,
      })
    }
  }

  const mark = new Map<string, 'visiting' | 'done'>()
  const reported = new Set<string>()
  const visit = (id: string): void => {
    const st = mark.get(id)
    if (st === 'done') return
    if (st === 'visiting') {
      if (!reported.has(id)) {
        reported.add(id)
        issues.push({
          severity: 'error',
          code: 'CLASS_CYCLE',
          subject: id,
          message: `类继承出现环，经过 ${id}`,
        })
      }
      return
    }
    mark.set(id, 'visiting')
    const parent = classById.get(id)?.parentId ?? null
    if (parent !== null && classById.has(parent)) visit(parent)
    mark.set(id, 'done')
  }
  for (const c of snap.classes) visit(c.id)

  const predicateIds = new Set(snap.predicates.map((p) => p.id))
  const seen = new Set<string>()
  for (const e of snap.edges) {
    if (e.virtual) continue
    if (!snap.nodes.has(e.from) || !snap.nodes.has(e.to)) {
      issues.push({
        severity: 'error',
        code: 'EDGE_ENDPOINT_MISSING',
        subject: e.id,
        message: `边 ${e.id} 指向不存在的节点：${snap.nodes.has(e.from) ? e.to : e.from}`,
      })
    }
    if (!predicateIds.has(e.predicate)) {
      issues.push({
        severity: 'error',
        code: 'EDGE_BAD_PREDICATE',
        subject: e.id,
        message: `边 ${e.id} 使用了未注册的谓词 ${e.predicate}`,
      })
    }
    const key = `${e.from}|${e.predicate}|${e.to}|${e.sinceChapter ?? ''}`
    if (seen.has(key)) {
      issues.push({
        severity: 'warning',
        code: 'DUP_EDGE',
        subject: e.id,
        message: `重复边：${e.from} -${e.predicate}-> ${e.to}（同样的 sinceChapter）`,
      })
    } else {
      seen.add(key)
    }
  }

  return issues
}
```

在 `packages/core/src/index.ts` 加：

```ts
export * from './ontology/validate.js'
```

- [ ] **Step 4: 跑测试与全量单元测试**

Run: `pnpm vitest run --project unit packages/core/src/ontology packages/shared/src/ontology.test.ts`
Expected: 9 passed（graph 4 + validate 4 + shared 5 中的本批；总数以实际为准，不能有 fail）

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/ontology packages/core/src/index.ts
git commit -m "feat(ontology): validate class hierarchy and canon edges"
```

---

### Task 4: 读图谱文件 —— 容错 JSONL + mtime

**Files:**
- Create: `apps/api/src/storage/ontology.ts`
- Create: `apps/api/src/storage/ontology.int.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `classesFileSchema` / `ontologyNodeSchema` / `graphEdgeSchema`；既有 `readIfExists` / `bookPaths`
- Produces:
  - `ontologyDir(root: string): string`
  - `readOntologyFiles(root: string, watchFiles?: string[]): Promise<OntologyFiles>`
  - `OntologyFiles { classesFile: ClassesFile | null; nodes: OntologyNode[]; edges: GraphEdge[]; warnings: string[]; files: string[]; mtimeMax: number }`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readOntologyFiles } from './ontology.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-ontology-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

describe('readOntologyFiles', () => {
  it('没有文件时返回空图数据', async () => {
    const f = await readOntologyFiles(root)
    expect(f.classesFile).toBeNull()
    expect(f.nodes).toEqual([])
    expect(f.edges).toEqual([])
    expect(f.warnings).toEqual([])
    expect(f.mtimeMax).toBe(0)
  })

  it('★ 坏行跳过并记 warning，好行照常返回', async () => {
    await write(
      'world/ontology/nodes.jsonl',
      [
        '{"id":"grp-qingyun","type":"group","name":"青云宗","createdAt":"2026-10-27T00:00:00.000Z"}',
        '不是 JSON',
        '{"id":"itm-sword","type":"item","name":"断水","createdAt":"2026-10-27T00:00:00.000Z"}',
      ].join('\n'),
    )
    const f = await readOntologyFiles(root)
    expect(f.nodes.map((n) => n.id)).toEqual(['grp-qingyun', 'itm-sword'])
    expect(f.warnings).toHaveLength(1)
    expect(f.warnings[0]).toContain('nodes.jsonl 第 2 行')
  })

  it('classes.json 坏掉时忽略并记 warning', async () => {
    await write('world/ontology/classes.json', '{oops')
    const f = await readOntologyFiles(root)
    expect(f.classesFile).toBeNull()
    expect(f.warnings[0]).toContain('classes.json')
  })

  it('watchFiles 的 mtime 参与 mtimeMax（实体文件变了缓存要失效）', async () => {
    await write('characters/index.json', '[]')
    const file = join(root, 'characters/index.json')
    const f = await readOntologyFiles(root, [file])
    expect(f.mtimeMax).toBeGreaterThan(0)
    expect(f.files).toContain('characters/index.json')
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run --project integration apps/api/src/storage/ontology.int.test.ts`
Expected: FAIL，`Cannot find module './ontology.js'`

- [ ] **Step 3: 写实现**

```ts
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

  const nodes = await readJsonl(nodesPath, 'world/ontology/nodes.jsonl', ontologyNodeSchema, warnings)
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
```

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run --project integration apps/api/src/storage/ontology.int.test.ts`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/storage/ontology.ts apps/api/src/storage/ontology.int.test.ts
git commit -m "feat(ontology): read classes and jsonl graph files with tolerance"
```

---

### Task 5: 图谱服务与 HTTP 路由

**Files:**
- Create: `apps/api/src/services/ontology-service.ts`
- Create: `apps/api/src/routes/ontology.ts`
- Create: `apps/api/src/routes/ontology.http.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: Task 2 `buildGraph`；Task 3 `validateGraph`；Task 4 `readOntologyFiles`；既有 `getContext` / `readJsonElement` / `bookPaths` / `createApp`
- Produces:
  - `getGraphSnapshot(): Promise<GraphSnapshot>`（按 root + mtimeMax 缓存）
  - `clearGraphCache(): void`
  - `GET /api/ontology/graph`、`GET /api/ontology/nodes/:id`、`GET /api/ontology/classes`、`GET /api/ontology/search`、`POST /api/ontology/reload`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { IndexDb } from '../index-db/client.js'
import { clearContext, setContext } from '../services/context.js'
import { clearGraphCache } from '../services/ontology-service.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'

let base = ''
let root = ''
let db: IndexDb
let pid = ''

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-ontology-http-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  clearGraphCache()

  await writeJsonElement(root, 'characters/index.json', [
    { id: 'c1', projectId: pid, name: '林岚', role: 'protagonist', curMental: '戒备' },
  ])
  await writeJsonElement(root, 'characters/relations.json', [
    { id: 'r1', projectId: pid, fromId: 'c1', toId: 'c2', kind: 'enemy', strength: 4 },
  ])
  await writeJsonElement(root, 'world/locations.json', [
    { id: 'l1', projectId: pid, name: '寒山关', type: 'mountain' },
  ])

  const dir = join(root, 'world/ontology')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'classes.json'),
    JSON.stringify({
      version: 1,
      classes: [
        { id: 'cls-character', name: '人物', parentId: null, kind: 'character' },
        { id: 'cls-group', name: '组织', parentId: null, kind: 'group' },
        { id: 'cls-sect', name: '宗门', parentId: 'cls-group', kind: 'group' },
        { id: 'cls-place', name: '地点', parentId: null, kind: 'place' },
      ],
      predicates: [
        { id: 'instanceOf', label: '属于类' },
        { id: 'belongsTo', label: '隶属于' },
      ],
    }),
    'utf8',
  )
  await writeFile(
    join(dir, 'nodes.jsonl'),
    '{"id":"grp-qingyun","type":"group","name":"青云宗","createdAt":"2026-10-27T00:00:00.000Z"}\n',
    'utf8',
  )
  await writeFile(
    join(dir, 'edges.jsonl'),
    [
      '{"id":"ed-aaaaaa","from":"grp-qingyun","predicate":"instanceOf","to":"cls-sect","source":{"kind":"author"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"ed-bbbbbb","from":"c1","predicate":"belongsTo","to":"grp-qingyun","source":{"kind":"chapter","ref":"ch-007"},"createdAt":"2026-10-27T00:00:00.000Z"}',
      '{"id":"ed-cccccc","from":"c1","predicate":"belongsTo","to":"ghost","source":{"kind":"agent"},"createdAt":"2026-10-27T00:00:00.000Z"}',
    ].join('\n'),
    'utf8',
  )
})

afterEach(async () => {
  clearGraphCache()
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const app = () => createApp()

describe('/api/ontology', () => {
  it('★ 图包含虚拟节点、附加节点与三类边', async () => {
    const r = await app().request('/api/ontology/graph')
    expect(r.status).toBe(200)
    const j = (await r.json()) as {
      nodes: { id: string; classIds: string[]; virtual: boolean }[]
      edges: { id: string; virtual: boolean }[]
      issues: { code: string }[]
    }
    const c1 = j.nodes.find((n) => n.id === 'c1')
    expect(c1).toMatchObject({ virtual: true })
    expect(c1?.classIds).toContain('cls-character')
    const grp = j.nodes.find((n) => n.id === 'grp-qingyun')
    expect(grp?.classIds).toEqual(['cls-group', 'cls-sect'])
    expect(j.edges.find((e) => e.id === 'rel-r1')?.virtual).toBe(true)
    expect(j.issues.map((i) => i.code)).toContain('EDGE_ENDPOINT_MISSING')
  })

  it('按类过滤：cls-sect 只含宗门实例', async () => {
    const j = (await (await app().request('/api/ontology/graph?class=cls-sect')).json()) as {
      nodes: { id: string }[]
    }
    expect(j.nodes.map((n) => n.id)).toEqual(['grp-qingyun'])
  })

  it('搜索命中名字与别名；节点详情返回关联边', async () => {
    const s = (await (await app().request('/api/ontology/search?q=青云')).json()) as {
      nodes: { id: string }[]
    }
    expect(s.nodes[0]?.id).toBe('grp-qingyun')

    const d = await app().request('/api/ontology/nodes/grp-qingyun')
    expect(d.status).toBe(200)
    const detail = (await d.json()) as { node: { name: string }; edges: { id: string }[] }
    expect(detail.node.name).toBe('青云宗')
    expect(detail.edges.map((e) => e.id).sort()).toEqual(['ed-aaaaaa', 'ed-bbbbbb'])
  })

  it('不存在的节点 → 404', async () => {
    expect((await app().request('/api/ontology/nodes/nope')).status).toBe(404)
  })

  it('类表带实例计数', async () => {
    const j = (await (await app().request('/api/ontology/classes')).json()) as {
      classes: { id: string; instanceCount: number }[]
    }
    const sect = j.classes.find((c) => c.id === 'cls-sect')
    expect(sect?.instanceCount).toBe(1)
  })

  it('reload 清缓存后仍可读', async () => {
    expect((await app().request('/api/ontology/reload', { method: 'POST' })).status).toBe(200)
    expect((await app().request('/api/ontology/graph')).status).toBe(200)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run --project integration apps/api/src/routes/ontology.http.test.ts`
Expected: FAIL，`Cannot find module '../services/ontology-service.js'`

- [ ] **Step 3: 写服务**

```ts
import { join, relative } from 'node:path'
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
import { getContext } from './context.js'
import { readJsonElement } from '../storage/elements.js'
import { readOntologyFiles } from '../storage/ontology.js'
import { bookPaths } from '../storage/paths.js'

let cache: { root: string; mtimeMax: number; snapshot: GraphSnapshot } | null = null

export function clearGraphCache(): void {
  cache = null
}

interface Parser<T> {
  safeParse: (v: unknown) => { success: boolean; data?: T }
}

async function readArray<T>(root: string, rel: string, schema: Parser<T>): Promise<T[]> {
  const raw = await readJsonElement(root, rel)
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const item of raw) {
    const parsed = schema.safeParse(item)
    if (parsed.success && parsed.data !== undefined) out.push(parsed.data)
  }
  return out
}

/**
 * 图谱快照。
 * ★ 缓存按 root + mtimeMax：任一文件（含实体文件）变化都会重建。
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
  if (cache !== null && cache.root === root && cache.mtimeMax === files.mtimeMax) {
    return cache.snapshot
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
    builtFrom: {
      files: [...files.files, ...watchFiles.map((f) => relative(root, f).split('\\').join('/'))],
      mtimeMax: files.mtimeMax,
    },
  })
  const snapshot: GraphSnapshot = { ...base, issues: [...base.issues, ...validateGraph(base)] }
  cache = { root, mtimeMax: files.mtimeMax, snapshot }
  return snapshot
}
```

- [ ] **Step 4: 写路由并挂载**

`apps/api/src/routes/ontology.ts`：

```ts
import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { clearGraphCache, getGraphSnapshot } from '../services/ontology-service.js'

export const ontologyRoutes = new Hono()

function limitOf(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def)
  if (!Number.isInteger(n) || n <= 0) return def
  return Math.min(n, max)
}

ontologyRoutes.get('/ontology/graph', async (c) => {
  const snap = await getGraphSnapshot()
  const classId = c.req.query('class')
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const issuesOnly = c.req.query('issues') === '1'
  const limit = limitOf(c.req.query('limit'), 400, 800)
  const issueSubjects = new Set(snap.issues.map((i) => i.subject))

  let nodes = [...snap.nodes.values()]
  if (classId !== undefined && classId.length > 0) {
    nodes = nodes.filter((n) => snap.classOf.get(n.id)?.includes(classId) === true)
  }
  if (q.length > 0) {
    nodes = nodes.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        (n.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    )
  }
  if (issuesOnly) nodes = nodes.filter((n) => issueSubjects.has(n.id))
  nodes = nodes.slice(0, limit)

  const ids = new Set(nodes.map((n) => n.id))
  const edges = snap.edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const builtAt = new Date(snap.builtFrom.mtimeMax || Date.now()).toISOString()

  return c.json({
    nodes: nodes.map((n) => ({ ...n, classIds: snap.classOf.get(n.id) ?? [] })),
    edges,
    classes: snap.classes,
    predicates: snap.predicates,
    issues: snap.issues,
    builtAt,
  })
})

ontologyRoutes.get('/ontology/nodes/:id', async (c) => {
  const snap = await getGraphSnapshot()
  const id = c.req.param('id')
  const node = snap.nodes.get(id)
  if (node === undefined) throw new InkloomError('NOT_FOUND', `节点 ${id} 不存在`)
  return c.json({
    node: { ...node, classIds: snap.classOf.get(id) ?? [] },
    edges: snap.edges.filter((e) => e.from === id || e.to === id),
    issues: snap.issues.filter((i) => i.subject === id),
  })
})

ontologyRoutes.get('/ontology/classes', async (c) => {
  const snap = await getGraphSnapshot()
  const counts = new Map<string, number>()
  for (const ids of snap.classOf.values()) {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return c.json({
    classes: snap.classes.map((cl) => ({ ...cl, instanceCount: counts.get(cl.id) ?? 0 })),
    predicates: snap.predicates,
  })
})

ontologyRoutes.get('/ontology/search', async (c) => {
  const snap = await getGraphSnapshot()
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  if (q.length === 0) return c.json({ nodes: [] })
  const limit = limitOf(c.req.query('limit'), 20, 50)
  const nodes = [...snap.nodes.values()]
    .filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        (n.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
    )
    .slice(0, limit)
  return c.json({ nodes })
})

ontologyRoutes.post('/ontology/reload', (c) => {
  clearGraphCache()
  return c.json({ ok: true })
})
```

`apps/api/src/app.ts` 修改：

```ts
import { ontologyRoutes } from './routes/ontology.js'
```

在 `app.route('/api', agentRoutes)` 之前加：

```ts
  app.route('/api', ontologyRoutes)
```

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run --project integration apps/api/src/routes/ontology.http.test.ts && pnpm tsc`
Expected: 6 passed；tsc 无输出

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/services/ontology-service.ts apps/api/src/routes/ontology.ts apps/api/src/routes/ontology.http.test.ts apps/api/src/app.ts
git commit -m "feat(ontology): graph service and read-only HTTP routes"
```

---

### Task 6: 前端「图谱」——类树 + 画布 + 详情

**Files:**
- Modify: `apps/web/src/stores/session.ts`（`MODULES` 增加 `'ontology'`）
- Modify: `apps/web/src/shell/AppShell.tsx`（模块表、import、渲染）
- Modify: `apps/web/src/api/types.ts`（新增 Ontology 类型）
- Modify: `apps/web/src/api/hooks.ts`（三个 query hooks）
- Create: `apps/web/src/pages/OntologyPage.tsx`

**Interfaces:**
- Consumes: Task 5 的 `/api/ontology/graph`、`/nodes/:id`、`/classes`；既有 `api` / `useQuery` / `ModuleId` / React Flow
- Produces: `useOntologyGraph(params)`、`useOntologyNode(id)`、`useOntologyClasses()`；模块 `ontology`

- [ ] **Step 1: 先加模块与类型（这一步没有测试，靠 tsc）**

`apps/web/src/stores/session.ts`：把 `MODULES` 数组改成（在 `'story'` 后插入）：

```ts
export const MODULES = [
  'overview',
  'agent',
  'world',
  'cast',
  'story',
  'ontology',
  'write',
  'assets',
  'settings',
] as const
```

`apps/web/src/api/types.ts` 末尾追加：

```ts
// ---------------------------------------------------------------------------
// 图谱（世界模型）
// ---------------------------------------------------------------------------
export interface OntologyNodeRow {
  id: string
  type: string
  name: string
  aliases?: string[]
  attrs: Record<string, string>
  virtual: boolean
  sourceFile?: string
  classIds: string[]
}

export interface OntologyEdgeRow {
  id: string
  from: string
  predicate: string
  to: string
  sinceChapter?: number
  untilChapter?: number
  confidence?: number
  retracted?: boolean
  virtual: boolean
  undirected?: boolean
  sourceFile?: string
}

export interface OntologyClassRow {
  id: string
  name: string
  parentId: string | null
  kind: string
  properties: unknown[]
  rules: unknown[]
  instanceCount?: number
}

export interface OntologyPredicateRow {
  id: string
  label: string
  domain: unknown
  range: unknown
  directed: boolean
  transitive?: boolean
  inverseOf?: string
}

export interface OntologyIssueRow {
  severity: 'error' | 'warning'
  code: string
  subject: string
  message: string
}

export interface OntologyGraphData {
  nodes: OntologyNodeRow[]
  edges: OntologyEdgeRow[]
  classes: OntologyClassRow[]
  predicates: OntologyPredicateRow[]
  issues: OntologyIssueRow[]
  builtAt: string
}

export interface OntologyNodeDetail {
  node: OntologyNodeRow
  edges: OntologyEdgeRow[]
  issues: OntologyIssueRow[]
}

export interface OntologyClassesData {
  classes: OntologyClassRow[]
  predicates: OntologyPredicateRow[]
}
```

- [ ] **Step 2: 写 hooks**

`apps/web/src/api/hooks.ts` 顶部 import 的类型列表追加：

```ts
  OntologyClassesData,
  OntologyGraphData,
  OntologyNodeDetail,
```

文件末尾追加：

```ts
// ---------------------------------------------------------------------------
// 图谱
// ---------------------------------------------------------------------------

export function useOntologyGraph(params: {
  classId?: string | undefined
  q?: string
  issuesOnly?: boolean
}) {
  const search = new URLSearchParams()
  if (params.classId !== undefined) search.set('class', params.classId)
  if (params.q !== undefined && params.q.length > 0) search.set('q', params.q)
  if (params.issuesOnly === true) search.set('issues', '1')
  const qs = search.toString()
  return useQuery({
    queryKey: ['ontology', 'graph', qs],
    queryFn: () => api<OntologyGraphData>(`/ontology/graph${qs.length > 0 ? `?${qs}` : ''}`),
  })
}

export function useOntologyNode(id: string | null) {
  return useQuery({
    queryKey: ['ontology', 'node', id],
    queryFn: () => api<OntologyNodeDetail>(`/ontology/nodes/${id}`),
    enabled: id !== null,
  })
}

export function useOntologyClasses() {
  return useQuery({
    queryKey: ['ontology', 'classes'],
    queryFn: () => api<OntologyClassesData>('/ontology/classes'),
  })
}
```

- [ ] **Step 3: 写页面**

`apps/web/src/pages/OntologyPage.tsx`：

```tsx
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  ReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useOntologyGraph, useOntologyNode } from '../api/hooks'
import type { OntologyClassRow, OntologyNodeRow } from '../api/types'

const TYPE_LABEL: Record<string, string> = {
  character: '人物',
  group: '组织',
  place: '地点',
  rule: '规则',
  item: '物品',
  concept: '概念',
  class: '类',
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

const EXAMPLES = ['林岚', '寒山关', '世界规则']

function primaryClass(n: OntologyNodeRow): string {
  return n.classIds[0] ?? 'cls-concept'
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
    </div>
  )
}

export function OntologyPage() {
  const [classId, setClassId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const { data, isLoading, error } = useOntologyGraph({
    classId: classId ?? undefined,
    q,
    issuesOnly,
  })
  const detail = useOntologyNode(selected)

  const flow = useMemo(() => {
    if (data === undefined) return { nodes: [] as Node[], edges: [] as Edge[] }
    const classOrder = data.classes.map((c) => c.id)
    const rows = new Map<string, number>()
    const nodes: Node[] = data.nodes.map((n) => {
      const cls = primaryClass(n)
      const col = Math.max(0, classOrder.indexOf(cls))
      const rowIndex = rows.get(cls) ?? 0
      rows.set(cls, rowIndex + 1)
      return {
        id: n.id,
        position: { x: 40 + col * 230, y: 40 + rowIndex * 84 },
        data: { label: n.name },
        style: {
          width: 160,
          fontSize: 12,
          borderRadius: 8,
          background: '#fff',
          color: '#262626',
          border: `${n.virtual ? 1 : 2}px solid ${TYPE_COLOR[n.type] ?? '#737373'}`,
        },
      }
    })
    const edges: Edge[] = data.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.predicate.startsWith('rel:') ? e.predicate.slice(4) : e.predicate,
      style: {
        stroke: e.virtual ? '#d4d4d4' : '#8a8a8a',
        strokeDasharray: e.retracted === true ? '2 4' : undefined,
      },
      labelStyle: { fontSize: 9, fill: '#737373' },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
    }))
    return { nodes, edges }
  }, [data])

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    setQ(draft.trim())
  }

  return (
    <div className="flex h-full min-h-0 w-full bg-white">
      <aside className="flex w-52 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/60">
        <div className="border-b border-neutral-200 px-3 py-3">
          <h1 className="text-sm font-semibold text-neutral-900">图谱</h1>
          <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">
            类—实例—边；人物/地点/规则是自动聚合的虚拟节点。
          </p>
          <form onSubmit={submit} className="mt-2 flex gap-1">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="搜节点名"
              className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-[11px] focus:border-neutral-500 focus:outline-none"
            />
            <button
              type="submit"
              className="shrink-0 rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
            >
              搜
            </button>
          </form>
          <label className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-500">
            <input
              type="checkbox"
              checked={issuesOnly}
              onChange={(e) => setIssuesOnly(e.target.checked)}
            />
            只看有问题的节点
          </label>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          {data === undefined ? (
            <p className="px-1 text-[11px] text-neutral-400">读取类表…</p>
          ) : (
            <ClassTree classes={data.classes} active={classId} onPick={setClassId} />
          )}
        </div>
        <div className="border-t border-neutral-200 px-3 py-2 text-[10px] leading-4 text-neutral-500">
          {data === undefined
            ? '—'
            : `${data.nodes.length} 节点 · ${data.edges.length} 边 · ${data.issues.length} 问题`}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 px-4 py-2">
          <p className="text-[12px] text-neutral-500">
            {q.length > 0 ? `搜索「${q}」` : classId === null ? '全部节点' : classId}
          </p>
          {q.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setQ('')
                setDraft('')
              }}
              className="text-[11px] text-neutral-500 hover:text-neutral-900"
            >
              清除
            </button>
          )}
          <p className="ml-auto text-[10px] text-neutral-400">实线=已入图 · 浅色=既有数据投影</p>
        </header>

        <div className="relative min-h-0 flex-1">
          {isLoading && <p className="p-6 text-sm text-neutral-500">构建图谱…</p>}
          {error !== null && <p className="p-6 text-sm text-rose-700">{error.message}</p>}
          {data !== undefined && data.nodes.length === 0 && (
            <div className="p-6">
              <p className="text-sm text-neutral-600">没有匹配的节点。</p>
              <p className="mt-2 text-[11px] text-neutral-500">试试：</p>
              <div className="mt-1 flex gap-1.5">
                {EXAMPLES.map((x) => (
                  <button
                    key={x}
                    type="button"
                    onClick={() => {
                      setDraft(x)
                      setQ(x)
                    }}
                    className="rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
                  >
                    {x}
                  </button>
                ))}
              </div>
            </div>
          )}
          {data !== undefined && data.nodes.length > 0 && (
            <ReactFlow
              key={`${data.builtAt}-${classId ?? 'all'}-${q}-${issuesOnly ? 'i' : ''}`}
              defaultNodes={flow.nodes}
              defaultEdges={flow.edges}
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_, node) => setSelected(node.id)}
              fitView
              minZoom={0.2}
              maxZoom={1.6}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} color="#e5e5e5" />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
          {data !== undefined && data.issues.length > 0 && (
            <div className="absolute bottom-2 left-2 right-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
              {data.issues.slice(0, 3).map((i) => (
                <p key={`${i.code}-${i.subject}`}>
                  [{i.code}] {i.message}
                </p>
              ))}
              {data.issues.length > 3 && <p>另有 {data.issues.length - 3} 条问题</p>}
            </div>
          )}
        </div>
      </div>

      <aside className="flex w-80 shrink-0 flex-col border-l border-neutral-200 bg-neutral-50/60">
        <div className="border-b border-neutral-200 px-4 py-3">
          <p className="text-[11px] font-medium text-neutral-500">节点详情</p>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {selected === null ? (
            <p className="text-[11px] leading-5 text-neutral-500">
              点画布上的节点查看属性、关系与来源。
            </p>
          ) : detail.data === undefined ? (
            <p className="text-[11px] text-neutral-400">{detail.isLoading ? '读取…' : '没有数据'}</p>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-[13px] font-medium text-neutral-900">{detail.data.node.name}</p>
                <p className="mt-0.5 text-[10px] text-neutral-500">
                  {TYPE_LABEL[detail.data.node.type] ?? detail.data.node.type} ·{' '}
                  {detail.data.node.virtual ? '虚拟节点（来自原文件）' : '图谱节点'} ·{' '}
                  {detail.data.node.id}
                </p>
              </div>

              <div>
                <p className="mb-1 text-[10px] font-medium text-neutral-400">所属类</p>
                <p className="text-[11px] text-neutral-700">
                  {detail.data.node.classIds
                    .map((id) => data?.classes.find((c) => c.id === id)?.name ?? id)
                    .join(' · ') || '未分类'}
                </p>
              </div>

              <div>
                <p className="mb-1 text-[10px] font-medium text-neutral-400">属性</p>
                {Object.keys(detail.data.node.attrs).length === 0 ? (
                  <p className="text-[11px] text-neutral-500">—</p>
                ) : (
                  <ul className="space-y-0.5">
                    {Object.entries(detail.data.node.attrs).map(([k, v]) => (
                      <li key={k} className="text-[11px] leading-5 text-neutral-600">
                        <span className="text-neutral-400">{k}</span>：{v}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="mb-1 text-[10px] font-medium text-neutral-400">
                  关系（{detail.data.edges.length}）
                </p>
                <ul className="space-y-0.5">
                  {detail.data.edges.map((e) => (
                    <li key={e.id} className="text-[11px] leading-5 text-neutral-600">
                      {e.from === detail.data?.node.id ? '→' : '←'} {e.predicate}{' '}
                      {e.from === detail.data?.node.id ? e.to : e.from}
                      {e.sinceChapter === undefined ? '' : ` · 第 ${e.sinceChapter} 章起`}
                    </li>
                  ))}
                </ul>
              </div>

              {detail.data.issues.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-5 text-amber-800">
                  {detail.data.issues.map((i) => (
                    <p key={`${i.code}-${i.subject}`}>{i.message}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
```

`apps/web/src/shell/AppShell.tsx`：

```ts
import { OntologyPage } from '../pages/OntologyPage'
```

`MODULES` 里 `story` 之后加：

```ts
  { id: 'ontology', label: '图谱', icon: '⊞' },
```

`<main>` 里 `story` 之后加：

```tsx
          {module === 'ontology' && <OntologyPage />}
```

- [ ] **Step 4: 类型检查**

Run: `pnpm tsc`
Expected: 无输出

- [ ] **Step 5: 手工看一眼**

启动 API 与前端（终端 1 `pnpm api`，终端 2 `pnpm web`），打开 `http://localhost:5173` → 左栏「图谱」：

- 七霞书上应看到人物/地点/规则/概念节点，关系边标 `enemy/kin/...`
- 点「林岚」→ 右栏出现属性、所属类（人物）、关系列表
- 搜索「林岚」→ 只剩一个节点；清空恢复
- 勾选「只看有问题的节点」→ 有悬空边时能过滤出来（七霞没有 canon 边时应为空）
- 控制台无 error

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/OntologyPage.tsx apps/web/src/api/types.ts apps/web/src/api/hooks.ts apps/web/src/shell/AppShell.tsx apps/web/src/stores/session.ts
git commit -m "feat(ontology): read-only graph page with class tree and inspector"
```

---

### Task 7: 真实书验收、README 与全量验证

**Files:**
- Modify: `README.md`
- Create: `docs/screenshots/accept-ontology.png`
- Modify: `docs/superpowers/plans/2026-10-27-world-ontology-s1.md`（勾选完成项不用改文件；本任务只加验收记录到 README）

**Interfaces:**
- Consumes: Task 1–6 全部
- Produces: 可引用的验收截图与 README 说明

- [ ] **Step 1: 在七霞书上做三问验收**

用真实书（七霞）打开图谱页，逐条记录：

1. 搜「林岚」→ 节点存在，所属类含「人物」，关系里有 `rel:*` 边
2. 搜「寒山关」→ 节点存在，所属类含「地点」
3. 在 `world/ontology/nodes.jsonl` 手工追加一条 `{"id":"grp-test","type":"group","name":"测试宗门","createdAt":"..."}`，刷新页面 → 节点出现、类为「组织」；删除该行后刷新恢复（这一步只验证读取链路，不改代码）

截图保存为 `docs/screenshots/accept-ontology.png`（1280×800，显示类树 + 画布 + 右栏详情）。

- [ ] **Step 2: README 增补**

模块表加一行（在「故事」后）：

```markdown
| **图谱** | 类—实例—边：人物/地点/规则自动入图；点节点看属性、来源与关系 |
```

在「书库」一节后加：

```markdown
---

## 图谱：看得见的世界模型

![图谱](docs/screenshots/accept-ontology.png)

- 人物、地点、规则、线索、卷是**虚拟节点**：来自各自文件，改要去原模块改
- 势力、物品、概念可以写进 `world/ontology/nodes.jsonl`；类与谓词在 `world/ontology/classes.json`
- 跨类型边在 `world/ontology/edges.jsonl`（append-only，带章节区间与来源）
- 图谱只读：切片 1 不做提案与事件；Agent 提议、事件链沙盘在后续切片
```

- [ ] **Step 3: 全量验证**

Run: `pnpm verify`
Expected: biome + tsc（含 web）+ check-deps + 单元 + 集成全绿；记录实际用例数，更新 README 的验证一行（当前基线 303 单元 + 304 集成，新增后按实际数字改）

- [ ] **Step 4: 提交**

```bash
git add README.md docs/screenshots/accept-ontology.png
git commit -m "docs(ontology): graph page acceptance screenshot and README"
```

---

## 后续切片（不在本计划内）

- **切片 2**：`story/events.jsonl`、提案日志与门禁、`query_graph` / `query_events` / `propose_graph_edit`、`read_book` 图谱摘要、事件页签。
- **切片 3**：domain/range 与类规则校验、`inferEdges` / `explainFact` / `matchPattern`、推导链 UI、`verify:ontology`、性能基准。

两份后续计划在切片 1 验收通过后另写，避免一次改太多。

## 计划自审

- **Spec 覆盖（切片 1 部分）**：§4.1/§4.2/§4.3 文件格式 → Task 1；§5.1 buildGraph + 虚拟节点/边 + 类闭包 → Task 2；§6 前五类 issue → Task 3；§7 读取接口（graph/nodes/classes/search/reload）→ Task 4/5；§9 UI → Task 6；§11 测试与验收（切片 1 部分）→ Task 3/4/5/7。事件、提案、推导、Agent 工具属于切片 2/3，已在文末标明。
- **占位符**：无 TBD/TODO；每个代码步骤都有可粘贴代码与运行命令。
- **类型一致性**：`GraphSnapshot` 在 Task 2 定义、Task 3 使用、Task 5 序列化；`OntologyFiles` 在 Task 4 定义、Task 5 使用；前端字段与 Task 5 的 JSON 一一对应（`classIds`、`builtAt`、`instanceCount`）。
- **已知取舍**：切片 1 的 `builtAt` 由 `mtimeMax` 推出（缓存命中时不重新取时间）；`DUP_NODE` 在 buildGraph 里产生，其余 issue 在 validate 里产生，服务层合并——两处都会出现在同一个 `issues` 数组。

## 执行方式

计划完成后，二选一：

1. **Subagent-Driven（推荐）**：每个任务派一个全新子智能体，任务间做 spec + 质量双审。
2. **Inline Execution**：在当前会话按任务批量执行，检查点处暂停审阅。
