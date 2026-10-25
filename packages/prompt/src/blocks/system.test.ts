import type { Project, StyleAsset, WorldRule } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { blockS1, blockS2, blockS3, blockS4, blockS5 } from './system.js'

const project: Project = {
  id: 'p1',
  folderId: 'f1',
  rootPath: '/books/qixia',
  name: '七霞',
  genre: '玄幻',
  totalChapters: 300,
  wordsPerChapter: 3000,
  anchorLocked: true,
  status: 'draft',
  createdAt: '2026-10-25T00:00:00.000Z',
}

const style: StyleAsset = {
  id: 's1',
  projectId: 'p1',
  name: '冷硬短句',
  description: '短句为主，少形容词，多用动作与物象承载情绪',
  samples: ['风从袖口灌进来。她按住玉牌，指节泛白。'],
  bannedWords: ['仿佛', '不禁'],
  bannedPatterns: ['不是……而是……'],
  quantLimits: { 仿佛: 0 },
  isDefault: true,
}

const hardRules: WorldRule[] = [
  {
    id: 'w1',
    projectId: 'p1',
    category: 'power',
    name: '灵潮',
    content: '每甲子涨落一次',
    priority: 'hard',
  },
  {
    id: 'w2',
    projectId: 'p1',
    category: 'geography',
    name: '剑冢不可越',
    content: '越界即削魂',
    priority: 'hard',
  },
]

describe('blockS1 角色身份与职责', () => {
  it('包含书名与题材', () => {
    const b = blockS1(project)
    expect(b.id).toBe('S1')
    expect(b.role).toBe('system')
    expect(b.priority).toBe(0)
    expect(b.content).toContain('七霞')
    expect(b.content).toContain('玄幻')
  })

  it('★ 跨章不变：不含任何章节号', () => {
    // S1-S5 必须跨章一致，否则 DeepSeek 前缀缓存失效
    expect(blockS1(project).content).not.toMatch(/第\s*\d+\s*章/)
  })
})

describe('blockS2 文风契约', () => {
  it('包含描述与样本', () => {
    const c = blockS2(style).content ?? ''
    expect(c).toContain('短句为主')
    expect(c).toContain('风从袖口灌进来')
  })

  it('无样本时不写空的示例小节', () => {
    const c = blockS2({ ...style, samples: [] }).content ?? ''
    expect(c).not.toContain('示例')
    expect(c).toContain('短句为主')
  })
})

describe('blockS3 反 AI 规则', () => {
  it('列出禁用词与量化上限', () => {
    const c = blockS3(style).content ?? ''
    expect(c).toContain('仿佛')
    expect(c).toContain('不禁')
    expect(c).toContain('不是……而是……')
    expect(c).toContain('0')
  })

  it('无禁用规则时返回 null（不产生空块）', () => {
    const empty = { ...style, bannedWords: [], bannedPatterns: [], quantLimits: {} }
    expect(blockS3(empty).content).toBeNull()
  })
})

describe('blockS4 世界 hard 规则', () => {
  it('逐条渲染', () => {
    const c = blockS4(hardRules).content ?? ''
    expect(c).toContain('灵潮')
    expect(c).toContain('剑冢不可越')
    expect(c).toContain('每甲子涨落一次')
  })

  it('无 hard 规则时返回 null', () => {
    expect(blockS4([]).content).toBeNull()
  })
})

describe('blockS5 输出格式约定', () => {
  it('★ 含场景标记约定（与 §4.6 一致）', () => {
    const c = blockS5({ wordsPerChapter: 3000 }).content ?? ''
    expect(c).toContain('===场景1===')
    expect(c).toContain('空行')
  })

  it('含目标字数', () => {
    expect(blockS5({ wordsPerChapter: 3000 }).content ?? '').toContain('3000')
  })

  it('★ 明确禁止输出 JSON', () => {
    const c = blockS5({ wordsPerChapter: 3000 }).content ?? ''
    expect(c).toContain('不要输出 JSON')
  })

  it('wordsPerChapter 为 null 时用 3000 兜底', () => {
    expect(blockS5({ wordsPerChapter: null }).content ?? '').toContain('3000')
  })
})
