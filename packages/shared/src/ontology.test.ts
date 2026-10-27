import { describe, expect, it } from 'vitest'
import {
  classesFileSchema,
  graphEdgeSchema,
  NODE_TYPES,
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

  it('节点 id 必须带类型前缀，且前缀与 type 一致', () => {
    const base = { type: 'group', name: '青云宗', createdAt: '2026-10-27T00:00:00.000Z' }
    // 中文、错前缀、尾连字符都不行
    expect(() => ontologyNodeSchema.parse({ ...base, id: '青云宗' })).toThrow()
    expect(() => ontologyNodeSchema.parse({ ...base, id: 'zzz-x' })).toThrow()
    expect(() => ontologyNodeSchema.parse({ ...base, id: 'grp-a-' })).toThrow()
    // 前缀与 type 必须对得上
    expect(() => ontologyNodeSchema.parse({ ...base, type: 'item', id: 'grp-a' })).toThrow()
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

  it('类文件：version 默认 1，类规则默认 hard', () => {
    expect(classesFileSchema.parse({}).version).toBe(1)
    const f = classesFileSchema.parse({
      version: 1,
      classes: [
        {
          id: 'cls-sect',
          name: '宗门',
          kind: 'group',
          rules: [
            { id: 'r1', kind: 'requiresEdge', predicate: 'belongsTo', message: '必须有归属' },
          ],
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

  it('类与谓词各限 20 个', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `cls-c${i}`,
      name: `类${i}`,
      kind: 'concept' as const,
    }))
    expect(() => classesFileSchema.parse({ classes: many })).toThrow()
  })

  it('类规则缺少 kind 必需字段时拒绝', () => {
    const wrap = (rule: Record<string, unknown>) => ({
      classes: [{ id: 'cls-sect', name: '宗门', kind: 'group', rules: [rule] }],
    })
    // requiresEdge 缺 predicate
    expect(() =>
      classesFileSchema.parse(wrap({ id: 'r1', kind: 'requiresEdge', message: '必须有归属' })),
    ).toThrow()
    // range 缺 min
    expect(() =>
      classesFileSchema.parse(wrap({ id: 'r2', kind: 'range', property: 'age', message: '年龄' })),
    ).toThrow()
  })

  it('nodeType 只允许 7 种，且与 NODE_TYPES 一致', () => {
    expect([...nodeTypeSchema.options]).toEqual([...NODE_TYPES])
    expect(() => nodeTypeSchema.parse('event')).toThrow()
  })
})
