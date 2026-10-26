import {
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type FetchLike,
  LlmError,
} from './types.js'

/**
 * ★ 必须是 deepseek-flash，不是 deepseek-chat。
 *   实测：请求 deepseek-chat 会被服务端路由到 deepseek-flash，
 *   但显式写清楚能避免将来服务端改路由时静默换模型。
 */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_TIMEOUT_MS = 180_000

interface DeepSeekResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

/** 从错误响应里尽量挖出可读信息，但绝不回显 apiKey */
function describeFailure(status: number, bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } }
    const msg = j.error?.message
    if (typeof msg === 'string' && msg.length > 0) return msg
  } catch {
    // 非 JSON，退回截断原文
  }
  return `${bodyText.slice(0, 200)}（HTTP ${status}）`
}

/**
 * 调用 DeepSeek Chat Completions（OpenAI 兼容）。
 *
 * 为什么不用 Vercel AI SDK：DeepSeek 是 OpenAI 兼容接口，非流式调用约 60 行；
 * 引入 `ai` + provider 包会带来几十个传递依赖，与「不要太繁重」冲突。
 * P1-a 也用不到 SDK 的结构化输出 / tool calling。
 *
 * ★ `fetchImpl` 可注入：测试时用假 fetch，CI 零网络、零花费。
 */
export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const model = opts.model ?? DEFAULT_DEEPSEEK_MODEL
  const baseUrl = opts.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 外部 signal 与内部超时合并：任一触发都中止
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const body: Record<string, unknown> = {
    model,
    messages: opts.messages satisfies ChatMessage[],
    stream: false,
  }
  if (opts.temperature !== undefined) body['temperature'] = opts.temperature
  if (opts.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens

  let res: Response
  try {
    res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const name = (e as Error).name
    if (name === 'AbortError') {
      throw new LlmError('TIMEOUT', `请求超过 ${timeoutMs}ms 未返回`)
    }
    throw new LlmError('HTTP', `网络错误：${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const detail = describeFailure(res.status, text)
    if (res.status === 401) {
      throw new LlmError('AUTH', `鉴权失败（在「设置」里检查 DEEPSEEK_API_KEY）：${detail}`, 401)
    }
    if (res.status === 429) {
      const ra = res.headers.get('retry-after')
      const sec = ra === null ? null : Number(ra)
      throw new LlmError('RATE_LIMIT', `限流：${detail}`, 429, Number.isFinite(sec) ? sec : null)
    }
    throw new LlmError('HTTP', `HTTP ${res.status}：${detail}`, res.status)
  }

  const json = (await res.json()) as DeepSeekResponse
  const content = json.choices?.[0]?.message?.content ?? ''
  const usage = {
    input: json.usage?.prompt_tokens ?? 0,
    output: json.usage?.completion_tokens ?? 0,
    reasoning: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cacheHit: json.usage?.prompt_cache_hit_tokens ?? 0,
  }
  if (content.trim().length === 0) {
    // ★ 最常见的根因：推理模型把 max_tokens 全花在 reasoning 上，正文 0 字。
    //   笼统的“空内容”会让用户反复重试；把 finish_reason 和思考消耗说清楚。
    const finish = json.choices?.[0]?.finish_reason ?? 'unknown'
    const msg =
      finish === 'length' && usage.reasoning > 0
        ? `思考耗尽了 ${usage.reasoning} tokens 的预算（finish_reason=length），正文未产出。请重试，或调低本章目标字数后重新生成`
        : `模型返回空内容（finish_reason=${finish}）`
    throw new LlmError('EMPTY', msg, null, null, usage)
  }

  return {
    content,
    usage,
    finishReason: json.choices?.[0]?.finish_reason ?? 'unknown',
  }
}
