import { InkloomError, type Project } from '@inkloom/shared'
import type { IndexDb } from '../index-db/client.js'

export interface AppContext {
  root: string
  db: IndexDb
  project: Project
}

let current: AppContext | null = null

/**
 * 设置当前打开的书。
 *
 * ★ 必须同时保证索引里有 Project 行：Character / Blueprint 等表都有外键
 *   指向 Project，父行不存在时 syncElement 会因外键约束失败——而那条失败
 *   路径是"只告警不回滚"的，症状是"写完要素后索引里查不到"，极难排查。
 */
export async function setContext(ctx: AppContext): Promise<void> {
  current = ctx
  await ctx.db.project.upsert({
    where: { id: ctx.project.id },
    create: {
      id: ctx.project.id,
      folderId: ctx.project.folderId,
      rootPath: ctx.root.split('\\').join('/'),
      name: ctx.project.name,
      genre: ctx.project.genre,
      status: ctx.project.status,
    },
    update: { rootPath: ctx.root.split('\\').join('/'), name: ctx.project.name },
  })
}

export function getContext(): AppContext {
  if (current === null) {
    throw new InkloomError('NOT_FOUND', '尚未打开任何书，请先调用 POST /api/library/open')
  }
  return current
}

/** 不抛错的只读访问器：书库页与空态判断用 */
export function peekContext(): AppContext | null {
  return current
}

/**
 * 关闭当前书：先清指针再断开索引连接，返回旧 context。
 *
 * ★ 断开连接必须在这里做：Windows 上被句柄钉住的 index.sqlite 删不掉，
 *   切书时若只切指针，旧库会一直活着（EBUSY）。
 */
export async function closeContext(): Promise<AppContext | null> {
  const prev = current
  current = null
  if (prev !== null) await prev.db.$disconnect()
  return prev
}

export function clearContext(): void {
  current = null
}
