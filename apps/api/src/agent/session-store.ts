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

function isLegacyId(id: string): boolean {
  return id.startsWith('lg_')
}

function isMeta(value: unknown): value is AgentSessionMeta {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return (
    typeof m['id'] === 'string' &&
    typeof m['title'] === 'string' &&
    typeof m['goal'] === 'string' &&
    typeof m['status'] === 'string' &&
    typeof m['updatedAt'] === 'string' &&
    Array.isArray(m['runIds'])
  )
}

async function writeMetaNow(root: string, meta: AgentSessionMeta): Promise<void> {
  await mkdir(sessionDir(root), { recursive: true })
  await atomicWrite(sessionMetaPath(root, meta.id), `${JSON.stringify(meta, null, 2)}\n`)
}

export async function writeSessionMeta(root: string, meta: AgentSessionMeta): Promise<void> {
  // ★ 文件系统没有事务：run 收尾与重命名可能同时读改写同一份 meta，必须串行
  await writeQueue.run(() => writeMetaNow(root, meta))
}

export async function readSessionMeta(root: string, id: string): Promise<AgentSessionMeta | null> {
  if (isLegacyId(id)) return null
  assertSessionId(id)
  const raw = await readIfExists(sessionMetaPath(root, id))
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isMeta(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 只读首行：legacy 列表不需要把 5MB 的 journal 整个读进内存 */
async function readFirstLine(file: string): Promise<string | null> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(16 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    if (nl >= 0) return text.slice(0, nl)
    return bytesRead < buffer.length ? text : null
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
  let createdAt = info.birthtime.toISOString()
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
  const file = isLegacyId(id)
    ? join(agentRunDir(root), `${id.slice('lg_'.length)}.jsonl`)
    : sessionJournalPath(root, id)
  const raw = await readIfExists(file)
  if (raw === null) return []
  const out: AgentStreamEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as AgentStreamEvent)
    } catch {}
  }
  return out.slice(-cap)
}

function isStale(meta: AgentSessionMeta): boolean {
  if (meta.status !== 'running' && meta.status !== 'waiting_review') return false
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
  return writeQueue.run(async () => {
    const meta = requireWritableMeta(await readSessionMeta(root, id), id)
    const next: AgentSessionMeta = {
      ...meta,
      title: clipChars(trimmed, 80),
      status: isStale(meta) ? 'stopped' : meta.status,
      updatedAt: new Date().toISOString(),
    }
    await writeMetaNow(root, next)
    return next
  })
}

export async function removeSession(root: string, id: string): Promise<void> {
  if (isLegacyId(id)) throw new InkloomError('CONFLICT', '历史记录只读，不能删除')
  assertSessionId(id)
  const meta = await readSessionMeta(root, id)
  if (meta !== null) requireWritableMeta(meta, id)
  await rm(sessionMetaPath(root, id), { force: true })
  await rm(sessionJournalPath(root, id), { force: true })
  await rm(messageSnapshotPath(root, id), { force: true })
}
