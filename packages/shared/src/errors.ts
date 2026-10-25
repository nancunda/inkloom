export type ErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_INPUT'
  | 'CORE_IO_VIOLATION'
  | 'CAS_MISMATCH'
  | 'SEG_NOT_FOUND'
  | 'GIT_FAILED'
  | 'INDEX_STALE'
  // ★ 外部依赖类（Ruling 46）：
  //   AUTH 与 INVALID_INPUT 必须分开——「没配置 key」和「字段填错了」
  //   在 UI 上是两种提示（一个让你去填 key，一个让你改输入）。
  | 'AUTH'
  | 'UNAVAILABLE'

/**
 * 领域错误的唯一类型。
 *
 * 为什么不用裸 Error：调用方需要按 code 做分支（CAS_MISMATCH 弹合并对话框、
 * NOT_FOUND 返回 404…），靠 message 字符串匹配是脆的。
 */
export class InkloomError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'InkloomError'
    this.code = code
  }
}
