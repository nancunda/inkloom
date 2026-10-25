import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IndexDb } from '../index-db/client.js'
import type { FetchLike } from '../llm/types.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { clearJobs, getJob, submitGenerate } from './job-service.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

const TWO_SCENES = `===场景1===
剑气贴着面颊削过去。林岚左臂裂开一道口子。

===场景2===
碑上刻着她自己的名字。`

const okLlm: FetchLike = async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: TWO_SCENES }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 800, completion_tokens: 2000 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

/** 轮询直到任务结束（最多 10 秒，测试里够用） */
async function waitJob(id: string): Promise<NonNullable<ReturnType<typeof getJob>>> {
  for (let i = 0; i < 100; i += 1) {
    const job = getJob(id)
    if (job !== undefined && job.status !== 'running') return job
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('任务 10 秒内未结束')
}

beforeEach(async () => {
  clearJobs()
  base = await mkdtemp(join(tmpdir(), 'inkloom-job-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  await writeJsonElement(root, 'story/blueprints/ch-004.json', {
    id: 'b4',
    projectId: pid,
    chapterNo: 4,
    title: '第四章 剑冢',
    goal: '走到碑前',
    conflict: '裴无咎阻拦',
    hook: '碑上的名字是她自己',
    castIds: [],
    beatType: 'climax',
    tensionLevel: 5,
  })
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('job-service（异步生成）', () => {
  it('★ 提交立即返回 jobId，任务先在 running，完成后 status=done 且结果完整', async () => {
    const id = submitGenerate({ chapterNo: 4, apiKey: 'sk-test', fetchImpl: okLlm })
    expect(typeof id).toBe('string')

    const first = getJob(id)
    expect(first?.status).toBe('running')

    const done = await waitJob(id)
    expect(done.status).toBe('done')
    expect(done.result?.scenes.length).toBe(2)
    expect(done.error).toBeNull()
    expect(done.finishedAt).not.toBeNull()
  })

  it('★ 生成产物已落盘（后台任务真的写完了，不只是状态变了）', async () => {
    const id = submitGenerate({ chapterNo: 4, apiKey: 'sk-test', fetchImpl: okLlm })
    await waitJob(id)
    const files = await readdir(join(root, 'chapters', 'ch-004', 'scenes'))
    expect(files.length).toBeGreaterThanOrEqual(2)
  })

  it('★ 失败时 status=failed 且 error 有说明（不吞异常）', async () => {
    const failing: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    const id = submitGenerate({ chapterNo: 4, apiKey: 'sk-test', fetchImpl: failing })
    const done = await waitJob(id)
    expect(done.status).toBe('failed')
    expect(done.error).toBeTruthy()
    expect(done.result).toBeNull()
  })

  it('查询不存在的任务返回 undefined（HTTP 层转 404）', () => {
    expect(getJob('nope')).toBeUndefined()
  })
})
