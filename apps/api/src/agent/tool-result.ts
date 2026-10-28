import type { AgentToolResult } from '@earendil-works/pi-agent-core'

export function ok(
  text: string,
  details: Record<string, unknown> = {},
  terminate = false,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: 'text', text }],
    details,
    ...(terminate ? { terminate: true } : {}),
  }
}

export function fail(
  text: string,
  details: Record<string, unknown> = {},
): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: 'text', text }], details, isError: true }
}

/** 摘要压成一行并截断：搜索列表里不要塞换行 */
export function clip(text: string, max = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}
