import { readdir, readFile } from 'node:fs/promises'
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

interface RelationRow {
  id: string
  fromId: string
  toId: string
  kind: string
  strength: number
  sinceChapter?: number
  untilChapter?: number
  note?: string
}

/**
 * 关系网络（spec 视图 2）。
 *
 * ★ `?chapter=N` 是时间滑块的后端：只返回第 N 章时仍然成立的关系。
 *   盟友变敌人的过程一拖就看出来——这是 spec 里点名的杀手功能。
 */
read.get('/relations', async (c) => {
  const raw = c.req.query('chapter')
  const chapterNo = raw === undefined || raw.length === 0 ? null : intParam(raw, 'chapter')
  const { root } = getContext()

  const [charRaw, relRaw] = await Promise.all([
    readJsonElement(root, 'characters/index.json'),
    readJsonElement(root, 'characters/relations.json'),
  ])

  const chars = Array.isArray(charRaw)
    ? (charRaw as { id?: unknown; name?: unknown; role?: unknown }[])
    : []
  const nodes = chars
    .filter((x) => typeof x.id === 'string')
    .map((x) => ({
      id: String(x.id),
      name: typeof x.name === 'string' ? x.name : String(x.id),
      role: typeof x.role === 'string' ? x.role : 'supporting',
    }))

  const rels = Array.isArray(relRaw) ? (relRaw as RelationRow[]) : []
  const edges = rels
    .filter((r) => typeof r.fromId === 'string' && typeof r.toId === 'string')
    .filter((r) => {
      if (chapterNo === null) return true
      const since = r.sinceChapter ?? 0
      const until = r.untilChapter ?? Number.POSITIVE_INFINITY
      return since <= chapterNo && chapterNo <= until
    })

  return c.json({ chapterNo, nodes, edges })
})

read.get('/assets', async (c) => {
  const { root } = getContext()
  const dir = join(bookPaths(root).assets, 'characters')
  const names = await readdir(dir).catch(() => [] as string[])
  const files = names.filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
  return c.json({
    characters: files.map((name) => ({
      ownerId: name.replace(/\.[a-z]+$/i, ''),
      filePath: `assets/characters/${name}`,
    })),
  })
})

/** 素材二进制（图廊用）；只允许 assets/ 下的路径，防目录穿越 */
read.get('/assets/file', async (c) => {
  const { root } = getContext()
  const rel = c.req.query('path') ?? ''
  if (!rel.startsWith('assets/') || rel.includes('..')) {
    throw new InkloomError('INVALID_INPUT', 'path 必须是 assets/ 下的文件')
  }
  const abs = join(root, rel)
  const buf = await readFile(abs).catch(() => null)
  if (buf === null) throw new InkloomError('NOT_FOUND', `文件不存在：${rel}`)
  const type = rel.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
  return c.body(buf, 200, { 'content-type': type, 'cache-control': 'no-cache' })
})

read.get('/overview', async (c) => {
  const { root, db, project } = getContext()
  const [chapters, bps, threadRaw, runs, draftedRows] = await Promise.all([
    db.chapter.findMany({
      where: { projectId: project.id },
      select: { chapterNo: true, title: true, status: true, wordCount: true },
    }),
    listBlueprints(),
    readJsonElement(root, 'story/threads.json'),
    db.generationRun.findMany({ where: { projectId: project.id }, select: { status: true } }),
    // 有候选场景但没定稿的章，在概览里也应显示为「草稿」而不是「计划中」
    db.draftSegment.findMany({
      where: { projectId: project.id },
      select: { chapterNo: true },
      distinct: ['chapterNo'],
    }),
  ])
  const drafted = new Set(draftedRows.map((r) => r.chapterNo))

  const wordsPerChapter = 3000
  const merged = bps.map((b) => {
    const ch = chapters.find((x) => x.chapterNo === b.chapterNo)
    return {
      chapterNo: b.chapterNo,
      title: b.title,
      status: ch?.status ?? (drafted.has(b.chapterNo) ? 'drafting' : 'planned'),
      wordCount: ch?.wordCount ?? 0,
      tensionLevel: b.tensionLevel,
      beatType: b.beatType,
    }
  })
  const done = merged.filter((m) => m.status === 'finalized').length
  const words = merged.reduce((n, m) => n + m.wordCount, 0)

  const threads = (Array.isArray(threadRaw) ? threadRaw : []) as {
    status?: unknown
    payoffWindow?: unknown
    advancedChapters?: unknown
  }[]
  const active = threads.filter((t) => t.status === 'active')
  const lastNo = merged.length > 0 ? Math.max(...merged.map((m) => m.chapterNo)) : 0
  const overdue = active.filter(
    (t) => typeof t.payoffWindow === 'number' && lastNo >= t.payoffWindow,
  ).length

  return c.json({
    chapters: merged,
    stats: {
      total: merged.length,
      finalized: done,
      words,
      wordsPerChapter,
      progress: merged.length === 0 ? 0 : done / merged.length,
    },
    threads: { total: threads.length, active: active.length, overdue },
    runs: { total: runs.length, failed: runs.filter((r) => r.status === 'failed').length },
  })
})

interface ThreadRow {
  id?: unknown
  kind?: unknown
  title?: unknown
  description?: unknown
  plantedChapter?: unknown
  advancedChapters?: unknown
  resolvedChapter?: unknown
  status?: unknown
  payoffHint?: unknown
  payoffWindow?: unknown
}

/**
 * 线索轨迹（spec 视图 3 的「横向线 = 伏笔生命周期」）。
 *
 * ★ overdue 在服务端算：前端不该自己拿「当前最大章号」和 payoffWindow
 *   比大小——两边各算一次，迟早不一致。
 */
read.get('/threads', async (c) => {
  const { root, db, project } = getContext()
  const [raw, last] = await Promise.all([
    readJsonElement(root, 'story/threads.json'),
    db.chapter.findFirst({ where: { projectId: project.id }, orderBy: { chapterNo: 'desc' } }),
  ])
  const currentChapter = last?.chapterNo ?? 0

  const list = Array.isArray(raw) ? (raw as ThreadRow[]) : []
  const threads = list
    .filter((t) => typeof t.id === 'string' && typeof t.title === 'string')
    .map((t) => {
      const status = typeof t.status === 'string' ? t.status : 'active'
      const window = typeof t.payoffWindow === 'number' ? t.payoffWindow : null
      return {
        id: String(t.id),
        kind: typeof t.kind === 'string' ? t.kind : 'foreshadow',
        title: String(t.title),
        description: typeof t.description === 'string' ? t.description : '',
        plantedChapter: typeof t.plantedChapter === 'number' ? t.plantedChapter : null,
        advancedChapters: Array.isArray(t.advancedChapters)
          ? (t.advancedChapters as unknown[]).filter((x): x is number => typeof x === 'number')
          : [],
        resolvedChapter: typeof t.resolvedChapter === 'number' ? t.resolvedChapter : null,
        status,
        payoffHint: typeof t.payoffHint === 'string' ? t.payoffHint : '',
        payoffWindow: window,
        // 还悬着、且已经过了期望回收章 → overdue
        overdue: status === 'active' && window !== null && currentChapter >= window,
      }
    })

  return c.json({ currentChapter, threads })
})

interface LocationRow {
  id?: unknown
  name?: unknown
  type?: unknown
  region?: unknown
  description?: unknown
  x?: unknown
  y?: unknown
}

interface RouteRow {
  id?: unknown
  fromId?: unknown
  toId?: unknown
  mode?: unknown
  days?: unknown
  condition?: unknown
  bidirectional?: unknown
}

/**
 * 世界地图（spec 视图 5）：地点 + 路线。
 *
 * ★ 地点坐标是可选字段：旧书稿里往往只有名字没有坐标，
 *   缺坐标由前端做圆环布局，不在后端偷偷生成假坐标。
 */
read.get('/world', async (c) => {
  const { root } = getContext()
  const [locRaw, routeRaw] = await Promise.all([
    readJsonElement(root, 'world/locations.json'),
    readJsonElement(root, 'world/routes.json'),
  ])

  const locs = Array.isArray(locRaw) ? (locRaw as LocationRow[]) : []
  const locations = locs
    .filter((l) => typeof l.id === 'string' && typeof l.name === 'string')
    .map((l) => ({
      id: String(l.id),
      name: String(l.name),
      type: typeof l.type === 'string' ? l.type : 'plain',
      region: typeof l.region === 'string' ? l.region : '',
      description: typeof l.description === 'string' ? l.description : '',
      x: typeof l.x === 'number' ? l.x : null,
      y: typeof l.y === 'number' ? l.y : null,
    }))

  const routes = (Array.isArray(routeRaw) ? (routeRaw as RouteRow[]) : [])
    .filter((r) => typeof r.fromId === 'string' && typeof r.toId === 'string')
    .map((r) => ({
      id: String(r.id ?? `${String(r.fromId)}-${String(r.toId)}`),
      fromId: String(r.fromId),
      toId: String(r.toId),
      mode: typeof r.mode === 'string' ? r.mode : 'walk',
      days: typeof r.days === 'number' ? r.days : 1,
      condition: typeof r.condition === 'string' ? r.condition : '',
      bidirectional: r.bidirectional !== false,
    }))

  return c.json({ locations, routes })
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
