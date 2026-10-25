import { countWords } from './words.js'

export type RewriteVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'too_long' | 'has_marker' }

const FENCE_RE = /^```[a-z]*\n?|\n?```$/g
const MARKER_RE = /<!--[\s\S]*?-->/g

/** 成对的包裹符号：模型最爱把整段话用其中一种裹起来 */
const WRAPPERS: readonly (readonly [string, string])[] = [
  ['“', '”'],
  ['「', '」'],
  ['‘', '’'],
  ['"', '"'],
  ["'", "'"],
]

/**
 * 清洗模型返回的单段文本，并判断它是否还值得落盘。
 *
 * 返回判定而不是抛错：core 是纯函数层，不该依赖错误类型；
 * 由 api 层把 reason 翻译成 INVALID_INPUT 与中文提示。
 *
 * 长度边界只针对「原文非空」的情况：原文为空说明这是在填空，
 * 没有比例可依，只查空与标记。
 */
export function sanitizeRewrittenSegment(raw: string, original: string): RewriteVerdict {
  let text = raw.replace(FENCE_RE, '').trim()

  let peeling = true
  while (peeling && text.length >= 2) {
    peeling = false
    for (const [open, close] of WRAPPERS) {
      if (
        text.startsWith(open) &&
        text.endsWith(close) &&
        text.length > open.length + close.length
      ) {
        text = text.slice(open.length, text.length - close.length).trim()
        peeling = true
        break
      }
    }
  }

  // ★ 先判标记再清洗：模型把 <!-- seg --> 写进来意味着它在"补全整段场景"，
  //   而这里要的是"改写这一段"。悄悄删掉标记会把跑题伪装成成功。
  if (MARKER_RE.test(text)) return { ok: false, reason: 'has_marker' }

  if (text.length === 0 || countWords(text) === 0) return { ok: false, reason: 'empty' }

  const before = countWords(original)
  if (before > 0) {
    const after = countWords(text)
    if (after < before * 0.4) return { ok: false, reason: 'too_short' }
    if (after > before * 3) return { ok: false, reason: 'too_long' }
  }

  return { ok: true, text }
}
