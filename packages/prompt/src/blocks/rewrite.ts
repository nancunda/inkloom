import type { PromptMessage } from '../assemble.js'

export interface RewriteInput {
  chapterNo: number
  sceneNo: number
  sceneGoal: string | null
  conflict: string | null
  hook: string | null
  /** 同场景上一段；没有则为 null（不产出 "undefined"） */
  prevText: string | null
  /** 同场景下一段；没有则为 null */
  nextText: string | null
  /** 要重写的这一段 */
  original: string
  /** 用户的额外要求，如「更克制」「少用比喻」 */
  guidance: string | null
}

/**
 * 重写的 system 段。
 *
 * ★ 与整章生成不同，这里不追求前缀缓存：重写是偶发的一次性调用，
 *   而且原文每次不同。但常量放在模块级仍有价值——跨请求字节一致，
 *   便于快照测试与问题复盘时对齐。
 */
const SYSTEM = `你是中文小说编辑，任务是改写一个段落。

硬性要求：
1. 只输出这一段的新文本。不要输出场景标题、段标记（<!-- seg:xxxx -->）、
   代码围栏或引号包裹，也不要输出任何解释、说明或前后缀。
2. 保持与前后段相同的时态、人称与文风；不要引入前文没有的人物或设定。
3. 改写是换一种写法，不是删减情节：原文里的动作与后果必须还在。
4. 篇幅与原文相当（原文字数的 0.5–1.5 倍）。`

/**
 * 构造单段重写的两条消息。
 *
 * ★ 原文用 <<<原文 … 原文>>> 定界：前后段也直接贴在 user 里，
 *   不设边界时模型会把三段当成一段连续的文本去"补全"，
 *   结果就是把邻段也重写了一遍。
 */
export function buildRewriteMessages(input: RewriteInput): PromptMessage[] {
  const lines: string[] = [`第 ${input.chapterNo} 章 · 场景 ${input.sceneNo}`]

  if (input.sceneGoal !== null) lines.push(`本章目的：${input.sceneGoal}`)
  if (input.conflict !== null) lines.push(`本章冲突：${input.conflict}`)
  if (input.hook !== null) lines.push(`本章钩子：${input.hook}`)

  if (input.prevText !== null) lines.push('', '上一段：', input.prevText)
  if (input.nextText !== null) lines.push('', '下一段：', input.nextText)

  lines.push('', '<<<原文', input.original, '原文>>>')

  if (input.guidance !== null && input.guidance.trim().length > 0) {
    lines.push('', `用户要求：${input.guidance.trim()}`)
  }

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: lines.join('\n') },
  ]
}
