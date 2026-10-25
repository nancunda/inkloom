import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

export type IndexDb = PrismaClient

/**
 * 打开某一本书的索引数据库（可丢弃的派生层）。
 *
 * 每个书根目录对应一个 `.inkloom/index.sqlite`，所以用 openIndexDb 而不是全局单例。
 *
 * ★ 必须先 resolve 成绝对路径：Prisma 的 `file:` 相对路径是相对于
 *   **schema 文件所在目录**（apps/api/prisma/），不是进程 cwd。
 *   直接用相对路径会得到 `file:fixtures/qixia/...`，Prisma 会去
 *   apps/api/prisma/fixtures/… 找，报 “Unable to open the database file”。
 * ★ Windows 路径必须转成正斜杠：`file:D:\a\b.sqlite` 会被解析成主机名 D。
 */
export async function openIndexDb(sqlitePath: string): Promise<IndexDb> {
  const url = `file:${resolve(sqlitePath).split('\\').join('/')}`
  const client = new PrismaClient({ datasources: { db: { url } } })
  await client.$connect()
  // spec §2.6 并发控制：WAL 让读写不互相阻塞，busy_timeout 让并发写等待而不是立刻失败。
  // ★ PRAGMA 会返回结果集，必须用 $queryRawUnsafe（$executeRawUnsafe 会报错）。
  await client.$queryRawUnsafe('PRAGMA journal_mode=WAL')
  await client.$queryRawUnsafe('PRAGMA busy_timeout=5000')
  return client
}
