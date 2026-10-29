#!/usr/bin/env node
// 打便携版发行包：解压双击 start.bat 即可运行，无需安装 Node / pnpm。
//
// ★ 为什么不打成单文件 exe：Prisma 的查询引擎是 .node 原生模块，
//   Node SEA / pkg 对它的支持都不稳定。用「自带 node.exe + 扁平 node_modules」
//   的便携目录，可靠性远高于冒单文件的风险，代价只是解压后多几十兆。
// ★ 不用 pnpm workspace 结构：pnpm 会给 workspace 包建符号链接，压缩后必然断。
//   这里把 @inkloom/* 复制成真实目录，node_modules 全扁平。
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const VERSION = pkg.version ?? '0.0.0'
const NAME = `inkloom-${VERSION}-win-x64`
const OUT = join(ROOT, 'release', NAME)
const APP = join(OUT, 'app')

const step = (msg) => console.log(`  → ${msg}`)

// 1. 清空产物目录（Windows 上刚退出的进程会短暂粘住句柄，带重试）
await rm(OUT, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
await mkdir(APP, { recursive: true })
step(`产物目录 ${OUT}`)

// 2. 前端必须已构建
if (!existsSync(join(ROOT, 'apps/web/dist/index.html'))) {
  throw new Error('apps/web/dist 不存在：先跑 pnpm --filter @inkloom/web build')
}

// 3. 复制运行时需要的源码与静态资源
await cp(join(ROOT, 'apps/api/src'), join(APP, 'apps/api/src'), { recursive: true })
await cp(join(ROOT, 'apps/web/dist'), join(APP, 'apps/web/dist'), { recursive: true })
await cp(join(ROOT, 'apps/api/prisma'), join(APP, 'prisma'), { recursive: true })
await cp(join(ROOT, 'fixtures/qixia'), join(APP, 'fixtures/qixia'), {
  recursive: true,
  // ★ 只排索引与 .git：`.inkloom/project-id` 是身份锚，少了它书就“认不出自己”；
  //   revisions/*.jsonl 是要素历史，也不能丢。
  filter: (src) => !/index\.sqlite/.test(src) && !/[\\/]\.git([\\/]|$)/.test(src),
})
step('复制 api/src、web/dist、prisma、示例书')

// 4. workspace 包落成真实目录（无符号链接）
for (const name of ['shared', 'core', 'prompt']) {
  const dir = join(APP, 'node_modules/@inkloom', name)
  await mkdir(dir, { recursive: true })
  await cp(join(ROOT, 'packages', name, 'src'), join(dir, 'src'), { recursive: true })
  const p = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'))
  // 依赖里去掉 workspace:* —— 包内手动装
  p.dependencies = Object.fromEntries(
    Object.entries(p.dependencies ?? {}).filter(([, v]) => !String(v).startsWith('workspace:')),
  )
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(p, null, 2)}\n`, 'utf8')
}
step('@inkloom/{shared,core,prompt} 落成真实目录')

// 5. 应用自身的 package.json：第三方依赖全部写实
await writeFile(
  join(APP, 'package.json'),
  `${JSON.stringify(
    {
      name: 'inkloom-app',
      version: VERSION,
      private: true,
      type: 'module',
      dependencies: {
        // ★ 手写清单容易漏：改 apps/api 的依赖时，这里必须同步。
        //   缺一个 linkedom 就会让整个便携版在 read_url 模块加载时就起不来。
        '@earendil-works/pi-agent-core': '1.4.0',
        '@earendil-works/pi-ai': '1.4.0',
        '@hono/node-server': '^2.1.5',
        '@mozilla/readability': '^0.6.0',
        '@prisma/client': '^6.19.3',
        diff: '^9.0.0',
        hono: '^4.13.13',
        linkedom: '^0.18.14',
        prisma: '6.19.3',
        tsx: '^4.23.15',
        typebox: '1.3.27',
        zod: '^4.6.7',
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
)

// 6. 扁平安装（hoisted：没有符号链接，压缩后不会断）
// ★ --ignore-workspace 必需：app 目录在项目里，pnpm 会向上找到根 workspace，
//   把依赖装到根 node_modules 去，包里反而什么都没有。
step('安装生产依赖（hoisted，可能需要几十秒）')
execFileSync(
  'pnpm',
  ['install', '--prod', '--node-linker=hoisted', '--ignore-scripts', '--ignore-workspace'],
  { cwd: APP, stdio: 'inherit', shell: true },
)

// 7. 生成 Prisma Client（--ignore-scripts 跳过了它，这里显式跑）
step('生成 Prisma Client')
execFileSync(
  process.execPath,
  [join(APP, 'node_modules/prisma/build/index.js'), 'generate', '--schema', 'prisma/schema.prisma'],
  { cwd: APP, stdio: 'inherit' },
)

// 8. 自带 node.exe
await cp(process.execPath, join(OUT, 'node.exe'))
step(`复制 node.exe（${process.version}）`)

// 9. 启动脚本
await writeFile(
  join(OUT, 'start.bat'),
  [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    '',
    'if not defined INKLOOM_BOOK set INKLOOM_BOOK=%~dp0app\\fixtures\\qixia',
    'if not defined PORT set PORT=8787',
    '',
    'echo.',
    'echo   inkloom — 浏览器打开 http://127.0.0.1:%PORT%',
    'echo   换个书：set INKLOOM_BOOK=D:\\你的书 && start.bat',
    'echo   需要生成正文：在同目录 .env 里写 DEEPSEEK_API_KEY=sk-...',
    'echo.',
    '',
    'node.exe app\\node_modules\\tsx\\dist\\cli.mjs --env-file-if-exists=.env app\\apps\\api\\src\\server.ts',
    'pause',
    '',
  ].join('\r\n'),
  'utf8',
)

await writeFile(
  join(OUT, 'README.txt'),
  [
    'inkloom 便携版',
    '',
    '1. 双击 start.bat',
    '2. 浏览器打开 http://127.0.0.1:8787',
    '',
    '无需安装 Node 或 pnpm：node.exe 与依赖都在本目录里。',
    '默认打开示例书《七霞》。要写自己的书：',
    '  set INKLOOM_BOOK=D:\\你的书\\目录',
    '  start.bat',
    '',
    '需要 AI 生成正文时，在同目录新建 .env，写一行：',
    '  DEEPSEEK_API_KEY=sk-...',
    '',
    '更多说明见 https://github.com/nancunda/inkloom',
    '',
  ].join('\r\n'),
  'utf8',
)

// 10. 打包 zip
const zipPath = join(ROOT, 'release', `${NAME}.zip`)
step('压缩 zip（这一步会慢一些）')
execFileSync(
  'powershell',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}' -DestinationPath '${zipPath}' -Force`],
  { stdio: 'inherit' },
)

const size = (await import('node:fs/promises')).stat
const zipStat = await size(zipPath)
console.log(`\n✓ 发行包：${zipPath}`)
console.log(`  ${(Number(zipStat.size) / 1024 / 1024).toFixed(1)} MB`)
