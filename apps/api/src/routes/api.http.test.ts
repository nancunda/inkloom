import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import type { IndexDb } from '../index-db/client.js'
import type { FetchLike } from '../llm/types.js'
import { resetSearchBreakersForTest } from '../search/service.js'
import { clearContext, setContext } from '../services/context.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { writeSceneFile } from '../storage/scenes.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

type App = ReturnType<typeof createApp>

const THREE_SCENES = `===场景1===
剑气贴着面颊削过去。

===场景2===
碑上刻着她自己的名字。`

const PROPOSAL_OUT = 'c1|curPhysical|虎口震伤|剑气贴着面颊削过去'

/** 一个假 fetch 同时服务生成与提案（靠 system prompt 区分） */
const fakeLlm: FetchLike = async (_url, init) => {
  const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
  const isProposal = body.messages[0]?.content.includes('小说编辑助手') === true
  return new Response(
    JSON.stringify({
      choices: [
        { message: { content: isProposal ? PROPOSAL_OUT : THREE_SCENES }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 800, completion_tokens: 2000 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function appWithLlm(): App {
  return createApp({ fetchImpl: fakeLlm, apiKey: 'sk-test' })
}

async function seedScene(
  chapterNo: number,
  sceneNo: number,
  segId: string,
  text: string,
): Promise<void> {
  const { relPath } = await writeSceneFile(
    root,
    { sceneNo, version: 1, segments: [{ segId, text }] },
    chapterNo,
  )
  await db.draftSegment.create({
    data: {
      id: `seg_${chapterNo}_${sceneNo}_1_${segId}`,
      projectId: pid,
      chapterNo,
      sceneNo,
      segId,
      seq: 0,
      filePath: relPath,
      contentHash: 'h',
      wordCount: text.length,
      status: 'candidate',
    },
  })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-http-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })

  await writeJsonElement(root, 'characters/index.json', [
    { id: 'c1', projectId: pid, name: '林岚', role: 'protagonist', curPhysical: '健康' },
  ])
  await writeJsonElement(root, 'story/blueprints/ch-004.json', {
    id: 'b4',
    projectId: pid,
    chapterNo: 4,
    title: '第四章 剑冢',
    goal: '走到碑前',
    conflict: '裴无咎阻拦',
    hook: '碑上的名字是她自己',
    castIds: ['c1'],
    beatType: 'climax',
    tensionLevel: 5,
  })
  await seedScene(4, 1, 'aaaa', '剑气贴着面颊削过去。')
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('GET 接口', () => {
  it('/api/health → ok', async () => {
    const r = await createApp().request('/api/health')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
  })

  it('★ /api/book 返回书名与章节列表', async () => {
    const r = await appWithLlm().request('/api/book')
    const j = (await r.json()) as { name: string; genre: string; chapters: unknown[] }
    expect(j.name).toBe('七霞')
    expect(j.genre).toBe('玄幻')
    expect(Array.isArray(j.chapters)).toBe(true)
  })

  it('★ /api/chapters/4 返回场景状态', async () => {
    const j = (await (await appWithLlm().request('/api/chapters/4')).json()) as {
      scenes: { sceneNo: number; status: string }[]
    }
    expect(j.scenes).toHaveLength(1)
    expect(j.scenes[0]?.status).toBe('candidate')
  })

  it('★ 章号非法 → 400（不是 500）', async () => {
    const r = await appWithLlm().request('/api/chapters/abc')
    expect(r.status).toBe(400)
    const j = (await r.json()) as { error: { code: string } }
    expect(j.error.code).toBe('INVALID_INPUT')
  })

  it('★ 不存在的章 → 200 + 空场景（章还没生成是正常状态）', async () => {
    const j = (await (await appWithLlm().request('/api/chapters/99')).json()) as {
      scenes: unknown[]
    }
    expect(j.scenes).toEqual([])
  })

  it('★ 场景正文带 segId', async () => {
    const j = (await (await appWithLlm().request('/api/chapters/4/scenes/1?version=1')).json()) as {
      segments: { segId: string; text: string }[]
    }
    expect(j.segments[0]?.segId).toBe('aaaa')
    expect(j.segments[0]?.text).toContain('剑气')
  })

  it('★ 场景版本不存在 → 404', async () => {
    expect((await appWithLlm().request('/api/chapters/4/scenes/1?version=9')).status).toBe(404)
  })

  it('★ diff 返回字符级 spans 与相似度', async () => {
    await writeSceneFile(
      root,
      {
        sceneNo: 1,
        version: 2,
        segments: [{ segId: 'aaaa', text: '剑气贴着面颊削过去。她没躲。' }],
      },
      4,
    )
    const j = (await (
      await appWithLlm().request('/api/chapters/4/scenes/1/diff?from=1&to=2')
    ).json()) as {
      similarity: number
      addedChars: number
      spans: unknown[]
    }
    expect(j.addedChars).toBeGreaterThan(0)
    expect(j.similarity).toBeLessThan(1)
    expect(j.spans.length).toBeGreaterThan(0)
  })

  it('diff 缺 from/to → 400', async () => {
    expect((await appWithLlm().request('/api/chapters/4/scenes/1/diff')).status).toBe(400)
  })

  it('★ /api/blueprints 返回叙事地图字段', async () => {
    const j = (await (await appWithLlm().request('/api/blueprints')).json()) as {
      chapters: { chapterNo: number; tensionLevel: number }[]
    }
    expect(j.chapters).toHaveLength(1)
    expect(j.chapters[0]?.tensionLevel).toBe(5)
  })
})

describe('POST 接口', () => {
  it('★ 生成 → 3 个场景（假 LLM）', async () => {
    const r = await appWithLlm().request('/api/chapters/4/generate', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { scenes: { sceneNo: number }[]; strategy: string }
    expect(j.strategy).toBe('marker')
    expect(j.scenes).toHaveLength(2)
  })

  it('★ 缺 API key → 401（不是 400）', async () => {
    const prev = process.env['DEEPSEEK_API_KEY']
    delete process.env['DEEPSEEK_API_KEY']
    try {
      const r = await createApp().request('/api/chapters/4/generate', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      expect(r.status).toBe(401)
      const j = (await r.json()) as { error: { code: string } }
      expect(j.error.code).toBe('AUTH')
    } finally {
      if (prev !== undefined) process.env['DEEPSEEK_API_KEY'] = prev
    }
  })

  it('★ 有 candidate 时定稿 → 409（状态冲突，不是参数错误也不是 500）', async () => {
    const r = await appWithLlm().request('/api/chapters/4/finalize', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(409)
    const j = (await r.json()) as { error: { message: string } }
    expect(j.error.message).toContain('candidate')
  })

  it('★ 接受后定稿成功，返回字数与摘要', async () => {
    const acc = await appWithLlm().request('/api/chapters/4/scenes/1/accept', {
      method: 'POST',
      body: JSON.stringify({ version: 1 }),
    })
    expect(acc.status).toBe(200)

    const fin = await appWithLlm().request('/api/chapters/4/finalize', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(fin.status).toBe(200)
    const j = (await fin.json()) as { wordCount: number; summary: string; sceneCount: number }
    expect(j.sceneCount).toBe(1)
    expect(j.wordCount).toBeGreaterThan(0)
    expect(j.summary).toContain('走到碑前')
  })

  it('★ accept 缺 version → 400', async () => {
    const r = await appWithLlm().request('/api/chapters/4/scenes/1/accept', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
  })

  it('★ 提案返回 evidenceVerified 字段', async () => {
    // 提案要求本章已定稿
    await appWithLlm().request('/api/chapters/4/scenes/1/accept', {
      method: 'POST',
      body: JSON.stringify({ version: 1 }),
    })
    await appWithLlm().request('/api/chapters/4/finalize', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const r = await appWithLlm().request('/api/chapters/4/propose', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { proposals: { evidenceVerified: boolean }[] }
    expect(j.proposals).toHaveLength(1)
    expect(typeof j.proposals[0]?.evidenceVerified).toBe('boolean')
  })

  it('★ apply-proposals 的 acceptIds 非法 → 400', async () => {
    const r = await appWithLlm().request('/api/chapters/4/proposals/apply', {
      method: 'POST',
      body: JSON.stringify({ acceptIds: 'all' }),
    })
    expect(r.status).toBe(400)
  })
})

describe('时间机器', () => {
  it('拍检查点 → 改角色 → 回退：文件与索引都回到那一刻', async () => {
    const ckRes = await appWithLlm().request('/api/checkpoints', {
      method: 'POST',
      body: JSON.stringify({ label: '改名之前' }),
    })
    expect(ckRes.status).toBe(200)
    const ck = (await ckRes.json()) as { checkpoint: { id: string; shortRef: string | null } }
    expect(ck.checkpoint.shortRef).not.toBeNull()

    // 改角色名（走与界面相同的 CAS 写入）
    const before = (await (
      await appWithLlm().request('/api/elements?path=characters%2Findex.json')
    ).json()) as { data: { name: string }[]; hash: string }
    const put = await appWithLlm().request('/api/elements', {
      method: 'PUT',
      body: JSON.stringify({
        relPath: 'characters/index.json',
        entityType: 'character',
        entityId: 'c1',
        expectedHash: before.hash,
        payload: { ...before.data[0], name: '改名后的林岚' },
      }),
    })
    expect(put.status).toBe(200)

    const rb = await appWithLlm().request(`/api/checkpoints/${ck.checkpoint.id}/rollback`, {
      method: 'POST',
      body: '{}',
    })
    expect(rb.status).toBe(200)
    const j = (await rb.json()) as { restoredPaths: string[]; reindex: { characters: number } }
    // 恢复的是顶层条目（git checkout 按目录整棵还原）
    expect(j.restoredPaths).toContain('characters')
    expect(j.reindex.characters).toBe(1)

    // 文件与索引都回到「改名之前」
    const after = (await (
      await appWithLlm().request('/api/elements?path=characters%2Findex.json')
    ).json()) as { data: { name: string }[] }
    expect(after.data[0]?.name).toBe('林岚')

    // 回退本身也留痕：列表里多出一条「回退到…」
    const list = (await (await appWithLlm().request('/api/checkpoints')).json()) as {
      checkpoints: { label: string }[]
    }
    expect(list.checkpoints).toHaveLength(2)
    expect(list.checkpoints[0]?.label).toContain('回退到')
  })

  it('★ 文件缩进不是 2 空格时，GET 拿到的 hash 仍能直接用于 PUT（回退/外部编辑后）', async () => {
    // 模拟 git 恢复或外部编辑器：4 空格缩进，和服务端写出的格式不同
    const file = join(root, 'characters/index.json')
    const data = [
      { id: 'c1', projectId: pid, name: '林岚', role: 'protagonist', curPhysical: '健康' },
    ]
    await writeFile(file, `${JSON.stringify(data, null, 4)}\n`, 'utf8')

    const got = (await (
      await appWithLlm().request('/api/elements?path=characters%2Findex.json')
    ).json()) as { data: { id: string; projectId: string }[]; hash: string }

    const put = await appWithLlm().request('/api/elements', {
      method: 'PUT',
      body: JSON.stringify({
        relPath: 'characters/index.json',
        entityType: 'character',
        entityId: 'c1',
        expectedHash: got.hash,
        payload: { ...got.data[0], curPhysical: '轻微擦伤' },
      }),
    })
    expect(put.status).toBe(200)
  })
})

describe('未定义的接口', () => {
  it('→ 404 且带 code', async () => {
    const r = await appWithLlm().request('/api/nope')
    expect(r.status).toBe(404)
    const j = (await r.json()) as { error: { code: string } }
    expect(j.error.code).toBe('NOT_FOUND')
  })
})

/** 重写接口专用假 LLM：回一段与原文长度相当的新文本 */
const rewriteLlm: FetchLike = async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: '剑气贴着面颊掠过。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 300, completion_tokens: 40 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

function appWithRewrite(): App {
  return createApp({ fetchImpl: rewriteLlm, apiKey: 'sk-test' })
}

describe('局部重写接口', () => {
  it('★ POST rewrite → 200，产出新版本', async () => {
    const r = await appWithRewrite().request('/api/chapters/4/scenes/1/rewrite', {
      method: 'POST',
      body: JSON.stringify({ version: 1, segId: 'aaaa' }),
    })
    expect(r.status).toBe(200)
    const j = (await r.json()) as { newVersion: number; rewritten: string }
    expect(j.newVersion).toBe(2)
    expect(j.rewritten).toBe('剑气贴着面颊掠过。')
  })

  it('段不存在 → 404', async () => {
    const r = await appWithRewrite().request('/api/chapters/4/scenes/1/rewrite', {
      method: 'POST',
      body: JSON.stringify({ version: 1, segId: 'zzzz' }),
    })
    expect(r.status).toBe(404)
    const j = (await r.json()) as { error: { code: string } }
    expect(j.error.code).toBe('NOT_FOUND')
  })

  it('★ 章节已定稿 → 409（不是 400，也不是 500）', async () => {
    await db.chapter.create({
      data: {
        id: 'ch4-fixed',
        projectId: pid,
        chapterNo: 4,
        status: 'finalized',
        wordCount: 0,
      },
    })
    const r = await appWithRewrite().request('/api/chapters/4/scenes/1/rewrite', {
      method: 'POST',
      body: JSON.stringify({ version: 1, segId: 'aaaa' }),
    })
    expect(r.status).toBe(409)
    const j = (await r.json()) as { error: { code: string } }
    expect(j.error.code).toBe('CONFLICT')
  })

  it('★ 整场重写走 /rewrite-full：与段级重写不能被同一个路径吃掉', async () => {
    // 只给 guidance（段级接口必填 version/segId）。如果整场重写又占了 /rewrite，
    // 这里会返回 200，段级重写就静默失效了——上一版就是这么坏的。
    const seg = await appWithRewrite().request('/api/chapters/4/scenes/1/rewrite', {
      method: 'POST',
      body: JSON.stringify({ guidance: '更冷' }),
    })
    expect(seg.status).toBe(400)

    const full = await appWithRewrite().request('/api/chapters/4/scenes/1/rewrite-full', {
      method: 'POST',
      body: JSON.stringify({ guidance: '更冷' }),
    })
    expect(full.status).toBe(200)
    const j = (await full.json()) as { scene: { sceneNo: number; version: number } }
    expect(j.scene.sceneNo).toBe(1)
    expect(j.scene.version).toBe(2)
  })
})

describe('资料卡接口', () => {
  async function seedLore(id = 'lr-test0001', title = '剑冢考据'): Promise<string> {
    await db.loreReference.create({
      data: {
        id,
        projectId: pid,
        query: '剑冢',
        provider: 'tavily',
        title,
        url: 'https://a.example',
        snippet: '摘要',
        content: null,
        usedInRunIds: JSON.stringify(['ar_1']),
        approved: false,
      },
    })
    return id
  }

  it('★ 列表 → 批准 → approved=true', async () => {
    const id = await seedLore()
    const before = await createApp().request('/api/lore?limit=5')
    expect(before.status).toBe(200)
    const b1 = (await before.json()) as { items: { id: string }[] }
    expect(b1.items.map((x) => x.id)).toEqual([id])

    const okRes = await createApp().request(`/api/lore/${id}/approve`, { method: 'POST' })
    expect(okRes.status).toBe(200)

    const after = await createApp().request('/api/lore?approved=1&limit=5')
    const b2 = (await after.json()) as { items: { id: string }[] }
    expect(b2.items.map((x) => x.id)).toEqual([id])

    // ★ 反面也要验：approved=0 不应再包含已批准的卡
    const drafts = await createApp().request('/api/lore?approved=0&limit=5')
    const b3 = (await drafts.json()) as { items: { id: string }[] }
    expect(b3.items.map((x) => x.id)).not.toContain(id)
  })

  it('★ 批准不存在的卡片返回 404', async () => {
    const res = await createApp().request('/api/lore/lr-nope/approve', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('★ 未批准的可以删；已批准的拒绝删（400，不是 404）', async () => {
    const draft = await seedLore('lr-draft001')
    const delDraft = await createApp().request(`/api/lore/${draft}`, { method: 'DELETE' })
    expect(delDraft.status).toBe(200)

    const approved = await seedLore('lr-fixed001')
    await createApp().request(`/api/lore/${approved}/approve`, { method: 'POST' })
    const delApproved = await createApp().request(`/api/lore/${approved}`, { method: 'DELETE' })
    expect(delApproved.status).toBe(400)
    const body = (await delApproved.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_INPUT')

    const missing = await createApp().request('/api/lore/lr-nope', { method: 'DELETE' })
    expect(missing.status).toBe(404)
  })

  it('★ q 过滤标题（两张卡里只回匹配的那张）', async () => {
    await seedLore('lr-hit00001', '剑冢考据')
    await seedLore('lr-miss0001', '灵气复苏考据')
    const res = await createApp().request('/api/lore?q=剑冢')
    const body = (await res.json()) as { items: { id: string; title: string }[] }
    expect(body.items.map((x) => x.id)).toEqual(['lr-hit00001'])
  })
})

describe('搜索接口', () => {
  // ★ 熔断表是进程级的：不 reset 会让前面的失败影响后面的用例
  beforeEach(() => {
    resetSearchBreakersForTest()
  })

  const DDG_HTML = `<table>
    <tr><td><a class="result-link" href="https://a.example">剑冢</a></td></tr>
    <tr><td class="result-snippet">古剑埋骨之地</td></tr>
  </table>`

  it('★ 没 key 时降级到 DuckDuckGo，并返回 provider/degraded', async () => {
    // ★ 本机 .env 里的 key 会改变降级起点，测试里先清空再还原
    const tavily = process.env['TAVILY_API_KEY']
    const searx = process.env['SEARXNG_BASE_URLS']
    delete process.env['TAVILY_API_KEY']
    delete process.env['SEARXNG_BASE_URLS']
    try {
      const searchFetch: FetchLike = async (url) => {
        if (String(url).includes('lite.duckduckgo.com')) {
          return new Response(DDG_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
        }
        return new Response('nope', { status: 500 })
      }
      const app = createApp({ searchFetch })
      const r = await app.request('/api/search', {
        method: 'POST',
        body: JSON.stringify({ query: '剑冢' }),
      })
      expect(r.status).toBe(200)
      const j = (await r.json()) as {
        query: string
        provider: string | null
        degraded: boolean
        warnings: string[]
        hits: { title: string; url: string; snippet: string }[]
      }
      expect(j.query).toBe('剑冢')
      expect(j.provider).toBe('duckduckgo')
      expect(j.degraded).toBe(true)
      expect(Array.isArray(j.warnings)).toBe(true)
      expect(j.hits[0]?.url).toBe('https://a.example')
      expect(j.hits[0]?.snippet).toBe('古剑埋骨之地')
    } finally {
      if (tavily !== undefined) process.env['TAVILY_API_KEY'] = tavily
      if (searx !== undefined) process.env['SEARXNG_BASE_URLS'] = searx
    }
  })

  it('★ 有 Tavily key 时优先走 Tavily，degraded=false，拉数非数字时回退默认 5', async () => {
    const tavily = process.env['TAVILY_API_KEY']
    process.env['TAVILY_API_KEY'] = 'tvly-test'
    try {
      let seenBody: Record<string, unknown> = {}
      const searchFetch: FetchLike = async (url, init) => {
        if (String(url).includes('api.tavily.com')) {
          seenBody = JSON.parse(String(init.body)) as Record<string, unknown>
          return new Response(
            JSON.stringify({
              results: [{ title: 'T', url: 'https://t.example', content: 'S' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('nope', { status: 500 })
      }
      const app = createApp({ searchFetch })
      const r = await app.request('/api/search', {
        method: 'POST',
        body: JSON.stringify({ query: 'q', maxResults: 'abc' }),
      })
      expect(r.status).toBe(200)
      const j = (await r.json()) as {
        provider: string | null
        degraded: boolean
        warnings: string[]
        hits: { title: string }[]
      }
      expect(j.provider).toBe('tavily')
      expect(j.degraded).toBe(false)
      expect(j.warnings).toEqual([])
      expect(j.hits[0]?.title).toBe('T')
      // ★ 非数字要回退成 5，不能是 NaN（NaN 会绕过 provider 的截断）
      expect(seenBody['max_results']).toBe(5)
    } finally {
      if (tavily === undefined) delete process.env['TAVILY_API_KEY']
      else process.env['TAVILY_API_KEY'] = tavily
    }
  })

  it('缺少 query → 400', async () => {
    const r = await createApp().request('/api/search', {
      method: 'POST',
      body: JSON.stringify({ query: '  ' }),
    })
    expect(r.status).toBe(400)
  })
})
