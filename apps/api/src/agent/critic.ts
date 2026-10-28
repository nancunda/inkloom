export interface CriticConflict {
  severity: 'error' | 'warning'
  message: string
  evidence: string[]
}

export interface CriticReport {
  conflicts: CriticConflict[]
  suggestions: string[]
}

export interface CriticInput {
  taskId: string
  title: string
  brief: string
  artifacts: string[]
  summary: string | null
  goal: string
}

export type CriticVerdict =
  | { kind: 'passed'; warnings: CriticConflict[]; suggestions: string[] }
  | { kind: 'blocked'; errors: CriticConflict[]; warnings: CriticConflict[] }
  | { kind: 'skipped'; reason: string }

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stripFence(text: string): string {
  const t = text.trim()
  // ★ 不锚定整段：模型习惯在围栏前后加一句解释，锚定会让 critic 常态退化成 skipped
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (m === null) return t
  const inner = (m[1] ?? '').trim()
  try {
    JSON.parse(inner)
    return inner
  } catch {
    // 围栏内容不是 JSON（多块/嵌套）：交回外层按非法处理，不猜
    return t
  }
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim())
}

/**
 * 解析 critic 的 JSON 输出。
 * ★ 手写校验而不是 zod：apps/api 只依赖 typebox，为一个解析器引入整套 schema 库不划算；
 *   结构不对就返回 null（调用方按「检查未完成」放行），绝不做猜测性修补。
 */
export function parseCriticReport(text: string): CriticReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFence(text))
  } catch {
    return null
  }
  if (!isRec(parsed)) return null
  const rawConflicts = parsed['conflicts']
  if (!Array.isArray(rawConflicts)) return null
  const rawSuggestions = parsed['suggestions']
  if (rawSuggestions !== undefined && rawSuggestions !== null && !Array.isArray(rawSuggestions)) {
    return null
  }

  const conflicts: CriticConflict[] = []
  for (const item of rawConflicts) {
    // ★ 形状不对就整份作废：若 continue 吞掉，critic 报了 error 也会变成空 conflicts → 谎报通过
    if (!isRec(item)) return null
    const severity = item['severity']
    const message = item['message']
    const rawEvidence = item['evidence']
    if (severity !== 'error' && severity !== 'warning') return null
    if (typeof message !== 'string' || message.trim().length === 0) return null
    if (!Array.isArray(rawEvidence)) return null
    if (rawEvidence.some((e) => typeof e !== 'string')) return null
    const evidence = strings(rawEvidence)
    // ★ 唯一允许丢弃的理由：模型没给证据（没证据的矛盾不采信）
    if (evidence.length === 0) continue
    conflicts.push({ severity, message: message.trim(), evidence })
  }
  return { conflicts, suggestions: strings(rawSuggestions) }
}

export function decideCritic(report: CriticReport | null): CriticVerdict {
  if (report === null) return { kind: 'skipped', reason: '返回内容不是合法 JSON' }
  // 导出的函数可能被手工构造的对象调用：缺字段当作空，而不是让下游 slice 抛错
  const conflicts = Array.isArray(report.conflicts) ? report.conflicts : []
  const errors = conflicts.filter((c) => c.severity === 'error')
  const warnings = conflicts.filter((c) => c.severity === 'warning')
  if (errors.length > 0) return { kind: 'blocked', errors, warnings }
  return { kind: 'passed', warnings, suggestions: report.suggestions ?? [] }
}

/** 默认开：只有显式关闭值才关（设置页写 on/off，手改 .env 常用 false/0/no 也要认） */
export function criticEnabled(raw: string | undefined): boolean {
  const v = (raw ?? 'on').trim().toLowerCase()
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no'
}
