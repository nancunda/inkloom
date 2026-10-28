import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { atomicWrite, readIfExists } from '../storage/atomic-write.js'
import { writeQueue } from '../storage/queue.js'
import { agentRunDir } from './book-snapshot.js'
import { messageSnapshotPath, sessionDir } from './history.js'
import type { AgentStreamEvent } from './run-service.js'

export interface AgentSessionMeta {
  id: string
  title: string
  goal: string
  status: 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped' | 'legacy'
  createdAt: string
  updatedAt: string
  tokens: number
  steps: number
  subagentCalls: number
  planId: string | null
  planTitle: string | null
  planDone: number
  planTotal: number
  runIds: string[]
  resumable: boolean
}

const SESSION_ID = /^(cs_[A-Za-z0-9]+|lg_ar_[A-Za-z0-9]+)$/
const RUN_ID = /^ar_[A-Za-z0-9]+$/
const STATUSES = new Set([
  'running',
  'waiting_review',
  'paused',
  'done',
  'failed',
  'stopped',
  'legacy',
])
/** 超过这个时长仍停在 running 的会话视为崩溃残留，允许改名/删除 */
const STALE_MS = 10 * 60 * 1000

/** ★ id 将来直接来自 URL path：不校验就能拼出 `../` 逃出书目录 */
function assertSessionId(id: string): void {
  if (!SESSION_ID.test(id)) throw new InkloomError('INVALID_INPUT', `非法会话 id：${id}`)
}

export function sessionJournalPath(root: string, id: string): string {
  assertSessionId(id)
  return join(sessionDir(root), `${id}.jsonl`)
}

export function sessionMetaPath(root: string, id: string): string {
  assertSessionId(id)
  return join(sessionDir(root), `${id}.meta.json`)
}

export function newSessionId(): string {
  return `cs_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** 按字符（不是码元）截断：直接 slice 会切断 emoji 的代理对 */
function clipChars(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

export function defaultTitle(goal: string): string {
  const one = goal.replace(/\s+/g, ' ').trim()
  return one.length === 0 ? '未命名会话' : clipChars(one, 40)
}

export function isLegacyId(id: string): boolean {
  return id.startsWith('lg_')
}

function isMeta(value: unknown): value is AgentSessionMeta {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return (
    typeof m['id'] === 'string' &&
    /^cs_[A-Za-z0-9]+$/.test(m['id']) &&
    typeof m['title'] === 'string' &&
    typeof m['goal'] === 'string' &&
    typeof m['status'] === 'string' &&
    STATUSES.has(m['status']) &&
    typeof m['createdAt'] === 'string' &&
    typeof m['updatedAt'] === 'string' &&
    typeof m['tokens'] === 'number' &&
    typeof m['steps'] === 'number' &&
    typeof m['subagentCalls'] === 'number' &&
    typeof m['planDone'] === 'number' &&
    typeof m['planTotal'] === 'number' &&
    typeof m['resumable'] === 'boolean' &&
    Array.isArray(m['runIds'])
  )
}

async function writeMetaNow(root: string, id: string, meta: AgentSessionMeta): Promise<void> {
  await mkdir(sessionDir(root), { recursive: true })
  // ★ 用入参 id 拼路径：meta.id 写错时不能把别的会话覆盖掉
  await atomicWrite(sessionMetaPath(root, id), `${JSON.stringify(meta, null, 2)}\n`)
}

export async function writeSessionMeta(root: string, meta: AgentSessionMeta): Promise<void> {
  // ★ 文件系统没有事务：run 收尾与重命名可能同时读改写同一份 meta，必须串行
  await writeQueue.run(() => writeMetaNow(root, meta.id, meta))
}

/**
 * 队列内读改写：调用方拿到的是队首那一刻的 meta，改完立刻写回。
 * ★ 用 writeSessionMeta 直接覆盖会把并发发生的改名冲掉。
 * ★ 回调返回 null = 放弃本次写入（例如续接的会话已被删掉）。
 * ⚠️ 严禁在回调里调用 writeSessionMeta / removeSession / renameSession：
 *    writeQueue 不可重入，会永久挂死。
 */
export async function updateSessionMeta(
  root: string,
  id: string,
  update: (
    prev: AgentSessionMeta | null,
  ) => AgentSessionMeta | null | Promise<AgentSessionMeta | null>,
): Promise<AgentSessionMeta | null> {
  assertSessionId(id)
  return writeQueue.run(async () => {
    const prev = await readSessionMeta(root, id)
    const next = await update(prev)
    if (next === null) return null
    await writeMetaNow(root, id, next)
    return next
  })
}

export async function readSessionMeta(root: string, id: string): Promise<AgentSessionMeta | null> {
  if (isLegacyId(id)) return null
  assertSessionId(id)
  const raw = await readIfExists(sessionMetaPath(root, id))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    // ★ 文件内 id 与文件名不一致的一律当坏数据，避免张冠李戴
    return isMeta(parsed) && parsed.id === id ? parsed : null
  } catch {
    return null
  }
}

/** 只读首行：legacy 列表不需要把 5MB 的 journal 整个读进内存 */
async function readFirstLine(file: string): Promise<string | null> {
  const handle = await open(file, 'r')
  try {
    let text = ''
    const buffer = Buffer.alloc(16 * 1024)
    // fs.read 允许短读：最多读四轮，直到遇见换行或 EOF
    for (let round = 0; round < 4; round += 1) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, text.length)
      if (bytesRead === 0) break
      text += buffer.subarray(0, bytesRead).toString('utf8')
      if (text.includes('\n')) break
    }
    const nl = text.indexOf('\n')
    return (nl >= 0 ? text.slice(0, nl) : text) || null
  } finally {
    await handle.close()
  }
}

async function legacySession(root: string, fileName: string): Promise<AgentSessionMeta | null> {
  if (!fileName.startsWith('ar_') || !fileName.endsWith('.jsonl')) return null
  const runId = fileName.slice(0, -'.jsonl'.length)
  const file = join(agentRunDir(root), fileName)
  const info = await stat(file).catch(() => null)
  if (info === null) return null
  const first = await readFirstLine(file).catch(() => null)
  let goal = runId
  // ★ birthtime 在部分 Linux 文件系统上是 0 或等于 ctime；不能直接信
  const born = info.birthtimeMs > 0 && info.birthtime <= info.mtime ? info.birthtime : info.mtime
  let createdAt = born.toISOString()
  if (first !== null) {
    try {
      const event = JSON.parse(first) as { type?: string; goal?: string; at?: string }
      if (event.type === 'run.started' && typeof event.goal === 'string') {
        goal = event.goal
        if (typeof event.at === 'string') createdAt = event.at
      }
    } catch {
      // 首行坏了就退回文件名当标题
    }
  }
  return {
    id: `lg_${runId}`,
    title: defaultTitle(goal),
    goal,
    status: 'legacy',
    createdAt,
    // ★ 用 mtime：取「前 N 条里最后一条」会把长 run 的时间截在中间，排序全错
    updatedAt: info.mtime.toISOString(),
    tokens: 0,
    steps: 0,
    subagentCalls: 0,
    planId: null,
    planTitle: null,
    planDone: 0,
    planTotal: 0,
    runIds: [runId],
    resumable: false,
  }
}

export async function readLegacySession(
  root: string,
  runId: string,
): Promise<AgentSessionMeta | null> {
  // ★ runId 也来自 URL path，同样要防 `../`
  if (!RUN_ID.test(runId)) throw new InkloomError('INVALID_INPUT', `非法 run id：${runId}`)
  return legacySession(root, `${runId}.jsonl`)
}

export async function listSessions(root: string): Promise<AgentSessionMeta[]> {
  let names: string[] = []
  try {
    names = await readdir(sessionDir(root))
  } catch {
    names = []
  }
  const own: AgentSessionMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue
    try {
      const meta = await readSessionMeta(root, name.slice(0, -'.meta.json'.length))
      if (meta !== null) own.push(meta)
    } catch {}
  }

  let runNames: string[] = []
  try {
    runNames = await readdir(agentRunDir(root))
  } catch {
    runNames = []
  }
  const legacy: AgentSessionMeta[] = []
  for (const name of runNames) {
    try {
      const meta = await legacySession(root, name)
      if (meta !== null) legacy.push(meta)
    } catch {}
  }
  return [...own, ...legacy].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readSessionEvents(
  root: string,
  id: string,
  limit: number,
): Promise<AgentStreamEvent[]> {
  assertSessionId(id)
  // ★ 回放要的是「最近 N 条」；读到的是开头，长会话就永远看不到最新对话
  const cap = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 2000
  if (cap === 0) return []
  const legacy = isLegacyId(id)
  const file = legacy
    ? join(agentRunDir(root), `${id.slice('lg_'.length)}.jsonl`)
    : sessionJournalPath(root, id)
  const raw = await readIfExists(file)
  if (raw === null) return []
  const out: AgentStreamEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const event = JSON.parse(line) as AgentStreamEvent
      // ★ legacy journal 是旧代码写的，没有 runId；前端去重需要它
      out.push(
        legacy && event.runId === undefined ? { ...event, runId: id.slice('lg_'.length) } : event,
      )
    } catch {}
  }
  return out.slice(-cap)
}

function isStale(meta: AgentSessionMeta): boolean {
  // ★ 只有 running 才是崩溃残留候选；waiting_review 本来就在等人审批，不能动
  if (meta.status !== 'running') return false
  const updated = Date.parse(meta.updatedAt)
  return Number.isNaN(updated) || Date.now() - updated > STALE_MS
}

function requireWritableMeta(meta: AgentSessionMeta | null, id: string): AgentSessionMeta {
  if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${id} 不存在`)
  // ★ 进程崩溃后 meta 会永远停在 running；不让它把会话锁死
  if ((meta.status === 'running' || meta.status === 'waiting_review') && !isStale(meta)) {
    throw new InkloomError('CONFLICT', '会话运行中，先停止再操作')
  }
  return meta
}

export async function renameSession(
  root: string,
  id: string,
  title: string,
): Promise<AgentSessionMeta> {
  if (isLegacyId(id)) throw new InkloomError('CONFLICT', '历史记录只读，不能重命名')
  const trimmed = title.trim()
  if (trimmed.length === 0) throw new InkloomError('INVALID_INPUT', '标题不能为空')
  return updateSessionMeta(root, id, (prev) => {
    const meta = requireWritableMeta(prev, id)
    return {
      ...meta,
      title: clipChars(trimmed, 80),
      status: isStale(meta) ? 'stopped' : meta.status,
      updatedAt: new Date().toISOString(),
    }
  }).then((meta) => {
    if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${id} 不存在`)
    return meta
  })
}

export async function removeSession(root: string, id: string): Promise<void> {
  if (isLegacyId(id)) throw new InkloomError('CONFLICT', '历史记录只读，不能删除')
  assertSessionId(id)
  await writeQueue.run(async () => {
    const meta = await readSessionMeta(root, id)
    if (meta !== null) requireWritableMeta(meta, id)
    await rm(sessionMetaPath(root, id), { force: true })
    await rm(sessionJournalPath(root, id), { force: true })
    await rm(messageSnapshotPath(root, id), { force: true })
  })
}
