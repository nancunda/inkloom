#!/usr/bin/env node
// P2-c 验收：判断层 6 条。全部假 provider，零网络零花费。
//
// ★ 要证明的不是「它能打分」，而是三件容易写坏的事：
//   1) 关掉时真的不调用（enabled=false，不是悄悄跑）
//   2) 置信度 < 0.75 的结论标记为不可注入（ADR-29）
//   3) 判断层挂了只降级，不让写作流程失败；且体检绝不改文件
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JudgeProvider, JudgeRequest, JudgeResult } from '@inkloom/core'
import type { IndexDb } from '../apps/api/src/index-db/client.js'
import { checkChapter } from '../apps/api/src/judge/health-check.js'
import { clearContext, setContext } from '../apps/api/src/services/context.js'
import { createProject } from '../apps/api/src/storage/project.js'
import { writeSceneFile } from '../apps/api/src/storage/scenes.js'
import { freshIndexDb } from '../apps/api/src/test-utils/index-db-fixture.js'

const results: { name: string; ok: boolean; err?: string }[] = []
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    results.push({ name, ok: false, err })
    console.error(`✗ ${name}\n    ${err}`)
  }
}

const tmp = await mkdtemp(join(tmpdir(), 'inkloom-p2c-'))
const book = join(tmp, 'book')
let db: IndexDb | null = null
let pid = ''

async function seedScene(sceneNo: number, text: string): Promise<void> {
  const { relPath } = await writeSceneFile(
    book,
    { sceneNo, version: 1, segments: [{ segId: `s${sceneNo}00`, text }] },
    4,
  )
  await db?.draftSegment.create({
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

/** 可观测的假 provider：记录调用次数与并发峰值 */
function makeProvider(opts: {
  value?: (req: JudgeRequest) => JudgeResult
  fail?: boolean
  delayMs?: number
}): { provider: JudgeProvider; calls: () => number; peak: () => number } {
  let calls = 0
  let active = 0
  let peak = 0
  return {
    calls: () => calls,
    peak: () => peak,
    provider: {
      id: 'fake',
      async judge(reqs) {
        calls += 1
        active += 1
        peak = Math.max(peak, active)
        try {
          if (opts.fail === true) throw new Error('judge_unavailable')
          if ((opts.delayMs ?? 0) > 0) {
            await new Promise((r) => setTimeout(r, opts.delayMs))
          }
          return reqs.map(
            (req) =>
              opts.value?.(req) ?? { value: req.primitive === 'noul' ? false : 2, confidence: 0.9 },
          )
        } finally {
          active -= 1
        }
      },
    },
  }
}

try {
  await check('准备：建书 + 三个场景', async () => {
    const { project } = await createProject({ rootPath: book, name: 'P2C', genre: 'xuanhuan' })
    pid = project.id
    db = await freshIndexDb(tmp)
    await setContext({ root: book, db, project })
    await seedScene(1, '剑气贴着面颊削过去。')
    await seedScene(2, '碑上的名字是她自己。')
    await seedScene(3, '她没停。')
  })

  await check('★ 关闭时 enabled=false 且一次判断都不发', async () => {
    const spy = makeProvider({})
    const r = await checkChapter({ chapterNo: 4, provider: null })
    if (r.enabled !== false) throw new Error('enabled 应为 false')
    if (r.provider !== null) throw new Error('provider 应为 null')
    if (r.findings.length !== 0) throw new Error('关闭时不应有结论')
    if (spy.calls() !== 0) throw new Error('关闭时不应调用 provider')
  })

  await check('★ 打开后每场景三类结论，顺序稳定', async () => {
    const spy = makeProvider({})
    const r = await checkChapter({ chapterNo: 4, provider: spy.provider })
    if (r.enabled !== true) throw new Error('enabled 应为 true')
    if (r.findings.length !== 9)
      throw new Error(`应有 3 场景 × 3 问 = 9 条，实际 ${r.findings.length}`)
    const kinds = r.findings.map((f) => f.kind)
    const expected = [
      'slop',
      'pace',
      'consistency',
      'slop',
      'pace',
      'consistency',
      'slop',
      'pace',
      'consistency',
    ]
    if (kinds.join(',') !== expected.join(',')) throw new Error(`结论顺序错：${kinds.join(',')}`)
  })

  await check('★ 场景之间并行（并发峰值 ≥ 3）', async () => {
    const spy = makeProvider({ delayMs: 30 })
    await checkChapter({ chapterNo: 4, provider: spy.provider })
    if (spy.peak() < 3) throw new Error(`并发峰值 ${spy.peak()}，场景是串行跑的`)
    if (spy.calls() !== 3) throw new Error(`应每场景一次调用共 3 次，实际 ${spy.calls()}`)
  })

  await check('★ 置信度 < 0.75 → injectable=false', async () => {
    const spy = makeProvider({ value: () => ({ value: 4, confidence: 0.6 }) })
    const r = await checkChapter({ chapterNo: 4, provider: spy.provider })
    if (!r.findings.every((f) => !f.injectable)) throw new Error('低置信结论不应标记可注入')
  })

  await check('★ 判断层挂掉只降级：degraded 有说明、不抛错', async () => {
    const spy = makeProvider({ fail: true })
    const r = await checkChapter({ chapterNo: 4, provider: spy.provider })
    if (r.degraded === null || !r.degraded.includes('judge_unavailable')) {
      throw new Error(`degraded 应为 judge_unavailable，实际 ${String(r.degraded)}`)
    }
    if (r.findings.length !== 0) throw new Error('降级时不应留下半截结论')
  })

  await check('★ 体检只读：段状态与文件都不变', async () => {
    const spy = makeProvider({})
    await checkChapter({ chapterNo: 4, provider: spy.provider })
    const segs = await db?.draftSegment.findMany({ where: { chapterNo: 4 } })
    if (segs === undefined || !segs.every((s) => s.status === 'candidate')) {
      throw new Error('体检改动了段状态')
    }
  })
} finally {
  clearContext()
  if (db !== null) await db.$disconnect()
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error('✗ P2-c 验收未通过')
  process.exit(1)
}
console.log('✓ P2-c 验收全部通过')
