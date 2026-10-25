import { execSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { bookPaths } from '../storage/paths.js'
import { type IndexDb, openIndexDb } from './client.js'

/**
 * `apps/api` 的绝对路径。
 * 本文件位于 `apps/api/src/index-db/`，向上两级即包根。
 */
const API_DIR = join(import.meta.dirname, '..', '..')

const migrated = new Set<string>()

/** 索引库是否已经有表（用最小的一条查询探测） */
async function hasSchema(db: IndexDb): Promise<boolean> {
  try {
    await db.$queryRawUnsafe('SELECT 1 FROM Project LIMIT 1')
    return true
  } catch {
    return false
  }
}
/**
 * 跑一次 Prisma 迁移（幂等：已是最新则跳过）。
 *
 * ★ 为什么用子进程：Prisma 没有公开的编程式 migrate API。
 *   `migrate deploy` 是幂等的，重复执行安全。
 *   P1 做发布版时应改为内嵌 migration.sql 直接执行，摆脱对 prisma CLI 的运行时依赖。
 */
function runMigrate(dbPath: string): void {
  // ★ 同样必须 resolve：Prisma CLI 的 file: 相对路径也按 schema 目录解析
  const url = `file:${resolve(dbPath).split('\\').join('/')}`
  execSync('pnpm exec prisma migrate deploy', {
    cwd: API_DIR,
    env: { ...process.env, INKLOOM_DATABASE_URL: url },
    stdio: 'pipe',
  })
}

/**
 * 打开一本书的索引库，必要时先建表。
 *
 * ★ 这是生产路径的唯一入口：`openIndexDb` 只负责连接，
 *   新建的书索引文件是空的，直接用会报 `The table main.Project does not exist`。
 *
 * ★ 不做「已迁移」缓存：缓存假设库文件不会被删，而 P0-18 的核心验收
 *   恰恰是「删掉 index.sqlite 后 reindex 能救回来」。探测成本是一次 SELECT，可忽略。
 */
export async function openBookIndexDb(bookRoot: string): Promise<IndexDb> {
  const dbPath = bookPaths(bookRoot).indexDb

  let db = await openIndexDb(dbPath)
  if (await hasSchema(db)) return db

  await db.$disconnect()
  runMigrate(dbPath)
  migrated.add(dbPath)
  db = await openIndexDb(dbPath)
  return db
}
