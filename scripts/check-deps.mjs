#!/usr/bin/env node
// 扫描 packages/core 下所有 .ts 的 import，禁止 IO/DB/HTTP。
// 违规则打印证据并 exit 1。
//
// 这是 spec §2.1「core 零 IO」铁律的唯一强制手段。
// 为什么不靠 lint 插件：Biome 的 noRestrictedImports 在不同版本里规则名与作用域
// 配置方式不一致，而这条约束是项目地基，不能依赖工具的版本行为。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SCANNED_DIRS = ['packages/core/src', 'packages/prompt/src']
const BANNED = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'prisma',
  '@prisma/client',
  'hono',
  'better-sqlite3',
  'node:sqlite',
  'undici',
  'node:child_process',
  'node:net',
  'node:http',
]

/**
 * 把注释替换为等长空白（保留行号）。
 * 否则 `// core 层不 import node:fs` 这样的说明性注释会被误判为违规，
 * 而报告位置指向注释 —— 排查成本很高。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '))
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const violations = []
for (const dir of SCANNED_DIRS) {
  for (const file of walk(dir)) {
    const src = stripComments(readFileSync(file, 'utf8'))
    const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(src)) !== null) {
      const spec = m[1]
      if (BANNED.some((b) => spec === b || spec.startsWith(`${b}/`))) {
        const line = src.slice(0, m.index).split('\n').length
        violations.push(`${relative(process.cwd(), file)}:${line}  禁止导入 '${spec}'`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error('✗ core/prompt 层出现 IO 依赖（spec §2.1 铁律）：')
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}
console.log('✓ core/prompt 层无 IO 依赖')
