import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { atomicWrite, readIfExists } from '../storage/atomic-write.js'
import { agentRunDir } from './book-snapshot.js'
import { sessionDir } from './history.js'
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

export function defaultTitle(goal: string): string {
  const one = goal.replace(/\s+/g, ' ').trim()
  if (one.length === 0) return '未命名会话'
  return one.length <= 40 ? one : `${one.slice(0, 40)}…`
}

function isLegacyId(id: string): boolean {
  return id.startsWith('lg_')
}

export async function writeSessionMeta(root: string, meta: AgentSessionMeta): Promise<void> {
  await mkdir(sessionDir(root), { recursive: true })
  await atomicWrite(sessionMetaPath(root, meta.id), `${JSON.stringify(meta, null, 2)}\n`)
}

export async function readSessionMeta(root: string, id: string): Promise<AgentSessionMeta | null> {
  if (isLegacyId(id)) return null
  assertSessionId(id)
  const raw = await readIfExists(sessionMetaPath(root, id))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as AgentSessionMeta
  } catch {
    return null
  }
}

async function readEventsFrom(file: string, limit: number): Promise<AgentStreamEvent[]> {
  const raw = await readIfExists(file)
  if (raw === null) return []
  const out: AgentStreamEvent[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      out.push(JSON.parse(line) as AgentStreamEvent)
    } catch {
      // 坏行跳过：journal 是追加写的，崩溃时会留半行
      continue
    }
    if (out.length >= limit) break
  }
  return out
}

/** 旧 journal 补录成只读会话：不搬文件、不改内容，只是让它出现在列表里 */
async function legacySessions(root: string): Promise<AgentSessionMeta[]> {
  const dir = agentRunDir(root)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: AgentSessionMeta[] = []
  for (const name of names) {
    if (!name.startsWith('ar_') || !name.endsWith('.jsonl')) continue
    const runId = name.slice(0, -'.jsonl'.length)
    const events = await readEventsFrom(join(dir, name), 200)
    const started = events.find((e) => e.type === 'run.started')
    const goal = started !== undefined && 'goal' in started ? String(started.goal) : runId
    const last = events.at(-1)
    const at = started?.at ?? new Date().toISOString()
    out.push({
      id: `lg_${runId}`,
      title: defaultTitle(goal),
      goal,
      status: 'legacy',
      createdAt: at,
      updatedAt: last?.at ?? at,
      tokens: 0,
      steps: 0,
      subagentCalls: 0,
      planId: null,
      planTitle: null,
      planDone: 0,
      planTotal: 0,
      runIds: [runId],
      resumable: false,
    })
  }
  return out
}

export async function listSessions(root: string): Promise<AgentSessionMeta[]> {
  const dir = sessionDir(root)
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    names = []
  }
  const own: AgentSessionMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue
    const meta = await readSessionMeta(root, name.slice(0, -'.meta.json'.length))
    if (meta !== null) own.push(meta)
  }
  const legacy = await legacySessions(root)
  return [...own, ...legacy].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function readSessionEvents(
  root: string,
  id: string,
  limit: number,
): Promise<AgentStreamEvent[]> {
  assertSessionId(id)
  const file = isLegacyId(id)
    ? join(agentRunDir(root), `${id.slice('lg_'.length)}.jsonl`)
    : sessionJournalPath(root, id)
  return readEventsFrom(file, limit)
}

function requireWritableMeta(meta: AgentSessionMeta | null, id: string): AgentSessionMeta {
  if (meta === null) throw new InkloomError('NOT_FOUND', `会话 ${id} 不存在`)
  if (meta.status === 'running' || meta.status === 'waiting_review') {
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
  const meta = requireWritableMeta(await readSessionMeta(root, id), id)
  const trimmed = title.trim()
  if (trimmed.length === 0) throw new InkloomError('INVALID_INPUT', '标题不能为空')
  const next = { ...meta, title: trimmed.slice(0, 80), updatedAt: new Date().toISOString() }
  await writeSessionMeta(root, next)
  return next
}

export async function removeSession(root: string, id: string): Promise<void> {
  if (isLegacyId(id)) throw new InkloomError('CONFLICT', '历史记录只读，不能删除')
  requireWritableMeta(await readSessionMeta(root, id), id)
  await rm(sessionMetaPath(root, id), { force: true })
  await rm(sessionJournalPath(root, id), { force: true })
  await rm(join(sessionDir(root), `${id}.messages.json`), { force: true })
}
