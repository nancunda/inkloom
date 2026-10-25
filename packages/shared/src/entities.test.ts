import { describe, expect, it } from 'vitest'
import {
  blueprintSchema,
  characterSchema,
  characterSignatureSchema,
  plotThreadSchema,
  projectSchema,
  routeSchema,
  styleAssetSchema,
  writingTechniqueSchema,
} from './entities.js'
import { InkloomError } from './errors.js'

describe('projectSchema', () => {
  const valid = {
    id: 'p1',
    folderId: 'f1',
    rootPath: '/books/qixia',
    name: '七霞',
    genre: '玄幻',
    status: 'draft' as const,
    anchorLocked: false,
    createdAt: '2026-10-25T00:00:00.000Z',
  }

  it('接受合法项目', () => {
    expect(projectSchema.parse(valid).name).toBe('七霞')
  })

  it('拒绝非法 status', () => {
    expect(() => projectSchema.parse({ ...valid, status: 'unknown' })).toThrow()
  })

  it('拒绝缺失 rootPath', () => {
    const { rootPath, ...rest } = valid
    void rootPath
    expect(() => projectSchema.parse(rest)).toThrow()
  })

  it('status 与 anchorLocked 有默认值', () => {
    const { status, anchorLocked, ...rest } = valid
    void status
    void anchorLocked
    const p = projectSchema.parse(rest)
    expect(p.status).toBe('draft')
    expect(p.anchorLocked).toBe(false)
  })
})

describe('characterSchema', () => {
  it('接受只有必填字段的角色', () => {
    const c = characterSchema.parse({
      id: 'c1',
      projectId: 'p1',
      name: '林岚',
      role: 'protagonist',
    })
    expect(c.name).toBe('林岚')
    expect(c.stateStale).toBe(false)
  })

  it('拒绝未知 role', () => {
    expect(() =>
      characterSchema.parse({ id: 'c1', projectId: 'p1', name: '林岚', role: 'god' }),
    ).toThrow()
  })

  it('stateChapter 必须是正整数', () => {
    const base = { id: 'c1', projectId: 'p1', name: '林岚', role: 'minor' as const }
    expect(() => characterSchema.parse({ ...base, stateChapter: 0 })).toThrow()
    expect(characterSchema.parse({ ...base, stateChapter: 3 }).stateChapter).toBe(3)
  })
})

describe('blueprintSchema', () => {
  const base = {
    id: 'b4',
    projectId: 'p1',
    chapterNo: 4,
    goal: '进入剑冢',
    conflict: '守碑人阻拦',
    hook: '剑冢深处传来呼唤',
    castIds: ['c1'],
    tensionLevel: 4,
    beatType: 'rising',
  }

  it('接受合法蓝图', () => {
    expect(blueprintSchema.parse(base).chapterNo).toBe(4)
  })

  it('拒绝 chapterNo < 1', () => {
    expect(() => blueprintSchema.parse({ ...base, chapterNo: 0 })).toThrow()
  })

  it('拒绝 tensionLevel 越界（spec 要求 1..5）', () => {
    expect(() => blueprintSchema.parse({ ...base, tensionLevel: 6 })).toThrow()
    expect(() => blueprintSchema.parse({ ...base, tensionLevel: 0 })).toThrow()
  })

  it('castIds 与 beatType 有默认值', () => {
    const { castIds, beatType, ...rest } = base
    void castIds
    void beatType
    const b = blueprintSchema.parse(rest)
    expect(b.castIds).toEqual([])
    expect(b.beatType).toBe('rising')
  })
})

describe('InkloomError', () => {
  it('带 code 字段，可被 instanceof 识别', () => {
    const e = new InkloomError('CAS_MISMATCH', '文件已被外部修改')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('CAS_MISMATCH')
    expect(e.name).toBe('InkloomError')
  })
})

// ---------------------------------------------------------------------------
// 以下测试覆盖二次审查发现的漏洞：refine 留的两个洞 + spec 字段漂移
// ---------------------------------------------------------------------------

describe('writingTechniqueSchema（作用域指针一致性）', () => {
  const base = {
    id: 't1',
    projectId: 'p1',
    name: '欲扬先抑',
    category: 'rhythm' as const,
    content: '先写失落，再写反转',
  }

  it('global 不带任何指针 → 通过', () => {
    expect(writingTechniqueSchema.parse({ ...base, scope: 'global' }).scope).toBe('global')
  })

  it('★ global 携带 arcId → 拒绝（否则注入时被误当局部手法）', () => {
    expect(() => writingTechniqueSchema.parse({ ...base, scope: 'global', arcId: 'a1' })).toThrow()
  })

  it('arc 带 arcId → 通过', () => {
    expect(writingTechniqueSchema.parse({ ...base, scope: 'arc', arcId: 'a1' }).arcId).toBe('a1')
  })

  it('★ arc 不带 arcId → 拒绝', () => {
    expect(() => writingTechniqueSchema.parse({ ...base, scope: 'arc' })).toThrow()
  })

  it('★ arc 带空串 arcId → 拒绝（空串指向不存在的卷）', () => {
    expect(() => writingTechniqueSchema.parse({ ...base, scope: 'arc', arcId: '' })).toThrow()
  })

  it('★ arc 同时带 chapterNo → 拒绝（混带指针会让注入优先级不确定）', () => {
    expect(() =>
      writingTechniqueSchema.parse({ ...base, scope: 'arc', arcId: 'a1', chapterNo: 3 }),
    ).toThrow()
  })

  it('chapter 带 chapterNo → 通过', () => {
    expect(
      writingTechniqueSchema.parse({ ...base, scope: 'chapter', chapterNo: 3 }).chapterNo,
    ).toBe(3)
  })

  it('character 带 characterId → 通过', () => {
    expect(
      writingTechniqueSchema.parse({ ...base, scope: 'character', characterId: 'c1' }).characterId,
    ).toBe('c1')
  })
})

describe('plotThreadSchema（spec §3.7 对齐）', () => {
  const base = {
    id: 't1',
    projectId: 'p1',
    kind: 'foreshadow' as const,
    title: '碑上的名字',
  }

  it('★ plantedChapter 可省略（status=planned 是正常起点）', () => {
    const t = plotThreadSchema.parse(base)
    expect(t.plantedChapter).toBeUndefined()
    expect(t.status).toBe('active')
  })

  it('用 title 而非 name（与 spec 一致）', () => {
    expect(plotThreadSchema.parse({ ...base, plantedChapter: 1 }).title).toBe('碑上的名字')
  })

  it('resolvedChapter 字段名存在', () => {
    const t = plotThreadSchema.parse({ ...base, plantedChapter: 1, resolvedChapter: 8 })
    expect(t.resolvedChapter).toBe(8)
  })

  it('payoffWindow 存在（判定 overdue 的分母）', () => {
    expect(
      plotThreadSchema.parse({ ...base, plantedChapter: 1, payoffWindow: 30 }).payoffWindow,
    ).toBe(30)
  })
})

describe('characterSignatureSchema（spec §3.16 对齐）', () => {
  const base = {
    id: 's1',
    projectId: 'p1',
    characterId: 'c1',
    kind: 'entrance_verse' as const,
    content: '十步杀一人，千里不留行',
    trigger: 'entrance' as const,
  }

  it('接受完整签名', () => {
    const s = characterSignatureSchema.parse(base)
    expect(s.frequency).toBe('key_moment')
    expect(s.isActive).toBe(true)
  })

  it('★ 缺 trigger → 拒绝（frequency 只说多频繁，不说什么场合）', () => {
    const { trigger, ...rest } = base
    void trigger
    expect(() => characterSignatureSchema.parse(rest)).toThrow()
  })

  it('spec 的七种 kind 全部可用', () => {
    const kinds = [
      'entrance_verse',
      'exit_verse',
      'catchphrase',
      'verbal_tick',
      'signature_action',
      'motif',
      'epithet',
    ] as const
    for (const kind of kinds) {
      expect(characterSignatureSchema.parse({ ...base, kind }).kind).toBe(kind)
    }
  })

  it('退场诗可表达（exit 触发）', () => {
    expect(
      characterSignatureSchema.parse({ ...base, kind: 'exit_verse', trigger: 'exit' }).trigger,
    ).toBe('exit')
  })
})

describe('routeSchema（P0-13 系统算）', () => {
  const base = {
    id: 'r1',
    projectId: 'p1',
    fromId: 'l1',
    toId: 'l2',
    mode: 'walk' as const,
    days: 3,
  }

  it('days 必须是正整数（spec 为 Int）', () => {
    expect(routeSchema.parse(base).days).toBe(3)
    expect(() => routeSchema.parse({ ...base, days: 0.5 })).toThrow()
    expect(() => routeSchema.parse({ ...base, days: 0 })).toThrow()
  })

  it('bidirectional 默认 true（传送阵/断桥需显式 false）', () => {
    expect(routeSchema.parse(base).bidirectional).toBe(true)
    expect(routeSchema.parse({ ...base, bidirectional: false }).bidirectional).toBe(false)
  })

  it('condition 可表达季节封闭', () => {
    expect(routeSchema.parse({ ...base, condition: '冬季封闭三个月' }).condition).toBe(
      '冬季封闭三个月',
    )
  })
})

describe('styleAssetSchema（默认文风）', () => {
  const base = { id: 's1', projectId: 'p1', name: '冷硬短句', description: '短句为主' }

  it('isDefault 默认 false', () => {
    expect(styleAssetSchema.parse(base).isDefault).toBe(false)
  })

  it('多次 parse 的默认数组不共享引用（.default(() => []) 而非 .default([])）', () => {
    const a = styleAssetSchema.parse(base)
    const b = styleAssetSchema.parse(base)
    a.samples.push('共享了？')
    expect(b.samples).toHaveLength(0)
  })
})

describe('blueprintSchema 的 beatType 全集', () => {
  const base = {
    id: 'b1',
    projectId: 'p1',
    chapterNo: 1,
    goal: 'g',
    conflict: 'c',
    hook: 'h',
  }

  it('★ falling（高潮后回落）必须可表达', () => {
    expect(blueprintSchema.parse({ ...base, beatType: 'falling' }).beatType).toBe('falling')
  })

  it('storyDay 与 storyTime 可共存（数值算 + 时辰描述）', () => {
    const b = blueprintSchema.parse({ ...base, storyDay: 12, storyTime: '第 12 日 · 辰时' })
    expect(b.storyDay).toBe(12)
    expect(b.storyTime).toBe('第 12 日 · 辰时')
  })
})
