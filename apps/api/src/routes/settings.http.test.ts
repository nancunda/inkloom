import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

/**
 * 桌面版把 .env 放在用户目录（%LOCALAPPDATA%\inkloom\.env），不在 cwd——
 * 否则升级/卸载会连 key 一起弄丢。这里锁住 INKLOOM_ENV_FILE 的优先级。
 */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkloom-settings-'))
})

afterEach(async () => {
  delete process.env['INKLOOM_ENV_FILE']
  delete process.env['DEEPSEEK_API_KEY']
  await rm(dir, { recursive: true, force: true })
})

describe('GET/PUT /api/settings 的 env 文件位置', () => {
  it('★ INKLOOM_ENV_FILE 指向哪，读写就落在哪', async () => {
    const envPath = join(dir, 'custom.env')
    process.env['INKLOOM_ENV_FILE'] = envPath
    const app = createApp()

    const seen = await app.request('/api/settings')
    expect(seen.status).toBe(200)
    expect(((await seen.json()) as { envPath: string }).envPath).toBe(envPath)

    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ DEEPSEEK_API_KEY: 'sk-desktop' }),
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as { envPath: string }).envPath).toBe(envPath)
    expect(await readFile(envPath, 'utf8')).toContain('DEEPSEEK_API_KEY=sk-desktop')
  })

  it('没设 INKLOOM_ENV_FILE 时仍用 cwd/.env（CLI 与便携版的老行为）', async () => {
    const app = createApp()
    const res = await app.request('/api/settings')
    const body = (await res.json()) as { envPath: string }
    expect(body.envPath).toBe(join(process.cwd(), '.env'))
  })
})
