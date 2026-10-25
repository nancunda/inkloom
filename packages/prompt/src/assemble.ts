import type { StyleAsset } from '@inkloom/shared'
import { blockS1, blockS2, blockS3, blockS4, blockS5 } from './blocks/system.js'
import {
  blockU1,
  blockU2,
  blockU3,
  blockU4,
  blockU5,
  blockU6,
  blockU7,
  blockU8,
  blockU9,
  type ChapterContextInput,
} from './blocks/user.js'
import {
  applyBudget,
  type BudgetConfig,
  type BudgetTier,
  type Degradation,
  estimateTokens,
} from './budget.js'
import type { PromptBlock } from './types.js'

export type PromptRole = 'system' | 'user'

/**
 * 装配层自己的消息类型。
 *
 * ❗不叫 ChatMessage：`apps/api/src/llm/types.ts` 里的 ChatMessage 是含
 * `'assistant'` 的三元联合。两个同名接口并存会让实现者传错类型。
 * 结构上 PromptMessage 是 ChatMessage 的子集，赋值兼容，但名字不同。
 */
export interface PromptMessage {
  role: PromptRole
  content: string
}

export interface AssembleInput extends ChapterContextInput {
  style: StyleAsset
}

export interface AssembledPrompt {
  messages: PromptMessage[]
  /** 实际参与装配的块（含被裁剪后的结果），存档用 */
  blocks: PromptBlock[]
  tokenEstimate: number
  degradation: Degradation[]
  tier: BudgetTier
  usedRatio: number
}

/**
 * 默认预算（deepseek-flash 实测：上下文 1,048,576 / 最大输出 393,216）。
 * denominator = 1,048,576 − 393,216 = 655,360
 *
 * ★ 这个分母很大，30 万字全塞也只占约 46%。
 *   分档机制在日常不会触发，它的价值是防未来接小窗口模型。
 */
export const DEFAULT_BUDGET: BudgetConfig = {
  denominator: 655_360,
  warnRatio: 0.7,
  promptRatio: 0.85,
  forceRatio: 0.95,
}

const BLOCK_SEPARATOR = '\n\n'

/**
 * 装配 Prompt（spec §4.2）。
 *
 * 顺序是设计的一部分，不是实现细节：
 *   system: S1 身份 → S2 文风 → S3 反AI → S4 hard规则 → S5 输出格式
 *   user:   U1 场地 → U2 进度 → U3 线索 → U4 摘要 → U5 上接
 *           → U6 本章蓝图 → U7 后续 → U8 指导 → U9 锚点（**必须最后**）
 *
 * ★ S1–S5 跨章完全一致 → 命中 DeepSeek 前缀缓存（¥0.04/M vs ¥2/M）。
 * ★ U9 放末尾 → 与 S1 形成首尾夹击，对抗 lost-in-the-middle。
 */
export function assemble(
  input: AssembleInput,
  cfg: BudgetConfig = DEFAULT_BUDGET,
): AssembledPrompt {
  const sBlocks: PromptBlock[] = [
    blockS1(input.project),
    blockS2(input.style),
    blockS3(input.style),
    blockS4(input.hardRules),
    blockS5({ wordsPerChapter: input.project.wordsPerChapter ?? null }),
  ]
  const uBlocks: PromptBlock[] = [
    blockU1(input),
    blockU2(input),
    blockU3(input),
    blockU4(input),
    blockU5(input),
    blockU6(input),
    blockU7(input),
    blockU8(input),
    blockU9(input), // ★ 必须最后
  ]

  const ordered = [...sBlocks, ...uBlocks]
  const budgeted = applyBudget(ordered, cfg)

  const render = (role: PromptRole): string =>
    budgeted.blocks
      .filter((b) => b.role === role && b.content !== null)
      .map((b) => b.content as string)
      .join(BLOCK_SEPARATOR)

  const messages: PromptMessage[] = [
    { role: 'system', content: render('system') },
    { role: 'user', content: render('user') },
  ]

  return {
    messages,
    blocks: budgeted.blocks,
    tokenEstimate: messages.reduce((n, m) => n + estimateTokens(m.content), 0),
    degradation: budgeted.degradation,
    tier: budgeted.tier,
    usedRatio: budgeted.usedRatio,
  }
}
