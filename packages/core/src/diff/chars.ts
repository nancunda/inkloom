import { diffChars } from 'diff'

export type DiffOp = 'same' | 'add' | 'remove'

export interface DiffSpan {
  op: DiffOp
  text: string
}

export interface DiffSummary {
  addedChars: number
  removedChars: number
  unchangedChars: number
  /** 相似度 0–1：unchanged / max(lenA, lenB)；两边都空时为 1 */
  similarity: number
}

/**
 * 字符级 diff（spec §4.7）。
 *
 * ★ 为什么不用行级：中文没有空格分词，一行可能就是一整段，
 *   行级 diff 会把「改了一个字」显示成「整段替换」，用户无法审阅。
 * ★ 为什么不用词级：中文没有天然词边界，分词器会引入歧义和新依赖。
 */
export function diffText(oldText: string, newText: string): DiffSpan[] {
  return diffChars(oldText, newText).map((part) => ({
    op: part.added === true ? 'add' : part.removed === true ? 'remove' : 'same',
    text: part.value,
  }))
}

export function summarizeDiff(spans: DiffSpan[]): DiffSummary {
  let addedChars = 0
  let removedChars = 0
  let unchangedChars = 0
  for (const s of spans) {
    const n = s.text.length
    if (s.op === 'add') addedChars += n
    else if (s.op === 'remove') removedChars += n
    else unchangedChars += n
  }
  const oldLen = unchangedChars + removedChars
  const newLen = unchangedChars + addedChars
  const denom = Math.max(oldLen, newLen)
  return {
    addedChars,
    removedChars,
    unchangedChars,
    // 两边都空视为完全一致（避免 0/0 = NaN 污染下游比较）
    similarity: denom === 0 ? 1 : unchangedChars / denom,
  }
}

const HINT_PREVIEW_CHARS = 40

/**
 * 生成终端可读的变更提示。
 *
 * ★ 只列 add / remove：same 在审阅场景里是噪音
 *   （一段 500 字的文本改了 3 个字，列出全部 same 会让 3 处变更淹没在 500 字里）。
 */
export function renderDiffHints(spans: DiffSpan[], maxHints = 10): string[] {
  const changed = spans.filter((s) => s.op !== 'same' && s.text.length > 0)
  const hints: string[] = []
  for (const s of changed.slice(0, maxHints)) {
    const marker = s.op === 'add' ? '+' : '-'
    const preview =
      s.text.length > HINT_PREVIEW_CHARS ? `${s.text.slice(0, HINT_PREVIEW_CHARS)}…` : s.text
    // 换行显示成 ⏎、空格显示成 ·，否则一条提示会被拆成多行或看不出改了空白
    hints.push(`${marker} ${preview.replace(/\n/g, '⏎').replace(/ /g, '·')}`)
  }
  if (changed.length > maxHints) {
    hints.push(`… 还有 ${changed.length - maxHints} 处变更`)
  }
  return hints
}
