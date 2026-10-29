import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'

/**
 * 设置：读写项目根目录的 .env。
 *
 * ★ 为什么是 .env 而不是数据库：用户的 key 不该进书稿仓库，
 *   也不该进 SQLite（会被一起拷走）。.env 在项目根，git 已忽略。
 * ★ 写入后立刻改 process.env：生成/判断/生图都在调用时读 env，
 *   不需要重启进程就能生效；.env 只负责下次启动。
 */
const NUMERIC = new Set(['INKLOOM_WORDS_PER_CHAPTER'])

/** 允许前端写的键；不在白名单里的一律拒绝，避免把任意 env 写进文件 */
const WRITABLE = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_BASE_URL',
  'INKLOOM_JUDGE',
  'INKLOOM_JUDGE_MODEL',
  'INKLOOM_CRITIC',
  'SILICONFLOW_API_KEY',
  'SILICONFLOW_IMAGE_MODEL',
  'TYPESAFE_API_KEY',
  'TAVILY_API_KEY',
  'SEARXNG_BASE_URLS',
  'INKLOOM_WORDS_PER_CHAPTER',
] as const

const SECRET = new Set([
  'DEEPSEEK_API_KEY',
  'SILICONFLOW_API_KEY',
  'TYPESAFE_API_KEY',
  'TAVILY_API_KEY',
])

const DEFAULTS: Record<string, string> = {
  DEEPSEEK_MODEL: 'deepseek-flash',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  INKLOOM_JUDGE: 'off',
  INKLOOM_JUDGE_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash',
  INKLOOM_CRITIC: 'on',
  SILICONFLOW_IMAGE_MODEL: 'Kwai-Kolors/Kolors',
  INKLOOM_WORDS_PER_CHAPTER: '3000',
}

function envFile(): string {
  // ★ 桌面版把 .env 放在用户目录（壳层设 INKLOOM_ENV_FILE）：装到 Program Files
  //   样式的位置后，cwd 里的 .env 会在升级/卸载时跟着走，key 就丢了。
  //   便携版与开发版不设这个变量，仍是老行为：cwd/.env。
  const custom = (process.env['INKLOOM_ENV_FILE'] ?? '').trim()
  if (custom.length > 0) return custom
  // 便携版 cwd 就是包根，开发时是仓库根——两者 .env 都在 cwd
  return join(process.cwd(), '.env')
}

function mask(key: string, v: string): string {
  if (SECRET.has(key)) {
    if (v.length === 0) return ''
    if (v.length <= 10) return '••••••'
    return `${v.slice(0, 5)}••••${v.slice(-4)}`
  }
  return v
}

function parseEnv(raw: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t.length === 0 || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    m.set(t.slice(0, i).trim(), t.slice(i + 1).trim())
  }
  return m
}

export const settings = new Hono()

settings.get('/settings', async (c) => {
  const file = envFile()
  const onDisk = existsSync(file)
    ? parseEnv(await readFile(file, 'utf8'))
    : new Map<string, string>()

  const rows = WRITABLE.map((key) => {
    const live = (process.env[key] ?? '').trim()
    const stored = (onDisk.get(key) ?? '').trim()
    const value = live.length > 0 ? live : stored
    return {
      key,
      secret: SECRET.has(key),
      value: mask(key, value),
      set: value.length > 0,
      // 只在 .env 里有、当前进程没读到 → 需要重启才生效（不该发生，但如实说）
      pendingRestart: stored.length > 0 && live.length === 0,
      default: DEFAULTS[key] ?? '',
    }
  })

  return c.json({
    envPath: file,
    exists: existsSync(file),
    fields: rows,
    judgeMode: (process.env['INKLOOM_JUDGE'] ?? 'off').trim(),
  })
})

settings.put('/settings', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (body === null) throw new InkloomError('INVALID_INPUT', '请求体必须是 JSON 对象')

  const updates: [string, string][] = []
  for (const [k, raw] of Object.entries(body)) {
    if (!(WRITABLE as readonly string[]).includes(k)) {
      throw new InkloomError('INVALID_INPUT', `不允许修改的配置项：${k}`)
    }
    if (typeof raw !== 'string') throw new InkloomError('INVALID_INPUT', `${k} 必须是字符串`)
    const v = raw.trim()
    if (NUMERIC.has(k) && v.length > 0) {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) {
        throw new InkloomError('INVALID_INPUT', `${k} 必须是正整数`)
      }
    }
    if (k === 'INKLOOM_JUDGE' && !['off', 'mock', 'openai', 'typesafe'].includes(v)) {
      throw new InkloomError('INVALID_INPUT', 'INKLOOM_JUDGE 只能是 off / mock / openai / typesafe')
    }
    if (k === 'INKLOOM_CRITIC' && !['on', 'off'].includes(v)) {
      throw new InkloomError('INVALID_INPUT', 'INKLOOM_CRITIC 只能是 on / off')
    }
    updates.push([k, v])
  }
  if (updates.length === 0) throw new InkloomError('INVALID_INPUT', '没有要保存的配置项')

  const file = envFile()
  const raw = existsSync(file) ? await readFile(file, 'utf8') : ''
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/)

  for (const [k, v] of updates) {
    const idx = lines.findIndex((l) => l.trim().startsWith(`${k}=`))
    const line = `${k}=${v}`
    if (idx >= 0) {
      // 清空值 = 删除这一行（比留 KEY= 更好：空字符串会被当成「已设置」）
      if (v.length === 0) lines.splice(idx, 1)
      else lines[idx] = line
    } else if (v.length > 0) {
      lines.push(line)
    }
    if (v.length === 0) delete process.env[k]
    else process.env[k] = v
  }

  const text = `${lines.filter((l, i) => !(i === lines.length - 1 && l.trim() === '')).join('\n')}\n`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')

  return c.json({
    ok: true,
    saved: updates.map(([k, v]) => ({ key: k, value: mask(k, v), set: v.length > 0 })),
    envPath: file,
    note: '已写入 .env 并即时生效；下次启动自动读取',
  })
})
