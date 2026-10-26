import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
 * ★ 必须用**包内的** prisma CLI，不能依赖全局 pnpm：便携发行包里
 *   没有 pnpm，`pnpm exec prisma` 会直接报「'prisma' 不是内部或外部命令」。
 * ★ schema 路径也要探测：开发时在 apps/api/prisma，发行包里在 app/prisma。
 */
function runMigrate(dbPath: string): void {
  // ★ 同样必须 resolve：Prisma CLI 的 file: 相对路径也按 schema 目录解析
  const url = `file:${resolve(dbPath).split('\\').join('/')}`
  const localSchema = join(API_DIR, 'prisma', 'schema.prisma')
  const schema = existsSync(localSchema)
    ? localSchema
    : join(API_DIR, '..', '..', 'prisma', 'schema.prisma')
  const args = ['migrate', 'deploy', '--schema', schema]
  const env = { ...process.env, INKLOOM_DATABASE_URL: url }

  // ★ 不用 require.resolve('prisma')：它的 package.json 不保证暴露
  //   build/index.js，resolve 失败就会静默回退到 pnpm（发行包里没有 pnpm）。
  //   直接按两个可能的位置找文件，最直白也最可靠。
  const cli =
    [
      join(API_DIR, 'node_modules/prisma/build/index.js'),
      join(API_DIR, '..', '..', 'node_modules/prisma/build/index.js'),
    ].find((p) => existsSync(p)) ?? null
  if (cli !== null) {
    const quoted = args.map((a) => `"${a}"`).join(' ')
    execSync(`"${process.execPath}" "${cli}" ${quoted}`, { cwd: API_DIR, env, stdio: 'pipe' })
    return
  }
  execSync(`pnpm exec prisma ${args.map((a) => `"${a}"`).join(' ')}`, {
    cwd: API_DIR,
    env,
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
