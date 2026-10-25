/**
 * 判断层（Tier 2 / JEV）接口。
 *
 * ★ 纯类型，零实现零依赖：判断层要能在没有网络、没有 API key 的
 *   环境里被测试与被替换（mock / 本地模型 / 云端服务）。
 * ★ JEV 从不生成一个字：只输出选项、分数或是否，所以它不可能把正文写坏。
 */

export type JudgePrimitive = 'choice' | 'score' | 'noul'

export interface JudgeRequest {
  primitive: JudgePrimitive
  /** 要判断的问题，如「本段是否与角色当前状态冲突」 */
  question: string
  /** choice 必填：候选选项 */
  options?: string[]
  /** score 必填：分数区间，默认 [1,5] */
  scale?: [number, number]
  /** 判断所依据的情境描述 */
  context: string
}

export interface JudgeResult {
  /** choice → 选中的选项；score → 分数；noul → 是/否 */
  value: string | number | boolean
  /** 0–1。★ < 0.75 时不得注入 prompt（spec §4.16 / ADR-29） */
  confidence: number
  /** choice 的原语分布，便于解释「为什么选它」 */
  distribution?: Record<string, number>
}

export interface JudgeProvider {
  /** typesafe-jev | mock | … */
  readonly id: string
  /** 批量并行：一次请求发 N 个问题（spec §4.16 的成本模型） */
  judge(requests: JudgeRequest[]): Promise<JudgeResult[]>
}

/** 低于此置信度的判断只做参考，不许写进 prompt（ADR-29） */
export const JUDGE_INJECT_THRESHOLD = 0.75

export function shouldInject(result: JudgeResult): boolean {
  return Number.isFinite(result.confidence) && result.confidence >= JUDGE_INJECT_THRESHOLD
}
