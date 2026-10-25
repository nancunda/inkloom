export type BlockId =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'
  | 'S5'
  | 'U1'
  | 'U2'
  | 'U3'
  | 'U4'
  | 'U5'
  | 'U6'
  | 'U7'
  | 'U8'
  | 'U9'

export type BlockRole = 'system' | 'user'

/**
 * 预算优先级（spec §4.3）。
 *
 * P0/P1 不裁剪（超预算走分档流程让用户选），P2–P7 按阶梯降级。
 */
export type BlockPriority = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface PromptBlock {
  id: BlockId
  role: BlockRole
  priority: BlockPriority
  /**
   * 渲染后的纯文本；null 表示该块本次无内容。
   *
   * 为什么是 null 而不是空字符串：空串会让"该块不存在"和"该块内容为空"
   * 无法区分，而装配层要据此决定是否跳过该段（避免空行堆积）。
   */
  content: string | null
}
