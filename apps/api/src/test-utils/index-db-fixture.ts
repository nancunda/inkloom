import { execSync } from 'node:child_process'
import { copyFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type IndexDb, openIndexDb } from '../index-db/client.js'

/**
 * 集成测试的索引库夹具。
 *
 * 两个问题一起解决：
 *
 * 1. **Windows 上不能用 execFile 调 pnpm**
 *    Node 24 修复 CVE-2024-27980 后，`execFile('pnpm.cmd', …)` 会 EINVAL。
 *    这里用 execSync（走 shell）绕开。
 *
 * 2. **每个测试跑一次 prisma migrate 太慢**
 *    首次跑一次 migrate 得到空白模板库，之后每个测试只是 copyFile（毫秒级）。
 */
let cachedTemplate: string | null = null

function toFileUrl(p: string): string {
  return `file:${p.split('\\').join('/')}`
}

/** 建（或复用）模板库。同一测试文件内只跑一次 migrate。 */
export async function ensureTemplateDb(): Promise<string> {
  if (cachedTemplate !== null) return cachedTemplate
  const dir = await mkdtemp(join(tmpdir(), 'inkloom-tpl-'))
  const templatePath = join(dir, 'template.sqlite')
  execSync('pnpm exec prisma migrate deploy', {
    cwd: 'apps/api',
    env: { ...process.env, INKLOOM_DATABASE_URL: toFileUrl(templatePath) },
    stdio: 'pipe',
  })
  cachedTemplate = templatePath
  return templatePath
}

/** 在给定目录里造一个全新的索引库（结构来自模板，数据为空） */
export async function freshIndexDb(dir: string): Promise<IndexDb> {
  const template = await ensureTemplateDb()
  const dbPath = join(dir, 'index.sqlite')
  await copyFile(template, dbPath)
  return openIndexDb(dbPath)
}
