import { randomUUID } from 'node:crypto'
import type { IndexDb } from '../index-db/client.js'
import type { ExtractResult } from '../search/extract.js'
import type { SearchHit } from '../search/types.js'

export interface LoreView {
  id: string
  title: string
  url: string
  snippet: string
  content: string | null
  provider: string
}

function newId(): string {
  return `lr-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function runIdsOf(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export async function saveSearchHits(
  db: IndexDb,
  projectId: string,
  runId: string,
  query: string,
  hits: SearchHit[],
): Promise<{ id: string; title: string; url: string }[]> {
  const out: { id: string; title: string; url: string }[] = []
  for (const hit of hits) {
    const id = newId()
    await db.loreReference.create({
      data: {
        id,
        projectId,
        query,
        provider: hit.provider,
        title: hit.title,
        url: hit.url,
        snippet: hit.snippet,
        content: null,
        usedInRunIds: JSON.stringify([runId]),
        approved: false,
      },
    })
    out.push({ id, title: hit.title, url: hit.url })
  }
  return out
}

export async function savePage(
  db: IndexDb,
  projectId: string,
  runId: string,
  page: ExtractResult,
): Promise<{ id: string }> {
  const id = newId()
  await db.loreReference.create({
    data: {
      id,
      projectId,
      query: page.url,
      provider: 'url',
      title: page.title,
      url: page.url,
      snippet: page.text.slice(0, 300),
      content: page.text,
      usedInRunIds: JSON.stringify([runId]),
      approved: false,
    },
  })
  return { id }
}

export async function getLoreForRun(
  db: IndexDb,
  id: string,
  runId: string,
): Promise<LoreView | null> {
  const row = await db.loreReference.findUnique({ where: { id } })
  if (row === null) return null
  if (!row.approved && !runIdsOf(row.usedInRunIds).includes(runId)) return null
  return {
    id: row.id,
    title: row.title ?? '',
    url: row.url ?? '',
    snippet: row.snippet ?? '',
    content: row.content,
    provider: row.provider,
  }
}

export async function listLore(
  db: IndexDb,
  projectId: string,
  opts: { approved?: boolean; q?: string; limit?: number } = {},
): Promise<LoreView[]> {
  const rows = await db.loreReference.findMany({
    where: {
      projectId,
      ...(opts.approved === undefined ? {} : { approved: opts.approved }),
      ...(opts.q === undefined || opts.q.length === 0 ? {} : { title: { contains: opts.q } }),
    },
    orderBy: { fetchedAt: 'desc' },
    take: opts.limit ?? 50,
  })
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? '',
    url: row.url ?? '',
    snippet: row.snippet ?? '',
    content: row.content,
    provider: row.provider,
  }))
}

export async function approveLore(db: IndexDb, id: string): Promise<LoreView | null> {
  const row = await db.loreReference.update({ where: { id }, data: { approved: true } })
  return {
    id: row.id,
    title: row.title ?? '',
    url: row.url ?? '',
    snippet: row.snippet ?? '',
    content: row.content,
    provider: row.provider,
  }
}

export async function deleteLore(db: IndexDb, id: string): Promise<void> {
  const row = await db.loreReference.findUnique({ where: { id } })
  if (row === null) throw new Error('NOT_FOUND')
  if (row.approved) throw new Error('已批准的资料卡不能删除')
  await db.loreReference.delete({ where: { id } })
}
