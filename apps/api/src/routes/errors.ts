import { InkloomError } from '@inkloom/shared'

export interface ApiError {
  error: { code: string; message: string }
}

/** Hono 的 c.json(status) 需要字面量联合，不能是宽泛的 number */
export type ErrorStatus = 400 | 401 | 404 | 409 | 422 | 500 | 503

/**
 * InkloomError.code → HTTP 状态码（spec §7）。
 *
 * ★ 未知码一律 500：静默降级成 400 会让「服务端 bug」看起来像「用户输入错」，
 *   排查时会被误导。
 */
export function httpStatusFor(code: string): ErrorStatus {
  switch (code) {
    case 'INVALID_INPUT':
      return 400
    case 'AUTH':
      return 401
    case 'NOT_FOUND':
    case 'SEG_NOT_FOUND':
      return 404
    case 'CONFLICT':
    case 'CAS_MISMATCH':
    case 'INDEX_STALE':
      return 409
    case 'UNPROCESSABLE':
      return 422
    // 外部依赖/本地 IO 失败：不是用户的错，但也不是「未知 bug」
    case 'UNAVAILABLE':
      return 503
    case 'CORE_IO_VIOLATION':
    case 'GIT_FAILED':
      return 500
    default:
      return 500
  }
}

/**
 * 任意异常 → { status, body }。
 *
 * ★ 只回 message，不带 stack：堆栈会泄漏绝对路径。
 */
export function toApiError(e: unknown): { status: ErrorStatus; body: ApiError } {
  if (e instanceof InkloomError) {
    return {
      status: httpStatusFor(e.code),
      body: { error: { code: e.code, message: e.message } },
    }
  }
  const message = e instanceof Error ? e.message : String(e)
  return { status: 500, body: { error: { code: 'INTERNAL', message } } }
}
