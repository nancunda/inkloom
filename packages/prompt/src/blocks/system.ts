import type { Project, StyleAsset, WorldRule } from '@inkloom/shared'
import type { PromptBlock } from '../types.js'

/**
 * S1 角色身份与职责。
 *
 * ★ 这是 system 段的第一块，必须跨章完全一致（含标点），否则 DeepSeek 的
 *   前缀缓存全部失效（缓存命中 ¥0.04/M vs 未命中 ¥2/M，50 倍差距）。
 *   所以这里绝不能出现章节号、角色名等随章变化的内容。
 */
export function blockS1(project: Project): PromptBlock {
  const lines = [
    '你是一位签约于起点中文网的长篇网文作者，擅长玄幻题材。',
    `你正在写《${project.name}》这本书（题材：${project.genre}）。`,
    '你的任务是根据给定的设定、蓝图与上文，写出本章正文。',
    '你只输出正文，不解释、不评论、不写作者的话。',
  ]
  return { id: 'S1', role: 'system', priority: 0, content: lines.join('\n') }
}

/** S2 文风契约：整体语感。放 system 是因为它跨章不变 */
export function blockS2(style: StyleAsset): PromptBlock {
  const lines = ['【文风契约】', style.description]
  if (style.samples.length > 0) {
    lines.push('', '语感示例（模仿其节奏与用词密度，不要照抄内容）：')
    for (const s of style.samples) lines.push(`· ${s}`)
  }
  return { id: 'S2', role: 'system', priority: 1, content: lines.join('\n') }
}

/** S3 反 AI 规则：量化约束。无规则时返回 null（不产生空块） */
export function blockS3(style: StyleAsset): PromptBlock {
  const hasWords = style.bannedWords.length > 0
  const hasPatterns = style.bannedPatterns.length > 0
  const quantEntries = Object.entries(style.quantLimits)
  if (!hasWords && !hasPatterns && quantEntries.length === 0) {
    return { id: 'S3', role: 'system', priority: 1, content: null }
  }

  const lines = ['【反 AI 味规则】（违反即视为不合格）']
  if (hasWords) {
    lines.push(`禁用词（一次都不许出现）：${style.bannedWords.join('、')}`)
  }
  if (hasPatterns) {
    lines.push('禁用句式：')
    for (const p of style.bannedPatterns) lines.push(`· ${p}`)
  }
  if (quantEntries.length > 0) {
    lines.push('量化上限（全章合计不得超过）：')
    for (const [word, limit] of quantEntries) lines.push(`· ${word}：${limit} 次`)
  }
  lines.push(
    '',
    '另外避免：排比三连、每段都以景语开头、用“仿佛/似乎/好像”代替具体描写、',
    '用抽象情绪词（悲凉、震撼、复杂）代替具体动作与物象。',
  )
  return { id: 'S3', role: 'system', priority: 1, content: lines.join('\n') }
}

/** S4 世界 hard 规则：违背即 OOC，必须全量注入 */
export function blockS4(hardRules: WorldRule[]): PromptBlock {
  if (hardRules.length === 0) {
    return { id: 'S4', role: 'system', priority: 0, content: null }
  }
  const lines = ['【世界硬规则】（违背即视为设定崩坏）']
  for (const r of hardRules) {
    lines.push(`· [${r.category}] ${r.name}：${r.content}`)
  }
  return { id: 'S4', role: 'system', priority: 0, content: lines.join('\n') }
}

/**
 * S5 输出格式约定（spec §4.6）。
 *
 * ★ 明确禁止 JSON：中文长文本经 JSON 转义后语感显著下降，
 *   而且模型会在字符串里引入 \n 转义，下游解析成本高。
 */
export function blockS5(input: { wordsPerChapter: number | null }): PromptBlock {
  const words = input.wordsPerChapter ?? 3000
  const lines = [
    '【输出格式】',
    '只输出正文，不要任何前言、后记、解释或 Markdown 标题。',
    '',
    '用下面的标记分场景（场景是审阅单位，一般 3–6 个）：',
    '===场景1===',
    '（场景正文，场景内以空行分段）',
    '',
    '===场景2===',
    '（…）',
    '',
    `全章目标字数 ${words} 字（允许 ±20%）。`,
    '不要输出 JSON，不要用代码块包裹。',
  ]
  return { id: 'S5', role: 'system', priority: 0, content: lines.join('\n') }
}
