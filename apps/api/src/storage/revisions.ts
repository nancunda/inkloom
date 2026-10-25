import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RevisionRecord } from '@inkloom/core'
import { atomicWrite, readIfExists } from './atomic-write.js'
import { bookPaths } from './paths.js'

/** 非法路径字符替换，防止 entityId 逃出 revisions 目录 */
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function revisionFileRelPath(entityType: string, entityId: string): string {
  return `.inkloom/revisions/${sanitize(entityType)}__${sanitize(entityId)}.jsonl`
}

function absPath(root: string, entityType: string, entityId: string): string {
  return join(root, revisionFileRelPath(entityType, entityId))
}

/** 解析 revision 文件的相对路径 → (entityType, entityId) */
export function parseRevisionRelPath(rel: string): { entityType: string; entityId: string } | null {
  const name = rel.replace('.inkloom/revisions/', '').replace('.jsonl', '')
  const sep = name.indexOf('__')
  if (sep < 0) return null
  return { entityType: name.slice(0, sep), entityId: name.slice(sep + 2) }
}

/**
 * 追加一条 revision（spec §2.6 写入顺序 步骤 3）。
 *
 * ★ 必须早于索引更新：索引是可丢弃的派生层，历史是不可删的事实源。
 * ★ 必须在单一写队列内调用：version 单调性靠串行保证（文件系统无唯一约束）。
 */
export async function appendRevision(root: string, rec: RevisionRecord): Promise<void> {
  const p = absPath(root, rec.entityType, rec.entityId)
  await mkdir(bookPaths(root).revisions, { recursive: true })
  await appendFile(p, `${JSON.stringify(rec)}\n`, 'utf8')
}

/** 读取某实体的全部 revision。损坏行跳过（JSONL 逐行容错） */
export async function readRevisions(
  root: string,
  entityType: string,
  entityId: string,
): Promise<RevisionRecord[]> {
  const raw = await readIfExists(absPath(root, entityType, entityId))
  if (raw === null) return []
  const out: RevisionRecord[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.length === 0) continue
    try {
      out.push(JSON.parse(t) as RevisionRecord)
    } catch {
      // 跳过损坏行：宁可少一条，也不要整本历史读不出来
    }
  }
  return out
}

export async function lastRevision(
  root: string,
  entityType: string,
  entityId: string,
): Promise<RevisionRecord | null> {
  const list = await readRevisions(root, entityType, entityId)
  return list.length === 0 ? null : (list[list.length - 1] as RevisionRecord)
}

export async function countRevisionLines(
  root: string,
  entityType: string,
  entityId: string,
): Promise<number> {
  const raw = await readIfExists(absPath(root, entityType, entityId))
  if (raw === null) return 0
  return raw.split('\n').filter((l) => l.trim().length > 0).length
}

/**
 * 截断到指定行数（时间点回退用，spec §2.7 五）。
 * ★ 必须与 `git checkout <ref>` 在同一事务语义内执行，
 *   否则会出现「正文回到第 7 章、角色状态还在第 12 章」。
 */
export async function truncateRevisions(
  root: string,
  entityType: string,
  entityId: string,
  keepLines: number,
): Promise<void> {
  const list = await readRevisions(root, entityType, entityId)
  const kept = list.slice(0, Math.max(0, keepLines))
  const content = kept.length === 0 ? '' : `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`
  await atomicWrite(absPath(root, entityType, entityId), content)
}

/** 列出所有 revision 文件（相对书根的 POSIX 路径），reindex 用 */
export async function readAllRevisionFiles(root: string): Promise<string[]> {
  const dir = bookPaths(root).revisions
  try {
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith('.jsonl')).map((n) => `.inkloom/revisions/${n}`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/** 读单个 revision 文件的原始内容（reindex 时按行解析） */
export async function readRevisionFileRaw(root: string, relPath: string): Promise<string> {
  return readFile(join(root, relPath), 'utf8')
}
