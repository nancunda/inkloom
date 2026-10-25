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
 *   这里只能拿到一段文本，置信度是**启发式**（解析成功 0.8，模糊 0.2），
 *   报告里 provider 写 siliconflow-judge，不冒充 JEV。
 * ★ 一个场景的 N 个问题合成**一次**调用：实测把 3 问并行发出去，
 *   15 个并发请求会被服务端排队，5 个场景反而跑 60 秒；
 *   合成一次后总请求数降到 1/3，5 个场景约 8 秒。
 *   代价是答案按行对齐，行数对不上时该问降为低置信（不瞎猜）。
 */
export function createOpenAiJudge(opts: OpenAiJudgeOptions): JudgeProvider {
  const base = (opts.baseUrl ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
  // 实测硅基流动可用且便宜快：Qwen2.5-7B 已下线，改用 DeepSeek-V4.1-Flash
  const model = opts.model ?? 'deepseek-ai/DeepSeek-V4.1-Flash'
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  async function chat(messages: { role: string; content: string }[]): Promise<string> {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 64, messages }),
    })
    if (!res.ok) throw new Error(`judge http ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return (body.choices?.[0]?.message?.content ?? '').trim()
  }

  async function askOne(req: JudgeRequest): Promise<JudgeResult> {
    const text = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildPrompt(req) },
    ])
    return parseAnswer(req, text)
  }

  /** N 个问题合成一次调用：按序号逐行输出，行数对不上就降为低置信 */
  async function askMany(requests: JudgeRequest[]): Promise<JudgeResult[]> {
    const numbered = requests.map((r, i) => `${i + 1}. ${buildPrompt(r)}`).join('\n\n')
    const text = await chat([
      {
        role: 'system',
        content: `${SYSTEM}\n本次有多道题：按序号逐行输出答案，一行一个，不要写序号，不要解释。`,
      },
      { role: 'user', content: numbered },
    ])
    const lines = text
      .split('\n')
      .map((l) => l.replace(/^\d+[.、)]\s*/, '').trim())
      .filter((l) => l.length > 0)
    return requests.map((req, i) => parseAnswer(req, lines[i] ?? ''))
  }

  return {
    id: 'siliconflow-judge',
    judge(requests) {
      if (requests.length === 0) return Promise.resolve([])
      if (requests.length === 1) {
        const only = requests[0]
        return only === undefined ? Promise.resolve([]) : Promise.all([askOne(only)])
      }
      return askMany(requests)
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
