#!/usr/bin/env node
// 把便携版服务端搬进 Tauri 的资源目录。
//
// ★ 为什么不把 node.exe + app/ 提交进仓库：那是 200MB+ 的构建产物，
//   每次改代码都会让 git 变大；这里在打包前从 release/ 复制一份。
// ★ 按目录名里的版本号挑最新，不看文件 mtime：各版本的 node.exe 都是同一个
//   文件复制来的、mtime 完全一样，按 mtime 排序会挑错（曾经挑到 0.0.1）。
// ★ 版本没变时跳过，避免每次打包都搬 200MB。
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const RELEASES = join(ROOT, 'release')
const TARGET = resolve(HERE, '..', 'src-tauri', 'server')
// 内容是 { version, at }：版本号不同就必须重拷，不能只看时间戳
const STAMP = join(TARGET, '.staged.json')

/** 把 "0.1.0" 拆成数字比较，避免 0.10.0 排到 0.9.0 前面 */
function compareVersion(a, b) {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** release/ 下可能有多个版本目录，取版本号最大的那个 */
async function newestRelease() {
  if (!existsSync(RELEASES)) return null
  const rows = []
  for (const name of await readdir(RELEASES)) {
    const match = /^inkloom-(.+)-win-x64$/.exec(name)
    if (match === null) continue
    const dir = join(RELEASES, name)
    if (!existsSync(join(dir, 'node.exe'))) continue
    if (!existsSync(join(dir, 'app', 'package.json'))) continue
    rows.push({ dir, name, version: match[1] ?? '0.0.0' })
  }
  rows.sort((a, b) => compareVersion(b.version, a.version))
  return rows[0] ?? null
}

const latest = await newestRelease()
if (latest === null) {
  console.error(`✗ release/ 下没有可用的便携版：${RELEASES}`)
  console.error('  先跑：node scripts/build-release.mjs')
  process.exit(1)
}

let staged = null
try {
  staged = JSON.parse(await readFile(STAMP, 'utf8'))
} catch {
  // 没有 stamp 或内容损坏：当作没stage 过
}
if (staged?.version === latest.version && existsSync(join(TARGET, 'node.exe'))) {
  console.log(`✓ 服务端已是 ${latest.version}，跳过`)
  process.exit(0)
}

console.log(`→ 拷贝服务端 ${latest.name} → ${TARGET}`)
await rm(TARGET, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
await mkdir(TARGET, { recursive: true })
await cp(latest.dir, TARGET, { recursive: true, dereference: false, force: true })
await writeFile(STAMP, `${JSON.stringify({ version: latest.version, at: new Date().toISOString() }, null, 2)}\n`)
console.log(`✓ 服务端就位（${latest.version}）`)
