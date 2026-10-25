import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import { mergeChapter } from '../storage/chapters.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { loadChapterContext } from './context-loader.js'

let base: string
let root: string
let db: IndexDb
let projectId = ''

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-ctx-'))
  root = join(base, 'qixia')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  projectId = project.id
  await setContext({ root, db, project })

  await writeJsonElement(root, 'characters/index.json', [
    {
      id: 'c1',
      projectId,
      name: '林岚',
      role: 'protagonist',
      personality: '执拗',
      visualAnchor: '左眉一道旧疤',
    },
    { id: 'c9', projectId, name: '路人', role: 'minor' },
  ])
  await writeJsonElement(root, 'characters/signatures.json', [
    {
      id: 'sig1',
      projectId,
      characterId: 'c1',
      kind: 'catchphrase',
      content: '我不信命',
      trigger: 'anger',
      frequency: 'key_moment',
      isActive: true,
    },
  ])
  await writeJsonElement(root, 'world/rules.json', [
    {
      id: 'w1',
      projectId,
      category: 'power',
      name: '灵潮',
      content: '每甲子一次',
      priority: 'hard',
    },
    {
      id: 'w2',
      projectId,
      category: 'faction',
      name: '天枢阁',
      content: '最强才姓裴',
      priority: 'soft',
    },
  ])
  await writeJsonElement(root, 'story/blueprints/ch-003.json', {
    id: 'b3',
    projectId,
    chapterNo: 3,
    goal: '越过边界',
    conflict: '剑气',
    hook: '碑上浮字',
    castIds: ['c1'],
    beatType: 'rising',
    tensionLevel: 4,
  })
  await writeJsonElement(root, 'story/blueprints/ch-004.json', {
    id: 'b4',
    projectId,
    chapterNo: 4,
    goal: '走到碑前',
    conflict: '裴无咎阻拦',
    hook: '名字是她自己',
    castIds: ['c1'],
    beatType: 'climax',
    tensionLevel: 5,
  })
  await writeJsonElement(root, 'story/blueprints/ch-005.json', {
    id: 'b5',
    projectId,
    chapterNo: 5,
    goal: '决定是否读名',
    conflict: '召残念',
    hook: '她开口了',
    castIds: ['c1'],
    beatType: 'twist',
    tensionLevel: 5,
  })
  await writeJsonElement(root, 'story/threads.json', [
    {
      id: 't1',
      projectId,
      kind: 'foreshadow',
      title: '碑上的名字',
      plantedChapter: 1,
      advancedChapters: [],
      status: 'active',
      payoffWindow: 30,
    },
    {
      id: 't2',
      projectId,
      kind: 'setup',
      title: '已回收的',
      plantedChapter: 1,
      advancedChapters: [],
      status: 'resolved',
    },
  ])
  await mkdir(join(root, 'chapters'), { recursive: true })
  await mergeChapter(root, {
    chapterNo: 3,
    title: '第三章 剑气',
    scenes: [{ sceneNo: 1, text: '剑气贴着面颊削过去。碑上浮出一个字。' }],
  })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true })
})

describe('loadChapterContext', () => {
  it('★ 只装载 castIds 里的角色（不装全部）', async () => {
    const { input } = await loadChapterContext(4)
    expect(input.cast.map((c) => c.id)).toEqual(['c1'])
    expect(input.cast.some((c) => c.id === 'c9')).toBe(false)
  })

  it('★ hard 与 soft 规则分开装载', async () => {
    const { input } = await loadChapterContext(4)
    expect(input.hardRules.map((r) => r.id)).toEqual(['w1'])
    expect(input.softRules.map((r) => r.id)).toEqual(['w2'])
  })

  it('★ timeline 只到本章为止，upcoming 是后续', async () => {
    const { input } = await loadChapterContext(4)
    expect(input.timeline.map((b) => b.chapterNo)).toEqual([3, 4])
    expect(input.upcoming.map((b) => b.chapterNo)).toEqual([5])
  })

  it('★ unresolved 只含 active 的线索', async () => {
    const { input } = await loadChapterContext(4)
    expect(input.unresolved.map((t) => t.id)).toEqual(['t1'])
  })

  it('★ 上章结尾来自定稿文件', async () => {
    const { input, hasPreviousChapter } = await loadChapterContext(4)
    expect(hasPreviousChapter).toBe(true)
    expect(input.previousEnding).toContain('碑上浮出一个字')
  })

  it('第 1 章时没有上章', async () => {
    const { input, hasPreviousChapter } = await loadChapterContext(3)
    expect(hasPreviousChapter).toBe(false)
    expect(input.previousEnding).toBeNull()
    void input
  })

  it('★ 签名只取出场角色的', async () => {
    const { input } = await loadChapterContext(4)
    expect(input.signatures.map((s) => s.id)).toEqual(['sig1'])
  })

  it('★ 文风取 isDefault 的那套', async () => {
    const { input } = await loadChapterContext(3)
    expect(input.style.isDefault).toBe(true)
  })

  it('★ 蓝图不存在 → NOT_FOUND（必须先建蓝图）', async () => {
    await expect(loadChapterContext(99)).rejects.toBeInstanceOf(InkloomError)
  })

  it('★ 角色状态按章推导（stateChapter <= 4 生效）', async () => {
    await writeJsonElement(root, 'characters/index.json', [
      {
        id: 'c1',
        projectId,
        name: '林岚',
        role: 'protagonist',
        curPhysical: '健康',
        stateChapter: 1,
      },
    ])
    const { input } = await loadChapterContext(4)
    expect(input.cast[0]?.curPhysical).toBe('健康')
  })
})
