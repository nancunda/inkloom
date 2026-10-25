import type { JudgeProvider } from '@inkloom/core'
import { createMockJudge } from '@inkloom/core'

/**
 * 判断层开关。
 *
 * ★ 默认 off：Tier 2 会产生额外调用与成本，用户没主动打开就不该花钱。
 * ★ mock 只为「把链路跑通」存在，它不会假装看懂了正文——
 *   报告里 provider 会写 mock，界面必须如实显示。
 * ★ openai（硅基流动）与 typesafe（JEV 官方）在各自的 provider 里实现，
 *   这里只做路由。
 */
export type JudgeMode = 'off' | 'mock' | 'openai' | 'typesafe'

export function currentJudgeMode(): JudgeMode {
  const raw = (process.env['INKLOOM_JUDGE'] ?? 'off').trim().toLowerCase()
  return raw === 'mock' || raw === 'openai' || raw === 'typesafe' ? raw : 'off'
}

/** 测试可注入；生产按环境变量选 */
export function resolveJudgeProvider(override?: JudgeProvider | null): JudgeProvider | null {
  if (override !== undefined) return override

  switch (currentJudgeMode()) {
    case 'mock':
      // 固定脚本：只验证管线，不提供任何真实判断
      return createMockJudge(() => ({ value: 3, confidence: 0.5 })).provider
    case 'off':
    default:
      return null
  }
}
