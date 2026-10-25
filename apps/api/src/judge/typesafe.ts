import type { JudgeProvider, JudgeRequest, JudgeResult } from '@inkloom/core'
import type { FetchLike } from '../llm/types.js'

export interface TypeSafeJudgeOptions {
  apiKey: string
  /** jev-latest / jev-preview / jev-1.13.0 … */
  model?: string
  baseUrl?: string
  fetchImpl?: FetchLike
}

interface TypeSafeAnswer {
  type?: string
  choice?: string
  probabilities?: Record<string, number>
  confidence?: number
  probability?: number
  score?: number
}

/**
 * TypeSafe 官方 JEV（System One API）。
 *
 * ★ 一次请求发 N 个问题，共用同一段 state——所以调用方必须先按正文分组
 *   （health-check 已这么做），否则会拿 A 场景的正文答 B 场景的问题。
 * ★ 官方对部分地区返回 451（Unavailable For Legal Reasons），
 *   这不是 key 的问题：错误会原样带上状态码，交由上层降级。
 */
export function createTypeSafeJudge(opts: TypeSafeJudgeOptions): JudgeProvider {
  const base = (opts.baseUrl ?? 'https://api.typesafe.ai').replace(/\/+$/, '')
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'typesafe-jev',
    async judge(requests) {
      if (requests.length === 0) return []

      const questions: Record<string, unknown> = {}
      const keys: string[] = []
      requests.forEach((req, i) => {
        const key = `q${i + 1}`
        keys.push(key)
        questions[key] = toQuestion(req)
      })

      const res = await fetchImpl(`${base}/v1/systemone`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          state: requests[0]?.context ?? '',
          model: opts.model ?? 'jev-latest',
          questions,
        }),
      })
      if (!res.ok) {
        throw new Error(`typesafe ${res.status}: ${await res.text()}`)
      }

      const body = (await res.json()) as { answers?: Record<string, TypeSafeAnswer> }
      return keys.map((k) => fromAnswer(body.answers?.[k]))
    },
  }
}

function toQuestion(req: JudgeRequest): Record<string, unknown> {
  if (req.primitive === 'choice') {
    const criteria: Record<string, string> = {}
    for (const option of req.options ?? []) criteria[option] = option
    return { type: 'choice', instructions: req.question, criteria }
  }
  if (req.primitive === 'score') {
    const [low, high] = req.scale ?? [1, 5]
    const levels: string[] = []
    for (let v = low; v <= high; v++) levels.push(String(v))
    return { type: 'score', instructions: req.question, levels }
  }
  return {
    type: 'noul',
    instructions: req.question,
    yesMeans: '是 / 冲突',
    noMeans: '否 / 不冲突',
  }
}

function fromAnswer(a: TypeSafeAnswer | undefined): JudgeResult {
  if (a === undefined) return { value: '', confidence: 0 }

  if (a.type === 'choice') {
    return {
      value: a.choice ?? '',
      confidence: a.confidence ?? 0,
      ...(a.probabilities === undefined ? {} : { distribution: a.probabilities }),
    }
  }
  if (a.type === 'noul') {
    const p = a.probability ?? 0
    // 二分类的置信度就是「偏向答案那一侧的概率」
    return { value: p >= 0.5, confidence: Math.max(p, 1 - p) }
  }
  if (a.type === 'score') {
    return { value: a.score ?? 0, confidence: a.confidence ?? 0 }
  }
  return { value: '', confidence: 0 }
}
