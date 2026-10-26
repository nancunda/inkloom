import { randomUUID } from 'node:crypto'
import type { FetchLike } from '../llm/types.js'
import { getContext, peekContext } from './context.js'
import { type GenerateChapterResult, generateChapter } from './generate-service.js'

export interface JobSnapshot {
  id: string
  kind: 'generate'
  /** 归属：任务列表不能跨书显示 */
  root: string
  status: 'running' | 'done' | 'failed'
  chapterNo: number
  startedAt: string
  finishedAt: string | null
  result: GenerateChapterResult | null
  error: string | null
}

/**
 * 生成任务表（单进程内存）。
 *
 * ★ 为什么需要它：生成一次要 40–90 秒，同步 HTTP 会让浏览器干等、
 *   代理层也可能先超时。改成「提交任务 + 轮询」，界面能先拿到 runId。
 * ★ 任务表不落盘：服务重启后未完成任务丢失，查询会返回 404 并说明原因。
 *   把它当「一次会话内的进度」而不是持久记录——生成结果本身早已落进
 *   generation_run 与场景文件，重试成本远低于为它加一张表。
 */
const jobs = new Map<string, JobSnapshot>()

export interface SubmitGenerateOptions {
  chapterNo: number
  apiKey: string
  guidance?: string
  model?: string
  fetchImpl?: FetchLike
}

export function submitGenerate(opts: SubmitGenerateOptions): string {
  const id = randomUUID()
  const { root } = getContext()
  const snap: JobSnapshot = {
    id,
    kind: 'generate',
    root,
    status: 'running',
    chapterNo: opts.chapterNo,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  }
  jobs.set(id, snap)

  // 不 await：请求立刻返回 jobId，任务在后台跑
  void generateChapter({
    chapterNo: opts.chapterNo,
    apiKey: opts.apiKey,
    ...(opts.guidance === undefined ? {} : { userGuidance: opts.guidance }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  })
    .then((result) => {
      snap.status = 'done'
      snap.result = result
      snap.finishedAt = new Date().toISOString()
    })
    .catch((e: unknown) => {
      snap.status = 'failed'
      snap.error = e instanceof Error ? e.message : String(e)
      snap.finishedAt = new Date().toISOString()
    })

  return id
}

export function getJob(id: string): JobSnapshot | undefined {
  const job = jobs.get(id)
  if (job === undefined) return undefined
  return job.root === peekContext()?.root ? job : undefined
}

/** 最近的任务（新→旧）；任务中心用它渲染列表 */
export function listJobs(limit = 20): JobSnapshot[] {
  const root = peekContext()?.root
  return [...jobs.values()]
    .filter((j) => j.root === root)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, limit)
}

/** 切书前检查：还有 running 的生成任务时不允许切 */
export function runningJobCount(): number {
  let n = 0
  for (const j of jobs.values()) if (j.status === 'running') n += 1
  return n
}

/** 测试用：避免用例之间互相污染 */
export function clearJobs(): void {
  jobs.clear()
}
