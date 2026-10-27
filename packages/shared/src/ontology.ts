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
  parentId: z
    .string()
    .regex(/^cls-[a-z0-9-]+$/)
    .nullable()
    .default(null),
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
