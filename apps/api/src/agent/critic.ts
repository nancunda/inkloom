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
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  return m === null ? t : (m[1] ?? '').trim()
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
  if (rawSuggestions !== undefined && !Array.isArray(rawSuggestions)) return null

  const conflicts: CriticConflict[] = []
  for (const item of rawConflicts) {
    if (!isRec(item)) continue
    const severity = item['severity']
    const message = item['message']
    if (severity !== 'error' && severity !== 'warning') continue
    if (typeof message !== 'string' || message.trim().length === 0) continue
    const evidence = strings(item['evidence'])
    // ★ 没有证据的矛盾不采信：模型很容易编一条「看起来有道理」的冲突
    if (evidence.length === 0) continue
    conflicts.push({ severity, message: message.trim(), evidence })
  }
  return { conflicts, suggestions: strings(rawSuggestions) }
}

export function decideCritic(report: CriticReport | null): CriticVerdict {
  if (report === null) return { kind: 'skipped', reason: '返回内容不是合法 JSON' }
  const errors = report.conflicts.filter((c) => c.severity === 'error')
  const warnings = report.conflicts.filter((c) => c.severity === 'warning')
  if (errors.length > 0) return { kind: 'blocked', errors, warnings }
  return { kind: 'passed', warnings, suggestions: report.suggestions }
}
