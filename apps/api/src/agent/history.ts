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

/**
 * ★ 预算按整条消息的 JSON 字符数算：thinking / details / 图片也占真实空间，只数正文会漏。
 *   这是字符口径（中文落盘字节约为 3 倍），上限 120k 字符对应快照 < 400KB，可接受。
 */
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
  return blocks?.some((b) => b.type === 'toolCall') ?? false
}

/**
 * 丢掉尾部「没配完的工具调用」：
 *   1) 纯悬空：最后一条是 assistant(toolCall)，结果一条都没回来；
 *   2) 半批：一条 assistant 发了 2 个 toolCall，只回了 1 个 toolResult（工具串行执行，
 *      快照可能正好落在两条结果之间；作者中途点「停止」也会停在这里）。
 *
 * ★ 两种都不能拿去续接：provider 要求 tool_calls 与 tool 消息一一对应。
 *   裁掉不影响任何已完成的内容：下一轮跑完快照会整体覆写，那时尾巴就是完整的。
 */
function dropDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
  let end = messages.length
  // 1) 末尾连续的 assistant(toolCall)：结果一条都没回来
  while (end > 0) {
    const last = messages[end - 1]
    if (last === undefined || !hasToolCall(last)) break
    end -= 1
  }
  // 2) 半批：先收尾部的 toolResult，再回头看它前面那条 assistant 是否已经全部配对
  const resultIds = new Set<string>()
  let cursor = end
  while (cursor > 0) {
    const message = messages[cursor - 1]
    if (message === undefined || (message as { role?: string }).role !== 'toolResult') break
    const id = (message as { toolCallId?: unknown }).toolCallId
    if (typeof id === 'string') resultIds.add(id)
    cursor -= 1
  }
  const head = cursor > 0 ? messages[cursor - 1] : undefined
  if (head !== undefined && hasToolCall(head)) {
    const callIds = (blocksOf(head) ?? [])
      .filter((block) => block.type === 'toolCall')
      .map((block) => (typeof block['id'] === 'string' ? block['id'] : ''))
      .filter((id) => id.length > 0)
    if (callIds.some((id) => !resultIds.has(id))) end = cursor - 1
  }
  return end === messages.length ? messages : messages.slice(0, end)
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
 *   尾窗口不压缩是取舍：里面若有超大工具输出会短暂超预算，但比拆散上下文安全。
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
    messages: dropDanglingToolCalls(compactMessages(snap.messages)),
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
