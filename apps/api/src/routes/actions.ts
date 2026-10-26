import type { JudgeProvider } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import type { ImageProvider } from '../assets/image-provider.js'
import { checkChapter } from '../judge/health-check.js'
import { resolveJudgeProvider } from '../judge/registry.js'
import type { FetchLike } from '../llm/types.js'
import { createTavilySearch } from '../search/tavily.js'
import { getContext } from '../services/context.js'
import { finalizeChapter, unfinalizeChapter } from '../services/finalize-service.js'
import { generateChapter } from '../services/generate-service.js'
import { importChapters } from '../services/import-service.js'
import { getJob, listJobs, submitGenerate } from '../services/job-service.js'
import { generatePortrait } from '../services/portrait-service.js'
import { createRelation } from '../services/relation-service.js'
import { rewriteSceneSeg } from '../services/rewrite-service.js'
import { acceptScene, editSceneSeg, rejectScene } from '../services/scene-review-service.js'
import {
  applyStateProposals,
  loadLatestProposals,
  proposeStateChanges,
} from '../services/state-proposal-service.js'

/**
 * 依赖注入（Ruling：测试注入假 LLM，不污染生产代码）。
 *
 * ★ 为什么不用 `INKLOOM_FAKE_LLM=1` 环境变量开关：
 *   那种做法会让生产代码里长期存在一条"测试专用分支"，
 *   一旦忘了关就是线上接假 LLM。依赖注入让假实现只活在测试进程里。
 */
export interface ActionDeps {
  fetchImpl?: FetchLike
  /** 覆盖环境变量里的 key（测试用） */
  apiKey?: string
  /** 判断层 provider；传 null = 关闭，不传 = 按 INKLOOM_JUDGE 解析 */
  judgeProvider?: JudgeProvider | null
  /** 生图 provider；测试可注入假图，不传 = 真实调用硅基流动 */
  imageProvider?: ImageProvider
  /** 前端静态目录（发行包里与 API 同进程提供）；测试可覆盖 */
  webDist?: string
}

function intParam(raw: string | undefined, name: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new InkloomError('INVALID_INPUT', `${name} 必须是正整数`)
  }
  return n
}

function requireApiKey(deps: ActionDeps): string {
  const key = deps.apiKey ?? process.env['DEEPSEEK_API_KEY']
  if (key === undefined || key.trim().length === 0) {
    throw new InkloomError('AUTH', '缺少 DEEPSEEK_API_KEY（见 .env.example）')
  }
  return key
}

export function createActions(deps: ActionDeps = {}): Hono {
  const actions = new Hono()

  actions.post('/chapters/:n/check', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    // ★ 只读体检：不改任何文件。判断层关闭时 enabled=false，不是错误。
    return c.json(
      await checkChapter({ chapterNo, provider: resolveJudgeProvider(deps.judgeProvider) }),
    )
  })

  /**
   * 角色形象（P4）：从 visualAnchor 生图 → 落盘 → 记 Asset。
   *
   * ★ 与 CLI `portrait` 调同一个 generatePortrait：界面不是另一条实现。
   * ★ key 缺了报 AUTH 并指向「设置」页，而不是笼统的 500。
   */
  actions.post('/portraits', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    const characterId = typeof body?.['characterId'] === 'string' ? body['characterId'].trim() : ''
    if (characterId === '') throw new InkloomError('INVALID_INPUT', 'characterId 必填')

    const key = (process.env['SILICONFLOW_API_KEY'] ?? '').trim()
    if (deps.imageProvider === undefined && key === '') {
      throw new InkloomError('AUTH', '缺少 SILICONFLOW_API_KEY：在「设置」里填硅基流动 Key 后重试')
    }

    const style =
      typeof body?.['style'] === 'string' && body['style'].trim() !== ''
        ? body['style'].trim()
        : undefined
    const model =
      (process.env['SILICONFLOW_IMAGE_MODEL'] ?? '').trim() === ''
        ? undefined
        : (process.env['SILICONFLOW_IMAGE_MODEL'] ?? '').trim()

    const result = await generatePortrait({
      characterId,
      apiKey: key,
      ...(style === undefined ? {} : { style }),
      ...(model === undefined ? {} : { model }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.imageProvider === undefined ? {} : { imageProvider: deps.imageProvider }),
    })

    return c.json(result)
  })

  actions.post('/import', async (c) => {
    const { root } = getContext()
    const body = (await c.req.json().catch(() => ({}))) as { sourcePath?: string }
    if (body.sourcePath === undefined || body.sourcePath.trim().length === 0) {
      throw new InkloomError('INVALID_INPUT', '缺少 sourcePath（本机 txt/md 路径）')
    }
    // 单书模式：追加到当前这本书，章号接在现有最大章之后
    return c.json(await importChapters({ rootPath: root, sourcePath: body.sourcePath }))
  })

  actions.post('/relations', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      fromId?: string
      toId?: string
      kind?: string
      strength?: number
      sinceChapter?: number
    }
    if (body.fromId === undefined || body.toId === undefined || body.kind === undefined) {
      throw new InkloomError('INVALID_INPUT', '需要 fromId / toId / kind')
    }
    return c.json(
      await createRelation({
        fromId: body.fromId,
        toId: body.toId,
        kind: body.kind,
        ...(body.strength === undefined ? {} : { strength: body.strength }),
        ...(body.sinceChapter === undefined ? {} : { sinceChapter: body.sinceChapter }),
      }),
    )
  })

  actions.post('/search', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { query?: string; maxResults?: number }
    const query = body.query?.trim() ?? ''
    if (query.length === 0) throw new InkloomError('INVALID_INPUT', '缺少 query')

    const key = (process.env['TAVILY_API_KEY'] ?? '').trim()
    if (key.length === 0) throw new InkloomError('AUTH', '缺少 TAVILY_API_KEY（见 .env.example）')

    const provider = createTavilySearch({ apiKey: key })
    return c.json({
      provider: provider.id,
      query,
      hits: await provider.search(query, body.maxResults ?? 5),
    })
  })

  actions.post('/chapters/:n/generate-async', (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    return c.json({ jobId: submitGenerate({ chapterNo, apiKey: requireApiKey(deps) }) }, 202)
  })

  actions.get('/jobs', (c) => c.json({ jobs: listJobs() }))

  actions.get('/jobs/:id', (c) => {
    const job = getJob(c.req.param('id'))
    if (job === undefined) {
      throw new InkloomError(
        'NOT_FOUND',
        '任务不存在（服务重启后未完成的任务会丢失，重新提交即可）',
      )
    }
    return c.json(job)
  })

  actions.post('/chapters/:n/generate', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const body = (await c.req.json().catch(() => ({}))) as { guidance?: string; model?: string }
    const r = await generateChapter({
      chapterNo,
      apiKey: requireApiKey(deps),
      ...(body.guidance === undefined ? {} : { userGuidance: body.guidance }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
    return c.json(r)
  })

  actions.post('/chapters/:n/scenes/:s/accept', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const sceneNo = intParam(c.req.param('s'), 'sceneNo')
    const body = (await c.req.json().catch(() => ({}))) as { version?: number }
    if (body.version === undefined) throw new InkloomError('INVALID_INPUT', '缺少 version')
    return c.json(await acceptScene({ chapterNo, sceneNo, version: body.version }))
  })

  actions.post('/chapters/:n/scenes/:s/reject', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const sceneNo = intParam(c.req.param('s'), 'sceneNo')
    const body = (await c.req.json().catch(() => ({}))) as { version?: number }
    if (body.version === undefined) throw new InkloomError('INVALID_INPUT', '缺少 version')
    await rejectScene({ chapterNo, sceneNo, version: body.version })
    return c.json({ ok: true })
  })

  actions.post('/chapters/:n/scenes/:s/edit', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const sceneNo = intParam(c.req.param('s'), 'sceneNo')
    const body = (await c.req.json().catch(() => ({}))) as {
      version?: number
      segId?: string
      newText?: string
    }
    if (body.version === undefined || body.segId === undefined || body.newText === undefined) {
      throw new InkloomError('INVALID_INPUT', '需要 version / segId / newText')
    }
    return c.json(
      await editSceneSeg({
        chapterNo,
        sceneNo,
        version: body.version,
        segId: body.segId,
        newText: body.newText,
      }),
    )
  })

  actions.post('/chapters/:n/scenes/:s/rewrite', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const sceneNo = intParam(c.req.param('s'), 'sceneNo')
    const body = (await c.req.json().catch(() => ({}))) as {
      version?: number
      segId?: string
      guidance?: string
      model?: string
    }
    if (body.version === undefined || body.segId === undefined) {
      throw new InkloomError('INVALID_INPUT', '需要 version / segId')
    }
    return c.json(
      await rewriteSceneSeg({
        chapterNo,
        sceneNo,
        version: body.version,
        segId: body.segId,
        apiKey: requireApiKey(deps),
        ...(body.guidance === undefined ? {} : { guidance: body.guidance }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      }),
    )
  })

  actions.post('/chapters/:n/finalize', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    return c.json(
      await finalizeChapter({
        chapterNo,
        ...(body.title === undefined ? {} : { title: body.title }),
      }),
    )
  })

  actions.post('/chapters/:n/unfinalize', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    await unfinalizeChapter({ chapterNo })
    return c.json({ ok: true })
  })

  actions.post('/chapters/:n/propose', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const body = (await c.req.json().catch(() => ({}))) as { model?: string }
    return c.json(
      await proposeStateChanges({
        chapterNo,
        apiKey: requireApiKey(deps),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      }),
    )
  })

  actions.get('/chapters/:n/proposals', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    return c.json({ proposals: await loadLatestProposals(chapterNo) })
  })

  actions.post('/chapters/:n/proposals/apply', async (c) => {
    const chapterNo = intParam(c.req.param('n'), 'chapterNo')
    const body = (await c.req.json().catch(() => ({}))) as { acceptIds?: unknown }
    if (!Array.isArray(body.acceptIds) || !body.acceptIds.every((x) => typeof x === 'string')) {
      throw new InkloomError('INVALID_INPUT', 'acceptIds 必须是字符串数组')
    }
    return c.json(await applyStateProposals({ chapterNo, acceptIds: body.acceptIds }))
  })

  return actions
}
