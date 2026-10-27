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

/** 类 id：cls- 后跟 kebab 段，禁止空段与连续连字符 */
const classIdSchema = z.string().regex(/^cls-[a-z0-9]+(?:-[a-z0-9]+)*$/, '类 id 形如 cls-sect')

/** 谓词 id：小驼峰或下划线，与 classes.json 的 predicates[].id 同构 */
const predicateIdSchema = z.string().regex(/^[a-z][a-zA-Z0-9_]*$/, '谓词 id 用小驼峰/下划线')

/** 附加节点的前缀与 type 必须一致（spec §4.2） */
const NODE_ID_PREFIX = { group: 'grp', item: 'itm', concept: 'cpt' } as const

/**
 * 类规则：5 种 kind 各自需要的字段不同。
 * 校验放在 schema 层，切片 3 的规则引擎就不必处理 undefined。
 */
export const classRuleSchema = z
  .object({
    id: z.string().min(1).max(64),
    severity: z.enum(['hard', 'soft']).default('hard'),
    kind: z.enum(CLASS_RULE_KINDS),
    property: z.string().min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    predicate: predicateIdSchema.optional(),
    classId: classIdSchema.optional(),
    message: z.string().min(1).max(200),
  })
  .superRefine((r, ctx) => {
    const need = (ok: boolean, path: string, msg: string): void => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message: msg })
    }
    if (r.kind === 'range')
      need(r.property !== undefined && r.min !== undefined, 'min', 'range 规则需 property 与 min')
    if (r.kind === 'requires')
      need(r.property !== undefined, 'property', 'requires 规则需 property')
    if (r.kind === 'requiresEdge' || r.kind === 'forbidsEdge') {
      need(r.predicate !== undefined, 'predicate', `${r.kind} 规则需 predicate`)
    }
    if (r.kind === 'disjointWith')
      need(r.classId !== undefined, 'classId', 'disjointWith 规则需 classId')
  })
  .describe('classRule')
export type ClassRule = z.infer<typeof classRuleSchema>

export const classDefSchema = z.object({
  id: classIdSchema,
  name: z.string().min(1).max(40),
  parentId: classIdSchema.nullable().default(null),
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
  id: predicateIdSchema,
  label: z.string().min(1).max(20),
  domain: z.union([z.literal('any'), z.array(classIdSchema)]).default('any'),
  range: z.union([z.literal('any'), z.literal('class'), z.array(classIdSchema)]).default('any'),
  directed: z.boolean().default(true),
  transitive: z.boolean().default(false),
  inverseOf: predicateIdSchema.optional(),
})
export type PredicateDef = z.infer<typeof predicateDefSchema>

export const classesFileSchema = z.object({
  version: z.literal(1).default(1),
  classes: z.array(classDefSchema).max(20, '类上限 20，超了先拆 spec').default([]),
  predicates: z.array(predicateDefSchema).max(20, '谓词上限 20，超了先拆 spec').default([]),
})
export type ClassesFile = z.infer<typeof classesFileSchema>

export const ontologyNodeSchema = z
  .object({
    id: z.string().regex(/^(grp|itm|cpt)-[a-z0-9]+(?:-[a-z0-9]+)*$/, '节点 id 形如 grp-qingyun'),
    type: z.enum(['group', 'item', 'concept']),
    name: z.string().min(1).max(80),
    aliases: z.array(z.string().min(1).max(80)).default([]),
    summary: z.string().max(500).default(''),
    attrs: z.record(z.string(), z.string()).default({}),
    createdAt: z.string().datetime(),
  })
  .refine((n) => n.id.startsWith(`${NODE_ID_PREFIX[n.type]}-`), {
    message: 'id 前缀必须与 type 一致（grp-/itm-/cpt-）',
    path: ['id'],
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
  retracts: z
    .string()
    .regex(/^ed-[a-f0-9]{6}$/, '废止边 id 形如 ed-7f3c91')
    .optional(),
  createdAt: z.string().datetime(),
})
export type GraphEdge = z.infer<typeof graphEdgeSchema>
