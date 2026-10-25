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
 *
 * ★ 字数必须给“区间 + 每场景配额”，不能只给一个目标值：
 *   实测只写“全章 2000 字”时，同参数三次生成了 1095 / 4657 / 7000+ 字，
 *   差异近 5 倍。原因是没有逐场景配额，模型可以靠“多写几个短场景”大幅超量。
 *
 * ★ 但**不能**规定“正好 N 个场景”：
 *   实测“正好 4 个 + 每场景 425–600 字 + 全章 1800–2200 字”三条硬约束互相冲突，
 *   一次撞满 max_tokens 被截断（只写完 3 个场景），一次直接返回空内容。
 *   ⇒ 只约束**可知可行域**（总字数 + 每场景字数），场景数让模型在范围内自决。
 *
 * ★ 必须给“字数不够”一条**与文风兼容的解法**：
 *   文风要求“短句、少形容词”，模型靠短句自然写不够 500 字。
 *   实测写了 4×320=1288 字（目标 1800–2200），低于下限 30%。
 *   ⇒ 明确告诉它“加场景”，而不是“拉长句子”（后者会直接破坏文风）。
 */
export function blockS5(input: { wordsPerChapter: number | null }): PromptBlock {
  const words = input.wordsPerChapter ?? 3000
  // 每场景配额：字数的 1/5 – 1/3（400–600 字对应 2000 字一章，约 4–5 个场景）
  // ❗必用整数运算：`3000 * 1.1` 在浮点下是 3300.0000000000005，
  //   ceil 后变成 3301，prompt 里就会出现「2700–3301 字」这种怪数字。
  const perSceneMin = Math.max(200, Math.floor((words * 100) / 500))
  const perSceneMax = Math.ceil((words * 130) / 500)
  const totalMin = Math.floor((words * 9) / 10)
  const totalMax = Math.ceil((words * 11) / 10)

  const lines = [
    '【输出格式】',
    '只输出正文。不要前言、后记、解释、Markdown 标题。',
    '',
    '用下面的标记分场景（场景是审阅单位，一般 4–6 个；总字数不够就多加一个）：',
    '===场景1===',
    `（${perSceneMin}–${perSceneMax} 字）`,
    '',
    '===场景2===',
    `（${perSceneMin}–${perSceneMax} 字）`,
    '',
    '硬要求：',
    `· 全章 ${totalMin}–${totalMax} 字。写不够就加一个场景，不要靠拉长句子或堆形容词凑数。`,
    `· 每个场景 ${perSceneMin}–${perSceneMax} 字。同样：不够就拆出更多场景，不要注水。`,
    '· 一个句子必须在一行内写完，不要把一个句子拆到两行。',
    '· 不要输出 JSON，不要用代码块包裹。',
  ]
  return { id: 'S5', role: 'system', priority: 0, content: lines.join('\n') }
}
