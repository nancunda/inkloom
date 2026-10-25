#!/usr/bin/env node
import { existsSync } from 'node:fs'
// P0 DoD 验收（spec §9.5）：逐条跑，全绿才算 P0 完成。
//
// ★ 为什么直接调模块而不是 CLI 子进程：
//   Windows 上 execSync 走 cmd.exe 会吞掉 JSON 参数里的双引号
//   （`{"id":"c1"}` 变成 `{id:c1}`），CLI 入口已单独手工验证过。
//   直调模块还能断言内部状态（如 revisions 目录里有没有正文历史）。
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitAll, git, initRepo } from '../apps/api/src/git/runner.js'
import { openBookIndexDb } from '../apps/api/src/index-db/open-book.js'
import { setContext } from '../apps/api/src/services/context.js'
import {
  listElementRevisions,
  rollbackElement,
  upsertElement,
} from '../apps/api/src/services/element-service.js'
import { exportBook } from '../apps/api/src/services/export-service.js'
import { softDeleteElement } from '../apps/api/src/services/invariant-service.js'
import {
  createCheckpoint,
  readCheckpoints,
  rollbackToCheckpoint,
} from '../apps/api/src/storage/checkpoints.js'
import { bookPaths } from '../apps/api/src/storage/paths.js'
import { createProject, openProject } from '../apps/api/src/storage/project.js'
import { reindex } from '../apps/api/src/storage/reindex.js'

const results: { name: string; ok: boolean; err?: string }[] = []

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`✓ ${name}`)
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    results.push({ name, ok: false, err })
    console.error(`✗ ${name}\n    ${err}`)
  }
}

/**
 * 打开一本书（首次会建书）+ 开索引 + 设上下文，返回断开函数。
 * `create=false` 只开不建（同一本书多次操作时用）。
 */
async function openBook(dir: string, name: string, create = true): Promise<() => Promise<void>> {
  const project = create
    ? (await createProject({ rootPath: dir, name, genre: 'xuanhuan' })).project
    : (await openProject(dir)).project
  if (create) {
    await initRepo(dir)
    await commitAll(dir, 'chore: 初始化书籍')
  }
  const db = await openBookIndexDb(dir)
  await setContext({ root: dir, db, project })
  if (create) await reindex(dir, db)
  return async () => {
    await db.$disconnect()
  }
}

const tmp = await mkdtemp(join(tmpdir(), 'inkloom-verify-'))
const book = join(tmp, 'book')

try {
  // ---------------------------------------------------------------- P0-17
  await check('P0-17 建书生成完整文件夹（一本书 = 一个文件夹）', async () => {
    const close = await openBook(book, 'VerifyBook')
    try {
      for (const e of [
        'novel.json',
        'chapters',
        'characters',
        'world',
        'story',
        '.inkloom',
        'README.md',
      ]) {
        if (!existsSync(join(book, e))) throw new Error(`缺少 ${e}`)
      }
      if (!(await stat(join(book, '.inkloom', 'project-id'))).isFile()) {
        throw new Error('缺少身份锚 .inkloom/project-id')
      }
    } finally {
      await close()
    }
  })

  // ---------------------------------------------------------------- P0-19
  await check('P0-19 Git 版本管理：是仓库且有提交', async () => {
    if (!existsSync(join(book, '.git'))) throw new Error('不是 git 仓库')
    const count = await git(book, ['rev-list', '--count', 'HEAD'])
    if (Number(count.trim()) < 1) throw new Error('没有任何 commit')
  })

  // ------------------------------------------------- 要素：append-only + 回退
  const CH = { entityType: 'character' as const, entityId: 'c1', relPath: 'characters/c1.json' }

  await check('P0-9 要素 append-only：写入产生 v1、v2，history 可查', async () => {
    const close = await openBook(book, 'VerifyBook', false)
    try {
      const r1 = await upsertElement({
        ...CH,
        payload: { id: 'c1', name: 'A', role: 'protagonist' },
        changeSource: 'human',
      })
      const r2 = await upsertElement({
        ...CH,
        payload: { id: 'c1', name: 'B', role: 'protagonist' },
        changeSource: 'human',
      })
      if (r1.version !== 1 || r2.version !== 2)
        throw new Error(`版本号不对：${r1.version}, ${r2.version}`)
      const revs = await listElementRevisions('character', 'c1')
      if (revs.length !== 2) throw new Error(`历史应 2 条，实际 ${revs.length}`)
      if (revs[1]?.parentRevisionId !== revs[0]?.id) throw new Error('parent 链断了')
    } finally {
      await close()
    }
  })

  await check('P0-10 要素回退：回退产生新版本，changeSource=rollback，内容回到旧值', async () => {
    const close = await openBook(book, 'VerifyBook', false)
    try {
      const r = await rollbackElement({ ...CH, toVersion: 1 })
      if (r.version !== 3) throw new Error(`回退应产生 v3，实际 v${r.version}`)
      const revs = await listElementRevisions('character', 'c1')
      if (revs[2]?.changeSource !== 'rollback') throw new Error('历史里没有 rollback 留痕')
      const raw = await readFile(join(book, CH.relPath), 'utf8')
      if (!raw.includes('"A"')) throw new Error('文件内容没有回到 v1 的值')
    } finally {
      await close()
    }
  })

  await check('P0-11 软删除：写 deletedAt，原数据保留可恢复', async () => {
    const close = await openBook(book, 'VerifyBook', false)
    try {
      await softDeleteElement(CH)
      const raw = await readFile(join(book, CH.relPath), 'utf8')
      if (!raw.includes('deletedAt')) throw new Error('缺少 deletedAt')
      if (!raw.includes('"A"')) throw new Error('软删除丢了原数据')
    } finally {
      await close()
    }
  })

  // ---------------------------------------------------------------- P0-20
  await check('P0-20 正文不进 revision（revisions 目录无正文类历史）', async () => {
    const dir = bookPaths(book).revisions
    const files = existsSync(dir) ? await readdir(dir) : []
    for (const f of files) {
      if (f.includes('segment') || f.includes('draft')) {
        throw new Error(`revisions 目录出现正文类历史：${f}`)
      }
    }
  })

  // ---------------------------------------------------------------- P0-12
  await check('P0-12 导出 json / md / txt，json 含 project + elements + revisions', async () => {
    for (const fmt of ['json', 'md', 'txt'] as const) {
      const r = await exportBook(fmt, book)
      if (r.content.trim().length === 0) throw new Error(`${fmt} 导出为空`)
      if (!r.filename.endsWith(`.${fmt}`)) throw new Error(`${fmt} 文件名不对：${r.filename}`)
    }
    const j = JSON.parse((await exportBook('json', book)).content) as {
      project?: unknown
      elements?: unknown
      revisions?: unknown
    }
    if (j.project === undefined) throw new Error('JSON 缺 project')
    if (j.elements === undefined) throw new Error('JSON 缺 elements')
    if (j.revisions === undefined) throw new Error('JSON 缺 revisions')
  })

  // ---------------------------------------------------------------- P0-18
  await check('P0-18 索引可重建：删掉 index.sqlite 后 reindex 恢复数据', async () => {
    const dbPath = bookPaths(book).indexDb
    await rm(dbPath, { force: true })
    const db = await openBookIndexDb(book)
    try {
      const report = await reindex(book, db)
      if (report.projects !== 1) throw new Error(`projects 应为 1，实际 ${report.projects}`)
      if (report.revisions < 2)
        throw new Error(`revisions 应从 .jsonl 重建，实际 ${report.revisions}`)
      if (!existsSync(dbPath)) throw new Error('reindex 后 index.sqlite 未生成')
    } finally {
      await db.$disconnect()
    }
  })

  // ------------------------------------------------- P0-10 时间点回退（独立书）
  await check('P0-10 时间点回退：checkpoint + rollback 同时恢复文件与要素历史', async () => {
    const b2 = join(tmp, 'book2')
    const close = await openBook(b2, 'TimePoint')
    try {
      await upsertElement({
        ...CH,
        payload: { id: 'c1', name: 'V1', role: 'protagonist' },
        changeSource: 'human',
      })
      const ck = await createCheckpoint(b2, 'first')
      await upsertElement({
        ...CH,
        payload: { id: 'c1', name: 'V2', role: 'protagonist' },
        changeSource: 'human',
      })
      const r = await rollbackToCheckpoint(b2, ck.id)
      if (!r.truncatedRevisionFiles.some((f) => f.includes('character__c1'))) {
        throw new Error('没有截断要素历史')
      }
      const raw = await readFile(join(b2, CH.relPath), 'utf8')
      if (!raw.includes('V1')) throw new Error('文件没有回到检查点时的内容')
      const revs = await listElementRevisions('character', 'c1')
      if (revs.length !== 1) throw new Error(`要素历史应回退到 1 条，实际 ${revs.length}`)
      const all = await readCheckpoints(b2)
      if (!all.some((c) => c.label.includes('回退到'))) throw new Error('回退本身没有留痕')
    } finally {
      await close()
    }
  })

  // ---------------------------------------------------------------- P0-22
  await check('P0-22 章节号只允许末尾追加（蓝图章号连续无空洞）', async () => {
    const dir = bookPaths(book).story
    const files = existsSync(join(dir, 'blueprints')) ? await readdir(join(dir, 'blueprints')) : []
    const nos = files
      .map((n) => /^ch-(\d+)\.json$/.exec(n)?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number)
      .sort((a, b) => a - b)
    for (let i = 1; i < nos.length; i++) {
      if ((nos[i] as number) - (nos[i - 1] as number) > 1) {
        throw new Error(`章号不连续：${nos.join(',')}`)
      }
    }
  })

  // ---------------------------------------------------------------- P0-21
  await check('P0-21 并发串行：10 个并发写入产生 10 个连续版本', async () => {
    const b3 = join(tmp, 'book3')
    const close = await openBook(b3, 'Concurrency')
    try {
      const jobs = Array.from({ length: 10 }, (_, i) =>
        upsertElement({
          ...CH,
          payload: { id: 'c1', name: `N${i}`, role: 'protagonist' },
          changeSource: 'human',
        }),
      )
      const rs = await Promise.all(jobs)
      const versions = rs.map((r) => r.version).sort((a, b) => a - b)
      const expected = Array.from({ length: 10 }, (_, i) => i + 1)
      if (JSON.stringify(versions) !== JSON.stringify(expected)) {
        throw new Error(`版本号不是 1..10：${versions.join(',')}`)
      }
      const revs = await listElementRevisions('character', 'c1')
      if (revs.length !== 10) throw new Error(`历史应 10 条，实际 ${revs.length}`)
    } finally {
      await close()
    }
  })
} finally {
  await rm(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.error('\n未通过：')
  for (const f of failed) console.error(`  ✗ ${f.name}\n    ${f.err}`)
  process.exit(1)
}
console.log('✓ P0 验收全部通过')
