/** 极简参数解析：`--key value` / `--flag` / 位置参数 */
export function parseFlags(args: string[]): {
  positional: string[]
  flags: Record<string, string>
} {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === undefined) continue
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

export function requireFlag(flags: Record<string, string>, key: string): string {
  const v = flags[key]
  if (v === undefined) throw new Error(`缺少 --${key}`)
  return v
}

export function requirePositional(positional: string[], index: number, usage: string): string {
  const v = positional[index]
  if (v === undefined) throw new Error(`用法：${usage}`)
  return v
}
