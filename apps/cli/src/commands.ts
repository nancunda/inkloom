import { writeFile } from 'node:fs/promises'
import type { EntityType } from '@inkloom/core'
import { commitAll, initRepo } from '../../api/src/git/runner.js'
import { openBookIndexDb } from '../../api/src/index-db/open-book.js'
import { setContext } from '../../api/src/services/context.js'
import {
  listElementRevisions,
  rollbackElement,
  upsertElement,
} from '../../api/src/services/element-service.js'
import { type ExportFormat, exportBook } from '../../api/src/services/export-service.js'
import { softDeleteElement } from '../../api/src/services/invariant-service.js'
import {
  createCheckpoint,
  readCheckpoints,
  rollbackToCheckpoint,
} from '../../api/src/storage/checkpoints.js'
import { bookPaths } from '../../api/src/storage/paths.js'
import { createProject, openProject } from '../../api/src/storage/project.js'
import { reindex } from '../../api/src/storage/reindex.js'
import { requireFlag, requirePositional } from './flags.js'

/**
 * 打开一本书并执行 fn，结束时断开索引连接。
 * ★ 必须走 setContext：它会保证索引里有 Project 行（外键约束的前提）。
 */
async function withBook<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const opened = await openProject(dir)
  await initRepo(dir)
  const db = await openBookIndexDb(dir)
  try {
    await setContext({ root: dir, db, project: opened.project })
    return await fn()
  } finally {
    await db.$disconnect()
  }
}

export interface CommandCtx {
  positional: string[]
  flags: Record<string, string>
}

/** inkloom create <dir> --name <书名> --genre <题材> */
export async function create({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom create <dir> --name <书名> --genre <题材>')
  const created = await createProject({
    rootPath: dir,
    name: requireFlag(flags, 'name'),
    genre: requireFlag(flags, 'genre'),
  })
  await initRepo(dir)
  // 建书即产生第一个 commit，否则 git log / checkpoint 都没有基线可回
  await commitAll(dir, `chore: 初始化书籍 ${created.project.name}`)
  const db = await openBookIndexDb(dir)
  await reindex(dir, db)
  await db.$disconnect()
  console.log(`✓ 建书完成：${created.project.name}（${dir}）`)
  console.log(`  folderId = ${created.folderId}`)
}

/** inkloom reindex <dir> */
export async function reindexCmd({ positional }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom reindex <dir>')
  await withBook(dir, async () => {
    const opened = await openProject(dir)
    const db = await openBookIndexDb(dir)
    try {
      const report = await reindex(dir, db)
      console.log('✓ 索引重建完成')
      for (const [k, v] of Object.entries(report)) {
        if (k !== 'warnings') console.log(`  ${k}: ${String(v)}`)
      }
      for (const w of report.warnings) console.warn(`  ⚠ ${w}`)
    } finally {
      await db.$disconnect()
    }
    void opened
  })
}

/** inkloom element set <dir> --type <t> --id <id> --rel <path> --json <json> */
export async function elementSet({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom element set <dir> --type <t> --id <id> --rel <path> --json <json>',
  )
  const payload: unknown = JSON.parse(requireFlag(flags, 'json'))
  const r = await withBook(dir, () =>
    upsertElement({
      entityType: requireFlag(flags, 'type') as EntityType,
      entityId: requireFlag(flags, 'id'),
      relPath: requireFlag(flags, 'rel'),
      payload,
      changeSource: 'human',
      ...(flags['reason'] === undefined ? {} : { changeReason: flags['reason'] }),
    }),
  )
  console.log(`✓ 已写入 v${r.version}`)
}

/** inkloom element rollback <dir> --type <t> --id <id> --rel <path> --to <version> */
export async function elementRollback({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom element rollback <dir> --type <t> --id <id> --rel <path> --to <version>',
  )
  const r = await withBook(dir, () =>
    rollbackElement({
      entityType: requireFlag(flags, 'type') as EntityType,
      entityId: requireFlag(flags, 'id'),
      relPath: requireFlag(flags, 'rel'),
      toVersion: Number(requireFlag(flags, 'to')),
    }),
  )
  console.log(`✓ 已回退，产生新版本 v${r.version}`)
}

/** inkloom element delete <dir> --type <t> --id <id> --rel <path> */
export async function elementDelete({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom element delete <dir> --type <t> --id <id> --rel <path>',
  )
  const r = await withBook(dir, () =>
    softDeleteElement({
      entityType: requireFlag(flags, 'type') as EntityType,
      entityId: requireFlag(flags, 'id'),
      relPath: requireFlag(flags, 'rel'),
    }),
  )
  console.log(`✓ 已软删除（v${r.version}），数据保留可恢复`)
}

/** inkloom element history <dir> --type <t> --id <id> */
export async function elementHistory({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom element history <dir> --type <t> --id <id>')
  const revs = await withBook(dir, () =>
    listElementRevisions(requireFlag(flags, 'type') as EntityType, requireFlag(flags, 'id')),
  )
  console.log(`共 ${revs.length} 个版本：`)
  for (const r of revs) {
    console.log(`  v${r.version}  ${r.changeSource}  ${r.changeReason ?? ''}  ${r.createdAt}`)
  }
}

/** inkloom export <dir> --format json|md|txt [--out <file>] */
export async function exportCmd({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom export <dir> --format json|md|txt [--out <file>]',
  )
  const format = requireFlag(flags, 'format') as ExportFormat
  if (format !== 'json' && format !== 'md' && format !== 'txt') {
    throw new Error('--format 只能是 json / md / txt')
  }
  await openProject(dir) // 校验是合法书
  const r = await exportBook(format, dir)
  const out = flags['out'] ?? r.filename
  await writeFile(out, r.content, 'utf8')
  console.log(`✓ 已导出：${out}（${r.content.length} 字符）`)
}

/** inkloom checkpoint <dir> --label <说明> */
export async function checkpoint({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom checkpoint <dir> --label <说明>')
  await openProject(dir)
  const ck = await createCheckpoint(dir, requireFlag(flags, 'label'))
  const all = await readCheckpoints(dir)
  console.log(`✓ 检查点已建：${ck.id}  ${ck.label}  git=${ck.gitRef ?? 'none'}`)
  console.log(`  当前共 ${all.length} 个检查点`)
}

/** inkloom rollback <dir> --to <checkpointId> */
export async function rollbackCmd({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom rollback <dir> --to <checkpointId>')
  await openProject(dir)
  const id = requireFlag(flags, 'to')
  const all = await readCheckpoints(dir)
  const target = all.find((c) => c.id === id)
  if (target === undefined) {
    throw new Error(
      `检查点 ${id} 不存在。可用：${all.map((c) => `${c.id}(${c.label})`).join(', ')}`,
    )
  }
  const r = await rollbackToCheckpoint(dir, id)
  console.log(`✓ 已回退到 ${target.label}`)
  console.log(`  恢复路径：${r.restoredPaths.join(', ') || '（无）'}`)
  console.log(`  截断历史：${r.truncatedRevisionFiles.join(', ') || '（无）'}`)
  for (const w of r.warnings) console.warn(`  ⚠ ${w}`)
}

/** inkloom checkpoints <dir> */
export async function listCheckpoints({ positional }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom checkpoints <dir>')
  await openProject(dir)
  const all = await readCheckpoints(dir)
  if (all.length === 0) {
    console.log('（还没有检查点）')
    return
  }
  for (const c of all) console.log(`${c.id}  ${c.label}  ${c.createdAt}  git=${c.gitRef ?? 'none'}`)
}
