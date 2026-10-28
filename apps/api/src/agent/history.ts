import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { InkloomError } from '@inkloom/shared'
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
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/

/** 会话的落盘目录：`.inkloom/agent/sessions/` */
export function sessionDir(root: string): string {
  return join(bookPaths(root).inkloom, 'agent', 'sessions')
}

export function messageSnapshotPath(root: string, sessionId: string): string {
  // ★ sessionId 将来直接来自 URL path；不校验就是任意路径读写
  if (!SESSION_ID.test(sessionId)) {
    throw new InkloomError('INVALID_INPUT', `非法会话 id：${sessionId}`)
  }
  return join(sessionDir(root), `${sessionId}.messages.json`)
}

/** ★ 首条 system 带着工具声明；工具集会随代码/开关变化，恢复时必须用当前 prompt 重建 */
export function stripSystemMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => (m as { role?: string }).role !== 'system')
}

interface ContentBlock {
  type?: string
  text?: string
  [key: string]: unknown
}

function blocksOf(message: AgentMessage): ContentBlock[] | null {
  const content = (message as { content?: unknown }).content
  return Array.isArray(content) ? (content as ContentBlock[]) : null
}

/** 字符口径的正文：只用于「这段文本有多长」，不参与体积预算 */
function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  const blocks = blocksOf(message)
  if (blocks === null) return ''
  let out = ''
  for (const block of blocks) {
    if (typeof block.text === 'string') out += block.text
  }
  return out
}

/** ★ 预算按整条消息的 JSON 体积算：thinking / details / 图片也占真实空间，只数字会漏 */
function sizeOf(messages: AgentMessage[]): number {
  let total = 0
  for (const message of messages) total += JSON.stringify(message).length
  return total
}

function clipText(text: string, max: number, note: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}…${note}`
}

/**
 * 压缩一条旧消息。
 * ★ assistant 只留 text + toolCall：丢 thinking 是省空间，丢 toolCall 会让配对断裂、续接 400。
 * ★ toolResult 只截 text 块，图片原样保留。
 */
function compressMessage(message: AgentMessage): AgentMessage {
  const role = (message as { role?: string }).role
  const blocks = blocksOf(message)
  if (blocks === null) {
    const content = (message as { content?: unknown }).content
    if (role === 'assistant' && typeof content === 'string') {
      return {
        ...message,
        content: clipText(content, ASSISTANT_CLIP, '（早期回复已压缩）'),
      } as AgentMessage
    }
    return message
  }
  if (role !== 'assistant' && role !== 'toolResult') return message

  const max = role === 'toolResult' ? TOOL_CLIP : ASSISTANT_CLIP
  const note = role === 'toolResult' ? '（早期工具输出已压缩）' : '（早期回复已压缩）'
  let changed = false
  const next: ContentBlock[] = []
  for (const block of blocks) {
    if (role === 'assistant' && block.type === 'thinking') {
      changed = true
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = clipText(block.text, max, note)
      if (text !== block.text) changed = true
      next.push({ ...block, text })
      continue
    }
    next.push(block)
  }
  return changed ? ({ ...message, content: next } as AgentMessage) : message
}

function hasToolCall(message: AgentMessage): boolean {
  if ((message as { role?: string }).role !== 'assistant') return false
  const blocks = blocksOf(message)
  return blocks !== null && blocks.some((b) => b.type === 'toolCall')
}

/**
 * 按「轮」分组：assistant(toolCall) 与紧随其后的 toolResult 是一组。
 * ★ 逐条删会拆散配对，provider 会直接 400。
 */
function groupMessages(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = []
  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (message === undefined) break
    if (!hasToolCall(message)) {
      groups.push([message])
      i += 1
      continue
    }
    const group = [message]
    i += 1
    while (i < messages.length && (messages[i] as { role?: string }).role === 'toolResult') {
      const result = messages[i]
      if (result !== undefined) group.push(result)
      i += 1
    }
    groups.push(group)
  }
  return groups
}

/** 从尾部往回数，凑够 keepRecent 条消息要保留多少组 */
function groupsToKeep(groups: AgentMessage[][], keepRecent: number): number {
  let count = 0
  let keep = 0
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    keep += 1
    count += groups[g]?.length ?? 0
    if (count >= keepRecent) break
  }
  return keep
}

/**
 * 预算内不动；超预算时压旧组、再从最旧的组开始丢。
 * ★ 首组（作者原始目标）与最后 keepRecent 条对应的组永远保留，否则续接接不上话。
 */
export function compactMessages(
  messages: AgentMessage[],
  opts: { budgetChars?: number; keepRecent?: number } = {},
): AgentMessage[] {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET
  const keepRecent = opts.keepRecent ?? DEFAULT_RECENT
  // ★ 幂等剥离：保证 index 0 是作者输入，而不是旧 system
  const base = stripSystemMessages(messages)
  if (sizeOf(base) <= budget) return structuredClone(base)

  const groups = groupMessages(base)
  const keep = groupsToKeep(groups, keepRecent)
  const firstKeep = Math.max(0, groups.length - keep)

  for (let g = 1; g < firstKeep; g += 1) {
    const group = groups[g]
    if (group !== undefined) groups[g] = group.map(compressMessage)
  }

  let size = groups.reduce((n, group) => n + sizeOf(group), 0)
  const cursor = 1
  while (size > budget && cursor < groups.length - keep) {
    const removed = groups[cursor]
    if (removed === undefined) break
    size -= sizeOf(removed)
    groups.splice(cursor, 1)
  }
  return structuredClone(groups.flat())
}

export async function saveMessageSnapshot(
  root: string,
  sessionId: string,
  snap: MessageSnapshot,
): Promise<void> {
  // ★ 文件名与文件内字段以参数为准：错传旧快照对象时不至于张冠李戴
  const body: MessageSnapshot = {
    ...snap,
    version: 1,
    sessionId,
    savedAt: new Date().toISOString(),
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
