#!/usr/bin/env node
// 把便携版服务端搬进 Tauri 的资源目录。
//
// ★ 为什么不把 node.exe + app/ 提交进仓库：那是 200MB+ 的构建产物，
//   每次改代码都会让 git 变大；这里在打包前从 release/ 复制一份。
// ★ release 目录没变时用时间戳跳过，避免每次打包都搬 200MB。
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const RELEASES = join(ROOT, 'release')
const TARGET = resolve(HERE, '..', 'src-tauri', 'server')
const STAMP = join(TARGET, '.staged')

/** release/ 下可能有多个版本目录，取 node.exe 最新的那个 */
async function newestRelease() {
  if (!existsSync(RELEASES)) return null
  const names = (await readdir(RELEASES)).filter((n) => /^inkloom-.*-win-x64$/.test(n))
  const rows = []
  for (const name of names) {
    const dir = join(RELEASES, name)
    if (!existsSync(join(dir, 'node.exe'))) continue
    rows.push({ dir, at: (await stat(join(dir, 'node.exe'))).mtimeMs, name })
  }
  rows.sort((a, b) => b.at - a.at)
  return rows[0] ?? null
}

const latest = await newestRelease()
if (latest === null) {
  console.error(`✗ release/ 下没有可用的便携版：${RELEASES}`)
  console.error('  先跑：node scripts/build-release.mjs')
  process.exit(1)
}
const SOURCE = latest.dir
const src = await stat(join(SOURCE, 'app'))
if (existsSync(STAMP)) {
  const stamp = await stat(STAMP)
  if (stamp.mtimeMs >= src.mtimeMs) {
    console.log('✓ 服务端已是最新，跳过')
    process.exit(0)
  }
}

console.log(`→ 拷贝服务端 ${latest.name} → ${TARGET}`)
await rm(TARGET, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
await mkdir(TARGET, { recursive: true })
await cp(SOURCE, TARGET, { recursive: true, dereference: false, force: true })
await mkdir(dirname(STAMP), { recursive: true })
await writeFile(STAMP, new Date().toISOString())
console.log('✓ 服务端就位')
