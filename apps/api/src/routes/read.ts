import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { diffText, summarizeDiff } from '@inkloom/core'
import { blueprintSchema, InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { getContext } from '../services/context.js'
import { listChapterScenes } from '../services/scene-review-service.js'
import { readJsonElement } from '../storage/elements.js'
import { bookPaths } from '../storage/paths.js'
import { listSceneVersions, readSceneFile } from '../storage/scenes.js'

export const read = new Hono()

/** 路径参数必须是正整数，否则 400（由 app.onError 转换） */
function intParam(raw: string | undefined, name: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new InkloomError('INVALID_INPUT', `${name} 必须是正整数，收到 ${String(raw)}`)
  }
  return n
}

interface BlueprintLite {
  chapterNo: number
  title: string | null
  goal: string
  conflict: string
  tensionLevel: number
  beatType: string
}

/**
 * 扫蓝图目录。
 *
 * ★ 章节列表必须以蓝图为准：Chapter 表只有定稿/审阅过的章才有行，
 *   用它渲染左侧列表的话，还没生成的章会直接消失。
 */
async function listBlueprints(): Promise<BlueprintLite[]> {
  const { root } = getContext()
  const dir = join(bookPaths(root).story, 'blueprints')
  const names = await readdir(dir).catch(() => [] as string[])

  const chapters: BlueprintLite[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const raw = await readJsonElement(root, `story/blueprints/${name}`)
    if (raw === null) continue
    const parsed = blueprintSchema.safeParse(raw)
    if (!parsed.success) continue
    const b = parsed.data
    chapters.push({
      chapterNo: b.chapterNo,
      title: b.title ?? null,
      goal: b.goal,
      conflict: b.conflict,
      tensionLevel: b.tensionLevel,
      beatType: b.beatType,
    })
  }
  return chapters.sort((a, b) => a.chapterNo - b.chapterNo)
}

interface BookChapterRow {
  chapterNo: number
  title: string | null
  status: string
  wordCount: number
  summary: string | null
  finalizedAt: string | null
}

read.get('/book', async (c) => {
  const { project, db } = getContext()
  const [chapters, bps, draftChapters] = await Promise.all([
    db.chapter.findMany({
      where: { projectId: project.id },
      select: {
        chapterNo: true,
        title: true,
        status: true,
        wordCount: true,
        summary: true,
        finalizedAt: true,
      },
    }),
    listBlueprints(),
    // 哪些章已经有候选场景（没定稿就没有 Chapter 行，但它的场景是有的）
    db.draftSegment.findMany({
      where: { projectId: project.id },
      select: { chapterNo: true },
      distinct: ['chapterNo'],
    }),
  ])

  const drafted = new Set(draftChapters.map((r) => r.chapterNo))

  // ★ 章节集合 = Chapter 行 ∪ 蓝图，而不是「以蓝图为准」。
  //   导入的正文只有 ch-NNN.md 与 Chapter 行，没有蓝图；只认同蓝图的话，
  //   界面会把刚导入的三章说成「0 章」——文件是唯一真相，这里不能例外。
  // ★ 没有 Chapter 行也不代表没写：生成了候选稿就是 drafting，
  //   否则界面会把「有 5 张待审场景卡」的章说成「计划中」。
  const byNo = new Map<number, BookChapterRow>()
  for (const ch of chapters) {
    byNo.set(ch.chapterNo, {
      chapterNo: ch.chapterNo,
      title: ch.title,
      status: ch.status,
      wordCount: ch.wordCount,
      summary: ch.summary,
      finalizedAt: ch.finalizedAt?.toISOString() ?? null,
    })
  }
  for (const b of bps) {
    const existing = byNo.get(b.chapterNo)
    if (existing === undefined) {
      byNo.set(b.chapterNo, {
        chapterNo: b.chapterNo,
        title: b.title,
        status: drafted.has(b.chapterNo) ? 'drafting' : 'planned',
        wordCount: 0,
        summary: null,
        finalizedAt: null,
      })
    } else if (existing.title === null && b.title !== null) {
      // 正文没写标题时用蓝图标题补上（不覆盖正文里的标题）
      existing.title = b.title
    }
  }
  const merged = [...byNo.values()].sort((a, b) => a.chapterNo - b.chapterNo)

  return c.json({ ...project, chapters: merged })
})

read.get('/chapters/:n', async (c) => {
  const chapterNo = intParam(c.req.param('n'), 'chapterNo')
  const { db, project } = getContext()
  const [chapter, scenes] = await Promise.all([
    db.chapter.findUnique({
      where: { projectId_chapterNo: { projectId: project.id, chapterNo } },
    }),
    listChapterScenes(chapterNo),
  ])
  return c.json({
    chapterNo,
    title: chapter?.title ?? null,
    // ★ 同 /book：没定稿过的章没有 Chapter 行，但有场景就是 drafting
    status: chapter?.status ?? (scenes.length > 0 ? 'drafting' : 'planned'),
    wordCount: chapter?.wordCount ?? 0,
    summary: chapter?.summary ?? null,
    scenes,
  })
})

read.get('/chapters/:n/scenes/:sceneNo', async (c) => {
  const chapterNo = intParam(c.req.param('n'), 'chapterNo')
  const sceneNo = intParam(c.req.param('sceneNo'), 'sceneNo')
  const { root } = getContext()

  const versionRaw = c.req.query('version')
  let version: number
  if (versionRaw === undefined) {
    const all = await listSceneVersions(root, chapterNo, sceneNo)
    if (all.length === 0) {
      throw new InkloomError('NOT_FOUND', `第 ${chapterNo} 章场景 ${sceneNo} 还没有任何版本`)
    }
    version = Math.max(...all)
  } else {
    version = intParam(versionRaw, 'version')
  }

  const scene = await readSceneFile(root, chapterNo, sceneNo, version)
  if (scene === null) {
    throw new InkloomError('NOT_FOUND', `第 ${chapterNo} 章场景 ${sceneNo} v${version} 不存在`)
  }
  return c.json({ sceneNo, version, segments: scene.segments })
})

read.get('/chapters/:n/scenes/:sceneNo/diff', async (c) => {
  const chapterNo = intParam(c.req.param('n'), 'chapterNo')
  const sceneNo = intParam(c.req.param('sceneNo'), 'sceneNo')
  const from = intParam(c.req.query('from'), 'from')
  const to = intParam(c.req.query('to'), 'to')
  const { root } = getContext()

  const a = await readSceneFile(root, chapterNo, sceneNo, from)
  const b = await readSceneFile(root, chapterNo, sceneNo, to)
  if (a === null || b === null) {
    throw new InkloomError('NOT_FOUND', `场景 ${sceneNo} 的 v${a === null ? from : to} 不存在`)
  }
  const spans = diffText(
    a.segments.map((s) => s.text).join('\n\n'),
    b.segments.map((s) => s.text).join('\n\n'),
  )
  return c.json({ ...summarizeDiff(spans), spans })
})

read.get('/blueprints', async (c) => {
  return c.json({ chapters: await listBlueprints() })
})
