import { describe, expect, it } from 'vitest'
import type { AssembleInput } from './assemble.js'
import { assemble, DEFAULT_BUDGET } from './assemble.js'

const base: AssembleInput = {
  style: {
    id: 's1',
    projectId: 'p1',
    name: '冷硬短句',
    description: '短句为主',
    samples: ['风从袖口灌进来。'],
    bannedWords: ['仿佛'],
    bannedPatterns: [],
    quantLimits: {},
    isDefault: true,
  },
  project: {
    id: 'p1',
    folderId: 'f1',
    rootPath: '/b',
    name: '七霞',
    genre: '玄幻',
    coreIdea: '剑冢里的名字',
    theme: '名字与身份',
    anchorLocked: true,
    status: 'draft',
    createdAt: '2026-10-25T00:00:00.000Z',
  },
  blueprint: {
    id: 'b4',
    projectId: 'p1',
    chapterNo: 4,
    goal: '走到碑前',
    conflict: '裴无咎阻拦',
    hook: '碑上的名字是她自己',
    castIds: ['c1'],
    beatType: 'climax',
    tensionLevel: 5,
  },
  cast: [{ id: 'c1', projectId: 'p1', name: '林岚', role: 'protagonist', stateStale: false }],
  relations: [],
  tiers: [],
  location: null,
  routes: [],
  hardRules: [],
  softRules: [],
  timeline: [],
  upcoming: [],
  unresolved: [],
  summaries: [],
  previousEnding: null,
  signatures: [],
  userGuidance: null,
}

describe('assemble', () => {
  it('★ 只产生两条 message：system + user', () => {
    const a = assemble(base, DEFAULT_BUDGET)
    expect(a.messages).toHaveLength(2)
    expect(a.messages[0]?.role).toBe('system')
    expect(a.messages[1]?.role).toBe('user')
  })

  it('★ system 里按 S1→S5 顺序（前缀缓存的前提）', () => {
    const a = assemble(base, DEFAULT_BUDGET)
    const sys = a.messages[0]?.content ?? ''
    const iS1 = sys.indexOf('网文作者')
    const iS2 = sys.indexOf('文风契约')
    const iS3 = sys.indexOf('反 AI 味规则')
    const iS5 = sys.indexOf('输出格式')
    expect(iS1).toBeGreaterThanOrEqual(0)
    expect(iS1).toBeLessThan(iS2)
    expect(iS2).toBeLessThan(iS3)
    expect(iS3).toBeLessThan(iS5)
  })

  it('★ 锚点必须是 user 消息里最后一个块（对抗 lost-in-the-middle）', () => {
    const a = assemble(base, DEFAULT_BUDGET)
    const user = a.messages[1]?.content ?? ''
    const iAnchor = user.indexOf('不可偏离的作者事实')
    const iBlueprint = user.indexOf('本章蓝图')
    expect(iAnchor).toBeGreaterThan(iBlueprint)
    // 锚点之后不应再有其它块标题
    const after = user.slice(iAnchor)
    expect(after).not.toContain('【本章蓝图】')
    expect(after).not.toContain('【上一章结尾】')
    expect(after).not.toContain('【全书进度】')
  })

  it('★ S 段里绝不出现章节号（跨章一致才能命中缓存）', () => {
    const a = assemble({ ...base, blueprint: { ...base.blueprint, chapterNo: 99 } }, DEFAULT_BUDGET)
    const sys = a.messages[0]?.content ?? ''
    expect(sys).not.toMatch(/第\s*99\s*章/)
  })

  it('空内容的块被跳过（不产生连续空行堆积）', () => {
    const a = assemble(base, DEFAULT_BUDGET)
    const user = a.messages[1]?.content ?? ''
    expect(user).not.toContain('\n\n\n\n')
  })

  it('返回 tokenEstimate 与 usedRatio', () => {
    const a = assemble(base, DEFAULT_BUDGET)
    expect(a.tokenEstimate).toBeGreaterThan(0)
    expect(a.usedRatio).toBeGreaterThan(0)
    expect(a.usedRatio).toBeLessThanOrEqual(1)
  })

  it('返回参与装配的 blocks（便于存档与回放）', () => {
    const a = assemble(base, DEFAULT_BUDGET)
    expect(a.blocks.length).toBeGreaterThan(0)
    expect(a.blocks[0]?.id).toBe('S1')
  })

  it('★ 预算极小时 P0 块仍在（宁可超预算也不裁底线）', () => {
    const tiny = { denominator: 10, warnRatio: 0.7, promptRatio: 0.85, forceRatio: 0.95 }
    const a = assemble(base, tiny)
    const ids = a.blocks.map((b) => b.id)
    expect(ids).toContain('S1')
    expect(ids).toContain('U6')
    expect(ids).toContain('U9')
    expect(a.tier).toBe('force')
  })

  it('★ 裁剪后 degradation 非空（可归因）', () => {
    const tiny = { denominator: 10, warnRatio: 0.7, promptRatio: 0.85, forceRatio: 0.95 }
    const a = assemble(
      {
        ...base,
        previousEnding: '剑气贴着面颊削过去。',
        userGuidance: '少说话',
      },
      tiny,
    )
    expect(a.degradation.length).toBeGreaterThan(0)
    // U1 是 P1，不该被裁
    expect(a.degradation.every((d) => d.blockId !== 'U1')).toBe(true)
  })
})
