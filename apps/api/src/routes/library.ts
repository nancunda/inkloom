import { basename } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { createLibraryBook, listBooks, resolveLibraryRoot } from '../library/library.js'
import { closeBook, switchBook } from '../library/open-book.js'
import { peekContext } from '../services/context.js'

export const libraryRoutes = new Hono()

function currentBook(): { folder: string; rootPath: string; name: string } | null {
  const ctx = peekContext()
  if (ctx === null) return null
  return { folder: basename(ctx.root), rootPath: ctx.root, name: ctx.project.name }
}

libraryRoutes.get('/library', async (c) => {
  const libraryRoot = resolveLibraryRoot()
  const books = await listBooks(libraryRoot)
  return c.json({ libraryRoot, current: currentBook(), books })
})

libraryRoutes.post('/library/open', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { folder?: unknown } | null
  const folder = typeof body?.folder === 'string' ? body.folder.trim() : ''
  if (folder.length === 0) throw new InkloomError('INVALID_INPUT', 'folder 不能为空')
  await switchBook(resolveLibraryRoot(), folder)
  return c.json({ current: currentBook() })
})

libraryRoutes.post('/library/create', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown
    genre?: unknown
    totalChapters?: unknown
    wordsPerChapter?: unknown
  } | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const genre = typeof body?.genre === 'string' ? body.genre.trim() : ''
  const totalChapters = typeof body?.totalChapters === 'number' ? body.totalChapters : undefined
  const wordsPerChapter =
    typeof body?.wordsPerChapter === 'number' ? body.wordsPerChapter : undefined
  const created = await createLibraryBook(resolveLibraryRoot(), {
    name,
    genre,
    ...(totalChapters === undefined ? {} : { totalChapters }),
    ...(wordsPerChapter === undefined ? {} : { wordsPerChapter }),
  })
  await switchBook(resolveLibraryRoot(), created.folder)
  return c.json({ current: currentBook(), folder: created.folder })
})

libraryRoutes.post('/library/close', async (c) => {
  await closeBook()
  return c.json({ current: null })
})
