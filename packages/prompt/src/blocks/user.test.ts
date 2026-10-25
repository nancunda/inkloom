import type {
  Blueprint,
  Character,
  CharacterRelation,
  CharacterSignature,
  Location,
  PlotThread,
  Project,
  Route,
  WorldRule,
} from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import type { ChapterContextInput } from './user.js'
import {
  blockU1,
  blockU2,
  blockU3,
  blockU4,
  blockU5,
  blockU6,
  blockU7,
  blockU8,
  blockU9,
} from './user.js'

const project: Project = {
  id: 'p1',
  folderId: 'f1',
  rootPath: '/b',
  name: '七霞',
  genre: '玄幻',
  coreIdea: '剑冢里的名字',
  premise: '守碑人的养女寻找自己的姓',
  theme: '名字与身份',
  toneContract: '冷峻、克制、少抒情',
  anchorLocked: true,
  status: 'draft',
  createdAt: '2026-10-25T00:00:00.000Z',
}

const blueprint: Blueprint = {
  id: 'b4',
  projectId: 'p1',
  chapterNo: 4,
  title: '第四章 剑冢',
  goal: '走到碑前',
  conflict: '裴无咎阻拦',
  turn: '裴无咎也在找这个名字',
  hook: '碑上的名字是她自己',
  castIds: ['c1', 'c4'],
  locationId: 'l2',
  beatType: 'climax',
  tensionLevel: 5,
}

const cast: Character[] = [
  {
    id: 'c1',
    projectId: 'p1',
    name: '林岚',
    role: 'protagonist',
    appearance: '青灰道袍，眉间一点朱砂，左眉一道旧疤',
    personality: '执拗、认死理',
    motivation: '找到碑上的名字',
    curPhysical: '左臂受伤',
    curTierId: 't2',
    stateChapter: 3,
    stateStale: false,
    visualAnchor: '红衣女子，左眉一道旧疤，佩剑系在右腰',
  },
  {
    id: 'c4',
    projectId: 'p1',
    name: '裴无咎',
    role: 'antagonist',
    personality: '温文尔雅，杀人时也笑着说抱歉',
    stateStale: false,
  },
]

const relations: CharacterRelation[] = [
  {
    id: 'r1',
    projectId: 'p1',
    fromId: 'c4',
    toId: 'c1',
    kind: 'enemy',
    strength: 3,
    sinceChapter: 4,
  },
]
const tiers = [
  { characterId: 'c1', tierName: '筑基', level: 2 },
  { characterId: 'c4', tierName: '金丹', level: 3 },
]
const location: Location = { id: 'l2', projectId: 'p1', name: '剑冢', type: 'ruin', region: '东境' }
const routes: Route[] = [
  {
    id: 'r1',
    projectId: 'p1',
    fromId: 'l1',
    toId: 'l2',
    mode: 'walk',
    days: 3,
    bidirectional: true,
  },
]
const softRules: WorldRule[] = [
  {
    id: 'w4',
    projectId: 'p1',
    category: 'faction',
    name: '天枢阁',
    content: '最强的那人才配姓裴',
    priority: 'soft',
  },
]
const timeline: Blueprint[] = [1, 2, 3, 4, 5].map((n) => ({
  id: `b${n}`,
  projectId: 'p1',
  chapterNo: n,
  goal: `目标${n}`,
  conflict: `冲突${n}`,
  hook: `钩子${n}`,
  castIds: [],
  beatType: 'rising',
  tensionLevel: 3,
}))
const upcoming: Blueprint[] = timeline.slice(4)
const unresolved: PlotThread[] = [
  {
    id: 't1',
    projectId: 'p1',
    kind: 'foreshadow',
    title: '碑上的名字',
    plantedChapter: 1,
    advancedChapters: [2],
    status: 'active',
    payoffHint: '读出自己的名字',
    payoffWindow: 30,
  },
]
const summaries = [
  { chapterNo: 2, summary: '老仆露出同样的疤' },
  { chapterNo: 3, summary: '剑气削面，碑上浮字' },
]
const signatures: CharacterSignature[] = [
  {
    id: 'sig1',
    projectId: 'p1',
    characterId: 'c1',
    kind: 'signature_action',
    content: '按住腰间玉牌，指节泛白',
    trigger: 'anger',
    frequency: 'key_moment',
    isActive: true,
  },
]

const input: ChapterContextInput = {
  project,
  blueprint,
  cast,
  relations,
  tiers,
  location,
  routes,
  hardRules: [],
  softRules,
  timeline,
  upcoming,
  unresolved,
  summaries,
  previousEnding: '剑气贴着面颊削过去。',
  signatures,
  userGuidance: null,
}

describe('blockU1 本章场地设定', () => {
  it('含角色静态设定与当前状态', () => {
    const c = blockU1(input).content ?? ''
    expect(c).toContain('林岚')
    expect(c).toContain('执拗')
    expect(c).toContain('左臂受伤')
  })

  it('★ 含 visualAnchor（防止写错外貌）', () => {
    expect(blockU1(input).content ?? '').toContain('左眉一道旧疤')
  })

  it('含 tier 名字与 level（可比较）', () => {
    const c = blockU1(input).content ?? ''
    expect(c).toContain('筑基')
    expect(c).toContain('金丹')
  })

  it('含关系', () => {
    expect(blockU1(input).content ?? '').toContain('enemy')
  })

  it('含地点', () => {
    expect(blockU1(input).content ?? '').toContain('剑冢')
  })

  it('未指定地点时不报错', () => {
    expect(() => blockU1({ ...input, location: null })).not.toThrow()
  })
})

describe('blockU2 全书进度', () => {
  it('★ 只列到本章为止（不泄露后续剧情）', () => {
    const c = blockU2(input).content ?? ''
    expect(c).toContain('目标3')
    expect(c).toContain('目标4')
    expect(c).not.toContain('目标5')
  })
})

describe('blockU3 未兑现清单', () => {
  it('列出活跃线索与埋设章', () => {
    const c = blockU3(input).content ?? ''
    expect(c).toContain('碑上的名字')
    expect(c).toContain('1')
  })

  it('空清单返回 null', () => {
    expect(blockU3({ ...input, unresolved: [] }).content).toBeNull()
  })
})

describe('blockU4 近期摘要', () => {
  it('按章号升序', () => {
    const c = blockU4(input).content ?? ''
    expect(c.indexOf('老仆露出')).toBeLessThan(c.indexOf('剑气削面'))
  })

  it('空摘要返回 null', () => {
    expect(blockU4({ ...input, summaries: [] }).content).toBeNull()
  })
})

describe('blockU5 上章结尾', () => {
  it('含正文', () => {
    expect(blockU5(input).content ?? '').toContain('剑气贴着面颊')
  })

  it('★ 超过 800 字时截断（保留尾部，因为要接续）', () => {
    const long = `${'䕀'.repeat(1000)}结尾在这里`
    const c = blockU5({ ...input, previousEnding: long }).content ?? ''
    expect(c).toContain('结尾在这里')
    expect(c.length).toBeLessThan(1000)
  })

  it('无上章返回 null', () => {
    expect(blockU5({ ...input, previousEnding: null }).content).toBeNull()
  })
})

describe('blockU6 本章蓝图', () => {
  it('含 goal / conflict / turn / hook', () => {
    const c = blockU6(input).content ?? ''
    expect(c).toContain('走到碑前')
    expect(c).toContain('裴无咎阻拦')
    expect(c).toContain('裴无咎也在找这个名字')
    expect(c).toContain('碑上的名字是她自己')
  })

  it('★ 不含 castIds 的原始 JSON 数组', () => {
    const c = blockU6(input).content ?? ''
    expect(c).not.toContain('["c1","c4"]')
  })

  it('含 tensionLevel 与 beatType', () => {
    const c = blockU6(input).content ?? ''
    expect(c).toContain('5')
    expect(c).toContain('climax')
  })
})

describe('blockU7 后续蓝图', () => {
  it('★ 明确标注"禁止提前写"', () => {
    expect(blockU7(input).content ?? '').toContain('不要提前写')
  })

  it('无后续返回 null', () => {
    expect(blockU7({ ...input, upcoming: [] }).content).toBeNull()
  })
})

describe('blockU8 作者指导', () => {
  it('含指导文本', () => {
    const c = blockU8({ ...input, userGuidance: '这一章让林岚少说话' }).content ?? ''
    expect(c).toContain('少说话')
  })

  it('无指导返回 null', () => {
    expect(blockU8(input).content).toBeNull()
  })
})

describe('blockU9 锚点（不可偏离的作者事实）', () => {
  it('★ 含四个锚点字段', () => {
    const c = blockU9(input).content ?? ''
    expect(c).toContain('剑冢里的名字')
    expect(c).toContain('守碑人的养女')
    expect(c).toContain('名字与身份')
    expect(c).toContain('冷峻、克制、少抒情')
  })

  it('★ 用强约束措辞（这是最后一道防线）', () => {
    const c = blockU9(input).content ?? ''
    expect(c).toContain('不可偏离')
  })

  it('锚点全空时返回 null', () => {
    const empty = {
      ...input,
      project: {
        ...project,
        coreIdea: undefined,
        premise: undefined,
        theme: undefined,
        toneContract: undefined,
      },
    }
    expect(blockU9(empty).content).toBeNull()
  })
})

describe('块的元数据', () => {
  it('★ U 段全部是 user role（system 只放跨章不变的 S1-S5）', () => {
    for (const fn of [
      blockU1,
      blockU2,
      blockU3,
      blockU4,
      blockU5,
      blockU6,
      blockU7,
      blockU8,
      blockU9,
    ]) {
      expect(fn(input).role).toBe('user')
    }
  })

  it('优先级符合 spec §4.3（U9 锚点 P0，U2 进度 P7）', () => {
    expect(blockU9(input).priority).toBe(0)
    expect(blockU6(input).priority).toBe(0)
    expect(blockU1(input).priority).toBe(1)
    expect(blockU4(input).priority).toBe(2)
    expect(blockU3(input).priority).toBe(3)
    expect(blockU7(input).priority).toBe(6)
    expect(blockU2(input).priority).toBe(7)
  })
})
