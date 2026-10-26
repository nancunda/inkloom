import { describe, expect, it } from 'vitest'
import { chat, DEFAULT_DEEPSEEK_MODEL } from './deepseek.js'
import { type FetchLike, LlmError } from './types.js'

function fakeFetch(status: number, body: unknown, headers?: Record<string, string>): FetchLike {
  return async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    })
}

const okBody = {
  choices: [{ message: { content: '===场景1===\n林岚踏上山道。' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1200, completion_tokens: 800, prompt_cache_hit_tokens: 1000 },
}

const base = { apiKey: 'sk-test', messages: [{ role: 'user' as const, content: '写第 4 章' }] }

describe('chat — 成功路径', () => {
  it('返回正文与 usage', async () => {
    const r = await chat({ ...base, fetchImpl: fakeFetch(200, okBody) })
    expect(r.content).toContain('林岚踏上山道')
    expect(r.usage.input).toBe(1200)
    expect(r.usage.output).toBe(800)
    expect(r.usage.cacheHit).toBe(1000)
    expect(r.finishReason).toBe('stop')
  })

  it('★ 默认模型是 deepseek-flash（不是 deepseek-chat）', () => {
    expect(DEFAULT_DEEPSEEK_MODEL).toBe('deepseek-flash')
  })

  it('★ 请求体里 model 默认就是 deepseek-flash', async () => {
    let captured: { model?: string } = {}
    const spy: FetchLike = async (_u, init) => {
      captured = JSON.parse(String(init.body)) as { model?: string }
      return new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    await chat({ ...base, fetchImpl: spy })
    expect(captured.model).toBe('deepseek-flash')
  })

  it('cache_hit_tokens 缺失时按 0 处理（不是 undefined）', async () => {
    const body = {
      choices: [{ message: { content: '甲' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }
    const r = await chat({ ...base, fetchImpl: fakeFetch(200, body) })
    expect(r.usage.cacheHit).toBe(0)
    expect(r.usage.reasoning).toBe(0)
  })

  it('★ 解析 reasoning_tokens（deepseek-flash 是推理模型，输出包含思考）', async () => {
    const body = {
      choices: [{ message: { content: '甲' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 900,
        completion_tokens_details: { reasoning_tokens: 700 },
      },
    }
    const r = await chat({ ...base, fetchImpl: fakeFetch(200, body) })
    expect(r.usage.output).toBe(900)
    expect(r.usage.reasoning).toBe(700)
    // 正文只占 200 token，思考占了 700——不记录 reasoning 会让人以为花了 900 写正文
  })

  it('★ finish_reason=length 要能透传（截断必须可检测）', async () => {
    const body = {
      choices: [{ message: { content: '写到一半' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 5000 },
    }
    const r = await chat({ ...base, fetchImpl: fakeFetch(200, body) })
    expect(r.finishReason).toBe('length')
  })

  it('baseUrl 被拼成 /chat/completions', async () => {
    let url = ''
    const spy: FetchLike = async (u) => {
      url = u
      return new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    await chat({ ...base, baseUrl: 'https://example.test', fetchImpl: spy })
    expect(url).toBe('https://example.test/chat/completions')
  })
})

describe('chat — 错误映射（spec §7.1）', () => {
  it('★ 401 → AUTH（不重试）', async () => {
    await expect(
      chat({ ...base, fetchImpl: fakeFetch(401, { error: { message: 'invalid api key' } }) }),
    ).rejects.toBeInstanceOf(LlmError)
  })

  it('401 的 code 是 AUTH 且 status=401', async () => {
    try {
      await chat({ ...base, fetchImpl: fakeFetch(401, { error: { message: 'bad' } }) })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as LlmError).code).toBe('AUTH')
      expect((e as LlmError).status).toBe(401)
    }
  })

  it('★ 429 → RATE_LIMIT 且带 retry-after', async () => {
    try {
      await chat({
        ...base,
        fetchImpl: fakeFetch(429, { error: { message: 'rate' } }, { 'retry-after': '12' }),
      })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as LlmError).code).toBe('RATE_LIMIT')
      expect((e as LlmError).retryAfterSec).toBe(12)
    }
  })

  it('500 → HTTP', async () => {
    try {
      await chat({ ...base, fetchImpl: fakeFetch(500, { error: { message: 'boom' } }) })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as LlmError).code).toBe('HTTP')
      expect((e as LlmError).status).toBe(500)
    }
  })

  it('★ 空输出 → EMPTY（不落候选稿）', async () => {
    const body = {
      choices: [{ message: { content: '   ' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }
    try {
      await chat({ ...base, fetchImpl: fakeFetch(200, body) })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as LlmError).code).toBe('EMPTY')
    }
  })

  it('★ 思考耗尽预算导致空输出 → 说清原因并带上 usage', async () => {
    const body = {
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 12000,
        completion_tokens_details: { reasoning_tokens: 12000 },
      },
    }
    try {
      await chat({ ...base, fetchImpl: fakeFetch(200, body) })
      throw new Error('应当抛错')
    } catch (e) {
      const err = e as LlmError
      expect(err.code).toBe('EMPTY')
      expect(err.message).toContain('12000')
      expect(err.message).toContain('正文未产出')
      expect(err.usage?.reasoning).toBe(12000)
    }
  })

  it('★ 超时 → TIMEOUT', async () => {
    const slow: FetchLike = (_u, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    try {
      await chat({ ...base, fetchImpl: slow, timeoutMs: 20 })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as LlmError).code).toBe('TIMEOUT')
    }
  })

  it('★ 错误信息里不含 apiKey（防泄漏到日志）', async () => {
    const secret = 'sk-super-secret-123'
    try {
      await chat({
        ...base,
        apiKey: secret,
        fetchImpl: fakeFetch(401, { error: { message: 'bad' } }),
      })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as Error).message).not.toContain(secret)
    }
  })

  it('非 JSON 错误响应也能给出可读信息', async () => {
    try {
      await chat({ ...base, fetchImpl: fakeFetch(502, '<html>bad gateway</html>') })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as LlmError).code).toBe('HTTP')
      expect((e as Error).message).toContain('HTTP 502')
    }
  })
})
