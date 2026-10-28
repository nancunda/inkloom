import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { atomicWrite, readIfExists } from '../storage/atomic-write.js'
import { bookPaths } from '../storage/paths.js'

export interface MessageSnapshot {
  version: 1
  savedAt: string
  sessionId: string
  runId: string
  messages: AgentMessage[]
}

const DEFAULT_BUDGET = 120_000
const DEFAULT_RECENT = 8
const TOOL_CLIP = 500
const ASSISTANT_CLIP = 800

/** 会话的落盘目录：`.inkloom/agent/sessions/` */
export function sessionDir(root: string): string {
  return join(bookPaths(root).inkloom, 'agent', 'sessions')
}

export function messageSnapshotPath(root: string, sessionId: string): string {
  return join(sessionDir(root), `${sessionId}.messages.json`)
}

/** ★ 首条 system 带着工具声明；工具集会随代码/开关变化，恢复时必须用当前 prompt 重建 */
export function stripSystemMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => (m as { role?: string }).role !== 'system')
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const part of content) {
    const text = (part as { text?: string }).text
    if (typeof text === 'string') out += text
  }
  return out
}

/** 只负责拼接「截断文本 + 标注」，不判断是否需要截断（调用方已经 slice 过） */
function withText(message: AgentMessage, clipped: string, note: string): AgentMessage {
  const body = `${clipped}…${note}`
  const role = (message as { role?: string }).role
  if (role === 'toolResult' || Array.isArray((message as { content?: unknown }).content)) {
    return { ...message, content: [{ type: 'text', text: body }] } as AgentMessage
  }
  return { ...message, content: body } as AgentMessage
}

/**
 * 从新到旧裁剪上下文。
 * ★ 保留首条 user（作者原始目标）与最后 2 条：丢了它们，续接就接不上话。
 */
export function compactMessages(
  messages: AgentMessage[],
  opts: { budgetChars?: number; keepRecent?: number } = {},
): AgentMessage[] {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET
  const keepRecent = opts.keepRecent ?? DEFAULT_RECENT
  const total = messages.reduce((n, m) => n + textOf(m).length, 0)
  const out = messages.map((m) => ({ ...m }))
  if (total <= budget) return out

  const keepFrom = Math.max(0, out.length - keepRecent)
  for (let i = 1; i < keepFrom; i += 1) {
    const m = out[i]
    if (m === undefined) continue
    const role = (m as { role?: string }).role
    if (role === 'toolResult') {
      out[i] = withText(m, textOf(m).slice(0, TOOL_CLIP), '（早期工具输出已压缩）')
    } else if (role === 'assistant') {
      out[i] = withText(m, textOf(m).slice(0, ASSISTANT_CLIP), '（早期回复已压缩）')
    }
  }

  // 压缩后仍超预算：从最旧开始丢，但保留首条与最后 2 条
  let size = out.reduce((n, m) => n + textOf(m).length, 0)
  const cursor = 1
  while (size > budget && cursor < out.length - 2) {
    const dropped = out[cursor]
    if (dropped === undefined) break
    size -= textOf(dropped).length
    out.splice(cursor, 1)
  }
  return out
}

export async function saveMessageSnapshot(
  root: string,
  sessionId: string,
  snap: MessageSnapshot,
): Promise<void> {
  const body: MessageSnapshot = {
    ...snap,
    messages: compactMessages(stripSystemMessages(snap.messages)),
  }
  // atomicWrite 不建目录：第一次存快照时 sessions/ 还不存在
  await mkdir(sessionDir(root), { recursive: true })
  await atomicWrite(messageSnapshotPath(root, sessionId), `${JSON.stringify(body)}\n`)
}

export async function loadMessageSnapshot(
  root: string,
  sessionId: string,
): Promise<MessageSnapshot | null> {
  const raw = await readIfExists(messageSnapshotPath(root, sessionId))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as MessageSnapshot
    if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}
