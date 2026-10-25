import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockJudge, type JudgeProvider } from '@inkloom/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import { clearContext, setContext } from '../services/context.js'
import { createProject } from '../storage/project.js'
import { writeSceneFile } from '../storage/scenes.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { checkChapter } from './health-check.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

async function seedScene(sceneNo: number, text: string): Promise<void> {
  const { relPath } = await writeSceneFile(
    root,
    { sceneNo, version: 1, segments: [{ segId: `s${sceneNo}00`, text }] },
    4,
  )
  await db.draftSegment.create({
    data: {
      id: `seg_4_${sceneNo}_1_s${sceneNo}00`,
      projectId: pid,
      chapterNo: 4,
      sceneNo,
      segId: `s${sceneNo}00`,
      seq: 0,
      filePath: relPath,
      contentHash: 'h',
      wordCount: text.length,
      status: 'candidate',
    },
  })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-judge-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('checkChapter（可开关的判断层）', () => {
  it('★ 默认关闭：enabled=false，不产生任何判断，也不报错', async () => {
    await seedScene(1, '剑气贴着面颊削过去。')
    const r = await checkChapter({ chapterNo: 4, provider: null })
    expect(r.enabled).toBe(false)
    expect(r.provider).toBeNull()
    expect(r.findings).toEqual([])
  })

  it('★ 打开后每个场景三类判断：反 AI 味 / 节奏 / 一致性', async () => {
    await seedScene(1, '剑气贴着面颊削过去。')
    await seedScene(2, '碑上的名字是她自己。')
    const { provider } = createMockJudge((req) => ({
      value: req.primitive === 'noul' ? false : 2,
      confidence: 0.9,
    }))
    const r = await checkChapter({ chapterNo: 4, provider })
    expect(r.enabled).toBe(true)
    expect(r.findings).toHaveLength(6) // 2 场景 × 3 问
    expect(r.findings.map((f) => f.kind)).toEqual([
      'slop',
      'pace',
      'consistency',
      'slop',
      'pace',
      'consistency',
    ])
    expect(r.findings.every((f) => f.injectable)).toBe(true)
  })

  it('★ 置信度 < 0.75 的结论标为不可注入（ADR-29）', async () => {
    await seedScene(1, '剑气贴着面颊削过去。')
    const { provider } = createMockJudge(() => ({ value: 4, confidence: 0.6 }))
    const r = await checkChapter({ chapterNo: 4, provider })
    expect(r.findings.every((f) => f.injectable === false)).toBe(true)
  })

  it('★ 判断层不可用时降级：degraded 有说明，不抛错', async () => {
    await seedScene(1, '剑气贴着面颊削过去。')
    const broken: JudgeProvider = {
      id: 'broken',
      judge: async () => {
        throw new Error('judge_unavailable')
      },
    }
    const r = await checkChapter({ chapterNo: 4, provider: broken })
    expect(r.degraded).toContain('judge_unavailable')
    expect(r.findings).toEqual([])
  })

  it('没有场景时返回空报告（不是错误）', async () => {
    const { provider } = createMockJudge(() => ({ value: 1, confidence: 1 }))
    const r = await checkChapter({ chapterNo: 99, provider })
    expect(r.findings).toEqual([])
    expect(r.degraded).toBeNull()
  })

  it('不修改任何文件（只读体检）', async () => {
    await seedScene(1, '剑气贴着面颊削过去。')
    const { provider } = createMockJudge(() => ({ value: 2, confidence: 0.9 }))
    await checkChapter({ chapterNo: 4, provider })
    // 索引里的段状态保持 candidate，没有被体检改写
    const segs = await db.draftSegment.findMany({ where: { chapterNo: 4 } })
    expect(segs.every((s) => s.status === 'candidate')).toBe(true)
  })
})
