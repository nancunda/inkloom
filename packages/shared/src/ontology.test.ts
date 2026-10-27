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

  it('nodeType 只允许 7 种', () => {
    expect(nodeTypeSchema.options).toHaveLength(7)
    expect(() => nodeTypeSchema.parse('event')).toThrow()
  })
})
