import type { ClassesFile } from '@inkloom/shared'

/**
 * 类文件缺失时的默认本体（spec §4.1）。
 * ★ 只读默认值，不落盘；作者一旦创建 classes.json 就以文件为准。
 */
export const DEFAULT_CLASSES_FILE: ClassesFile = {
  version: 1,
  classes: [
    {
      id: 'cls-character',
      name: '人物',
      parentId: null,
      kind: 'character',
      properties: [],
      rules: [],
    },
    {
      id: 'cls-group',
      name: '组织',
      parentId: null,
      kind: 'group',
      properties: [],
      rules: [],
    },
    {
      id: 'cls-sect',
      name: '宗门',
      parentId: 'cls-group',
      kind: 'group',
      properties: [],
      rules: [],
    },
    { id: 'cls-place', name: '地点', parentId: null, kind: 'place', properties: [], rules: [] },
    { id: 'cls-rule', name: '规则', parentId: null, kind: 'rule', properties: [], rules: [] },
    { id: 'cls-item', name: '物品', parentId: null, kind: 'item', properties: [], rules: [] },
    {
      id: 'cls-concept',
      name: '概念',
      parentId: null,
      kind: 'concept',
      properties: [],
      rules: [],
    },
  ],
  predicates: [
    {
      id: 'instanceOf',
      label: '属于类',
      domain: 'any',
      range: 'class',
      directed: true,
      transitive: false,
    },
    {
      id: 'belongsTo',
      label: '隶属于',
      domain: ['cls-character', 'cls-group'],
      range: ['cls-group'],
      directed: true,
      transitive: true,
    },
    {
      id: 'controls',
      label: '控制',
      domain: ['cls-group'],
      range: ['cls-place'],
      directed: true,
      transitive: false,
    },
    {
      id: 'violates',
      label: '违反',
      domain: ['cls-character'],
      range: ['cls-rule'],
      directed: true,
      transitive: false,
    },
    {
      id: 'mentorOf',
      label: '师父',
      domain: ['cls-character'],
      range: ['cls-character'],
      directed: true,
      transitive: false,
      inverseOf: 'apprenticeOf',
    },
    {
      id: 'apprenticeOf',
      label: '徒弟',
      domain: ['cls-character'],
      range: ['cls-character'],
      directed: true,
      transitive: false,
      inverseOf: 'mentorOf',
    },
  ],
}
