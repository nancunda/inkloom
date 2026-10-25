import type { JudgeProvider, JudgeRequest, JudgeResult } from '@inkloom/core'
import type { FetchLike } from '../llm/types.js'

export interface OpenAiJudgeOptions {
  apiKey: string
  /** 默认硅基流动；任何 OpenAI 兼容服务都行 */
  baseUrl?: string
  model?: string
  fetchImpl?: FetchLike
}

const SYSTEM = `你是一个只做判断、不写正文的评审。严格按要求的格式回答，不要解释。
- 打分题：只输出一个阿拉伯数字
- 选择题：只输出选项原文
- 是否题：只输出「是」或「否」`

/**
 * OpenAI 兼容的判断器（默认接硅基流动，国内直连）。
 *
 * ★ 必须说清楚：它不是 JEV。JEV 输出的是真正的概率与分布，
 *   这里只能拿到一段文本，置信度是**启发式**（解析成功 0.8，模糊 0.4），
 *   报告里 provider 写 siliconflow-judge，不冒充 JEV。
 * ★ 每个问题单独一次调用、并行发出：兼容服务的结构化输出不可靠，
 *   合并成一个 JSON 反而更容易解析失败。
 */
export function createOpenAiJudge(opts: OpenAiJudgeOptions): JudgeProvider {
  const base = (opts.baseUrl ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
  // 实测硅基流动可用且便宜快：Qwen2.5-7B 已下线，改用 DeepSeek-V4.1-Flash
  const model = opts.model ?? 'deepseek-ai/DeepSeek-V4.1-Flash'
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  async function ask(req: JudgeRequest): Promise<JudgeResult> {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 16,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildPrompt(req) },
        ],
      }),
    })
    if (!res.ok) throw new Error(`judge http ${res.status}: ${await res.text()}`)

    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    return parseAnswer(req, (body.choices?.[0]?.message?.content ?? '').trim())
  }

  return {
    id: 'siliconflow-judge',
    judge(requests) {
      return Promise.all(requests.map(ask))
    },
  }
}

function buildPrompt(req: JudgeRequest): string {
  const lines = [req.question, '', '待判断的正文：', req.context]
  if (req.primitive === 'choice') {
    lines.push('', `只能从这些选项里选一个：${(req.options ?? []).join(' / ')}`)
  }
  if (req.primitive === 'score') {
    const [low, high] = req.scale ?? [1, 5]
    lines.push('', `只输出 ${low} 到 ${high} 之间的一个整数`)
  }
  if (req.primitive === 'noul') lines.push('', '只输出「是」或「否」')
  return lines.join('\n')
}

function parseAnswer(req: JudgeRequest, raw: string): JudgeResult {
  if (raw.length === 0) return { value: '', confidence: 0 }

  if (req.primitive === 'score') {
    const m = /-?\d+(?:\.\d+)?/.exec(raw)
    if (m === null) return { value: '', confidence: 0.2 }
    const [low, high] = req.scale ?? [1, 5]
    const n = Math.min(high, Math.max(low, Number(m[0])))
    return { value: n, confidence: 0.8 }
  }

  if (req.primitive === 'choice') {
    const hit = (req.options ?? []).find((o) => raw.includes(o))
    return hit === undefined ? { value: '', confidence: 0.2 } : { value: hit, confidence: 0.8 }
  }

  // noul：只认明确的是/否
  if (raw.startsWith('是') || raw.toLowerCase().startsWith('yes')) {
    return { value: true, confidence: 0.8 }
  }
  if (raw.startsWith('否') || raw.toLowerCase().startsWith('no')) {
    return { value: false, confidence: 0.8 }
  }
  return { value: '', confidence: 0.2 }
}
