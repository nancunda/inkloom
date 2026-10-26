export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatUsage {
  input: number
  output: number
  /**
   * 其中用于「思考」的 token。
   *
   * ★ deepseek-flash 是推理模型：会先输出 reasoning（不计入 content），
   *   但 reasoning 也计入 completion_tokens。所以 output = reasoning + 正文。
   *   不单独记录的话，用户会以为“我只要 2000 字怎么花了 7000 token”。
   */
  reasoning: number
  /** DeepSeek 的前缀缓存命中 token 数；缺失记 0 */
  cacheHit: number
}

export interface ChatResult {
  content: string
  usage: ChatUsage
  finishReason: string
}

export type LlmErrorCode = 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'EMPTY' | 'HTTP'

/**
 * LLM 调用的统一错误类型。
 *
 * 为什么不用裸 Error：调用方要按 code 分支
 * （AUTH 提示检查 key、RATE_LIMIT 读 retry-after 后重试、TIMEOUT 不重试）。
 * 靠 message 字符串匹配是脆的。
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode
  readonly status: number | null
  /** 429 时服务端给的 retry-after 秒数 */
  readonly retryAfterSec: number | null
  /**
   * 失败前已经消耗掉的 token。
   *
   * ★ 空内容（EMPTY）不是“没花钱”：推理已经把额度烧完了。
   *   不把 usage 带出去，成本报表里这段就是凭空消失的。
   */
  readonly usage: ChatUsage | null

  constructor(
    code: LlmErrorCode,
    message: string,
    status: number | null = null,
    retryAfterSec: number | null = null,
    usage: ChatUsage | null = null,
  ) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
    this.retryAfterSec = retryAfterSec
    this.usage = usage
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface ChatOptions {
  apiKey: string
  model?: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  baseUrl?: string
  /** 测试时注入假 fetch：CI 零网络、零花费 */
  fetchImpl?: FetchLike
  signal?: AbortSignal
  timeoutMs?: number
}
