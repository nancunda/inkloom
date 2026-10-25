export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

/**
 * 统一的 fetch 封装。
 *
 * ★ 错误必须抛 ApiError（带 code）：UI 要按 code 分支——
 *   AUTH（401）→ 提示去填 key；CONFLICT（409）→ 提示刷新；
 *   其余 → 直接显示 message。
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  const text = await res.text()
  const json: unknown = text.length === 0 ? null : JSON.parse(text)

  if (!res.ok) {
    const e = json as { error?: { code?: string; message?: string } } | null
    throw new ApiError(e?.error?.code ?? 'UNKNOWN', e?.error?.message ?? res.statusText, res.status)
  }
  return json as T
}

/** POST 的语法糖：自动 JSON.stringify */
export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) })
}
