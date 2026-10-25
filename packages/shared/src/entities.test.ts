import { describe, expect, it } from 'vitest'
import { blueprintSchema, characterSchema, projectSchema } from './entities.js'
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
