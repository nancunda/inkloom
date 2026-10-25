import type { PromptBlock } from './types.js'

export interface Degradation {
  blockId: string
  action: 'trim' | 'drop' | 'reduce'
  detail: string
}

export interface BudgetConfig {
  /** 分母 = 模型上下文窗口 − 最大输出（spec §3.12.2 的 budgetDenominator） */
  denominator: number
  warnRatio: number
  promptRatio: number
  forceRatio: number
}

export type BudgetTier = 'normal' | 'warn' | 'prompt' | 'force'

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/**
 * token 估算法（保守）。
 *
 * 中文约 1.5 字/token，其它（英文/数字/标点）约 4 字符/token。
 * ★ 保守估算的意义：宁可高估导致多裁一点，也不要低估导致 API 端截断。
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  const other = text.length - cjk
  return Math.ceil(cjk / 1.5 + other / 4)
}

function totalTokens(blocks: PromptBlock[]): number {
  let sum = 0
  for (const b of blocks) if (b.content !== null) sum += estimateTokens(b.content)
  return sum
}

/**
 * 预算裁剪（spec §4.3）。
 *
 * 规则：
 *   - priority 0/1（P0/P1）**永不裁剪**——它们是本章能不能看的底线
 *   - priority 2..7 按**优先级从低到高**依次 drop，直到进入 promptRatio 以内
 *   - 每次 drop 都写 degradation，事后可归因
 *
 * ★ 为什么不在超预算时抛错：那会让用户卡死。
 *   降级 + 留痕是更好的选择，质量差了能查到原因。
 */
export function applyBudget(
  blocks: PromptBlock[],
  cfg: BudgetConfig,
): { blocks: PromptBlock[]; degradation: Degradation[]; tier: BudgetTier; usedRatio: number } {
  const degradation: Degradation[] = []
  let kept = [...blocks]
  let tokens = totalTokens(kept)
  let ratio = cfg.denominator > 0 ? tokens / cfg.denominator : 0

  // 从最不重要的开始裁（priority 大的先走）
  const droppable = [...kept]
    .filter((b) => b.priority >= 2 && b.content !== null)
    .sort((a, b) => b.priority - a.priority)

  for (const victim of droppable) {
    if (ratio <= cfg.promptRatio) break
    kept = kept.filter((b) => b.id !== victim.id)
    tokens = totalTokens(kept)
    ratio = cfg.denominator > 0 ? tokens / cfg.denominator : 0
    degradation.push({
      blockId: victim.id,
      action: 'drop',
      detail: `P${victim.priority} 块超出预算被丢弃（使用率降至 ${(ratio * 100).toFixed(1)}%）`,
    })
  }

  const tier: BudgetTier =
    ratio > cfg.forceRatio
      ? 'force'
      : ratio > cfg.promptRatio
        ? 'prompt'
        : ratio > cfg.warnRatio
          ? 'warn'
          : 'normal'

  return { blocks: kept, degradation, tier, usedRatio: ratio }
}
