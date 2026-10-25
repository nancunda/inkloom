import type { JudgeProvider, JudgeRequest, JudgeResult } from './types.js'

/**
 * 按脚本返回结果的 mock 判断器。
 *
 * ★ 只用于测试与「关掉判断层」的场景：它不会假装懂了什么，
 *   调用方必须自己给出每个问题的预设答案。
 */
export function createMockJudge(script: (req: JudgeRequest, index: number) => JudgeResult): {
  provider: JudgeProvider
  calls: JudgeRequest[][]
} {
  const calls: JudgeRequest[][] = []
  return {
    calls,
    provider: {
      id: 'mock',
      async judge(requests) {
        calls.push(requests)
        return requests.map((req, i) => script(req, i))
      },
    },
  }
}
