# 共创急救包（切片 1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉会打断创作的章节/图片硬预算，让 Agent 能自主联网搜索并把结果落成可审批的资料卡。

**Architecture:** 预算与暂停状态改在现有 `run-service`/`tools` 内；搜索抽成 `SearchProvider` + `SearchService`（Tavily → SearXNG → DuckDuckGo 降级，8s 超时 + 熔断），正文用 `@mozilla/readability` + `linkedom` 本地提取；资料卡复用已有 `LoreReference` 表，默认 `approved=false`，只有作者批准才进 prompt。

**Tech Stack:** TypeScript / Hono / Prisma + SQLite / Pi Agent / TypeBox / Vitest / linkedom + @mozilla/readability

**Spec:** [2026-10-27-creator-and-graph-v2-design.md](../specs/2026-10-27-creator-and-graph-v2-design.md) §4

## Global Constraints

- 文件是唯一事实源；`LoreReference` 是可丢弃的缓存/索引，不新增 Prisma 表。
- 既有 12 个实体文件格式一个字段都不改。
- 对外部网页只读；`read_url` 必须拒绝本机与内网地址。
- 未批准的跨 run 资料卡不得进 prompt。
- 单次 `web_search` 只发一个请求；单次 `read_url` 只读一个 URL。
- 搜索 provider 顺序固定：Tavily → SearXNG（可多个）→ DuckDuckGo。
- 所有新增代码走 biome 与 `tsc`（含 web）门禁；不引入 `any`。
- 测试命令：单测 `pnpm vitest run --project unit <path>`，集成 `pnpm test:int`，全量 `pnpm verify`。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `apps/api/src/search/types.ts` | `SearchHit` / `SearchProvider` / `SearchResult` 类型 |
| `apps/api/src/search/tavily.ts` | Tavily provider（改类型） |
| `apps/api/src/search/searxng.ts` | SearXNG provider |
| `apps/api/src/search/duckduckgo.ts` | DuckDuckGo lite provider |
| `apps/api/src/search/service.ts` | 降级链 + 超时 + 熔断 |
| `apps/api/src/search/ssrf.ts` | URL 公网校验 |
| `apps/api/src/search/extract.ts` | 抓取 + 编码检测 + Readability 正文 |
| `apps/api/src/services/lore-service.ts` | 资料卡读写（`LoreReference`） |
| `apps/api/src/routes/lore.ts` | 资料卡 HTTP |
| `apps/api/src/agent/tools.ts` | 新增 `web_search` / `read_url` / `read_lore`；删额度检查 |
| `apps/api/src/agent/run-service.ts` | `paused` 状态、步数预算、注入 runId |
| `apps/api/src/routes/actions.ts` | `/search` 改用 SearchService |
| `apps/api/src/routes/settings.ts` | `SEARXNG_BASE_URLS` 白名单 |
| `apps/api/src/app.ts` | 挂载 lore 路由 |
| `apps/web/src/api/types.ts` | 搜索/资料卡类型、`paused` |
| `apps/web/src/api/hooks.ts` | 资料卡 hooks |
| `apps/web/src/components/Toolbar.tsx` | 显示 provider / degraded / snippet |
| `apps/web/src/pages/AgentPage.tsx` | 预算行、`paused` 状态、工具标签 |
| `apps/web/src/pages/SettingsPage.tsx` | 搜索配置分组 |

---

## Task 1: 去掉章节/图片额度 + 步数耗尽改为暂停

**Files:**
- Modify: `apps/api/src/agent/tools.ts:42-49`（RunBudget）、`:791-800`、`:836-847`
- Modify: `apps/api/src/agent/run-service.ts:17`、`:497-504`、`:291-299`、`:357-360`
- Modify: `apps/api/src/agent/plan-tools.test.ts:28-35`
- Modify: `apps/api/src/agent/run-service.test.ts:407-422`
- Modify: `apps/web/src/api/types.ts:362`、`:411-418`
- Modify: `apps/web/src/pages/AgentPage.tsx:78-90`、`:257-280`、`:595-610`、`:663-674`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export type AgentRunStatus = 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped'
  export interface RunBudget {
    steps: number
    maxSteps: number
    chapterCalls: number   // 只统计，不再拦截
    portraitCalls: number  // 只统计，不再拦截
  }
  ```

- [ ] **Step 1: 改写预算测试**

把 `apps/api/src/agent/run-service.test.ts` 的 `it('budget 耗尽且还有任务 → failed，不把任务钉在 doing', ...)` 整段替换为：

```ts
  it('★ 步数耗尽且还有任务 → paused，任务保持 doing 可继续', async () => {
    const planId = await seedPlan('approved', [{ id: 't1', status: 'doing' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const run = getAgentRun(started.id)
    if (run !== null) run.budget.steps = run.budget.maxSteps
    agent.emit({ type: 'agent_end' })
    agent.done()
    await new Promise((r) => setTimeout(r, 80))

    const after = getAgentRun(started.id)
    expect(after?.status).toBe('paused')
    expect(after?.error).toBeNull()
    expect((await loadPlan(h.root, planId))?.status).toBe('approved')
    expect((await loadPlan(h.root, planId))?.tasks[0]?.status).toBe('doing')
  })

  it('★ 暂停后可以继续：步数清零，任务从 doing 接着做', async () => {
    const planId = await seedPlan('approved', [{ id: 't1', status: 'doing' }])
    const started = await startAgentRun('继续')
    const agent = lastAgent()
    const run = getAgentRun(started.id)
    if (run !== null) run.budget.steps = run.budget.maxSteps
    agent.emit({ type: 'agent_end' })
    agent.done()
    await new Promise((r) => setTimeout(r, 80))

    const resumed = resumeAgentRun(started.id)
    expect(resumed.status).toBe('running')
    expect(resumed.budget.steps).toBe(0)
    expect(resumed.planId).toBe(planId)
    stopAgentRun(started.id)
  })
```

在 `apps/api/src/agent/plan-tools.test.ts` 顶部把 `budget` 常量改为：

```ts
const budget: RunBudget = {
  steps: 0,
  maxSteps: 40,
  chapterCalls: 0,
  portraitCalls: 0,
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/run-service.test.ts -t "步数耗尽"`
Expected: FAIL — 现在得到 `status: 'failed'`，期望 `'paused'`。

- [ ] **Step 3: 改 RunBudget 与两处额度检查**

`apps/api/src/agent/tools.ts`：

```ts
export interface RunBudget {
  steps: number
  maxSteps: number
  /** 只统计；不再拦截（作者可以连续写多章） */
  chapterCalls: number
  /** 只统计；不再拦截 */
  portraitCalls: number
}
```

删除 `generate_chapter` 里这两行：

```ts
      if (deps.budget.chapterCalls >= deps.budget.maxChapters) {
        return fail(
          `本次会话的正文额度（${deps.budget.maxChapters} 章）已用完，这是硬上限。告诉作者点「继续执行」或开新会话；不要重试。`,
        )
      }
```

删除 `generate_portrait` 里这两段中的额度检查：

```ts
      if (deps.budget.portraitCalls >= deps.budget.maxPortraits) {
        return fail(
          `本次会话的形象图额度（${deps.budget.maxPortraits} 张）已用完，这是硬上限。告诉作者开新会话；不要重试。`,
        )
      }
```

两个工具的 `description` 里「每次 run 只允许 1 章」/「每次 run 只允许 1 张」分别改为「一次会话可连续生成多章」/「一次会话可连续生成多张」。

- [ ] **Step 4: 改 run-service 状态与暂停逻辑**

`apps/api/src/agent/run-service.ts:17`：

```ts
export type AgentRunStatus = 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped'
```

`:497-504` 初始化改为：

```ts
  const budget: RunBudget = {
    steps: 0,
    maxSteps: 80,
    chapterCalls: 0,
    portraitCalls: 0,
  }
```

`:357-360` 改为：

```ts
/** 按任务数放宽：计划 + 每任务多轮工具 + 收尾检查 */
function refreshPlanBudget(run: AgentRun, plan: Plan): void {
  run.budget.maxSteps = Math.max(80, 80 + 2 * plan.tasks.length)
}
```

`:291-299` 的 `failRun` 分支改为：

```ts
    if (plan.status === 'approved') {
      if (run.budget.steps >= run.budget.maxSteps) {
        pauseRun(run, `步数预算已用完（${run.budget.maxSteps} 步），还有任务没做完。点「继续执行」接着跑。`)
        return
      }
```

在 `failRun` 下方新增：

```ts
/**
 * 步数耗尽：暂停而不是失败。
 * ★ 不调用 finalizePlanOnRunEnd：任务必须保持 doing，resume 才会从它接着做。
 */
function pauseRun(run: AgentRun, message: string): void {
  run.status = 'paused'
  run.error = message
  run.finishedAt = new Date().toISOString()
  emit(run, { type: 'run.paused', reason: message })
  finishRun(run)
}
```

`AgentStreamPayload` 增加：

```ts
  | { type: 'run.paused'; reason: string }
```

`resumeAgentRun` 的守卫改为：

```ts
  if (run.status === 'running' || run.status === 'waiting_review') {
    throw new InkloomError('INVALID_INPUT', '这个 run 还在进行中，不需要恢复')
  }
```

（`paused` 天然允许进入；现有逻辑会重置 `steps=0` 并从 `nextOpenTask` 取回 `doing`。）

- [ ] **Step 5: 前端类型与展示**

`apps/web/src/api/types.ts`：

```ts
export type AgentRunStatus =
  | 'running'
  | 'waiting_review'
  | 'paused'
  | 'done'
  | 'failed'
  | 'stopped'
```

```ts
export interface AgentRunBudget {
  steps: number
  maxSteps: number
  chapterCalls: number
  portraitCalls: number
}
```

`apps/web/src/pages/AgentPage.tsx`：

```ts
const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: '运行中',
  waiting_review: '等待审阅',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
}

const STATUS_TONE: Record<AgentRunStatus, string> = {
  running: 'bg-amber-50 text-amber-800 border-amber-200',
  waiting_review: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  paused: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  done: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  failed: 'bg-rose-50 text-rose-800 border-rose-200',
  stopped: 'bg-neutral-100 text-neutral-600 border-neutral-200',
}
```

`apps/web/src/api/types.ts` 的 `AgentEvent` 联合在 `run.finished` 后加：

```ts
  | { seq: number; at: string; type: 'run.paused'; reason: string }
```

`apps/web/src/pages/AgentPage.tsx` 的事件分支在 `case 'run.failed'` 之前加：

```ts
    case 'run.paused':
      return [
        ...settleRunningTools(blocks),
        { kind: 'status', id: `s${ev.seq}`, text: ev.reason, tone: 'info' },
      ]
```

`canSend` 改为：

```ts
  const canSend = run !== null && run.status !== 'failed' && run.status !== 'paused'
```

（paused 必须走「继续执行」重置步数，直接发消息会立刻被步数拦住。）

`currentHint` 在 `waiting_review` 分支之后加：

```ts
  if (run.status === 'paused') return '步数用完了：点「继续执行」接着跑，任务进度不会丢'
```

`ended` 改为：

```ts
  const ended =
    run !== null &&
    (run.status === 'done' ||
      run.status === 'stopped' ||
      run.status === 'failed' ||
      run.status === 'paused')
```

预算行改为：

```tsx
              <p>
                步数 {run.budget.steps}/{run.budget.maxSteps} · 章节{' '}
                {run.budget.chapterCalls} · 图 {run.budget.portraitCalls}
              </p>
              <p className="mt-0.5">{run.tokens.toLocaleString()} tokens</p>
```

无 run 时文案改为：

```tsx
            <p>步数按任务数放宽（≥80 步） · 章节与形象图不设上限</p>
```

- [ ] **Step 6: 跑测试与类型检查**

Run: `pnpm vitest run --project unit apps/api/src/agent/run-service.test.ts apps/api/src/agent/plan-tools.test.ts`
Expected: PASS

Run: `pnpm tsc`
Expected: 无输出

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/agent/tools.ts apps/api/src/agent/run-service.ts apps/api/src/agent/run-service.test.ts apps/api/src/agent/plan-tools.test.ts apps/web/src/api/types.ts apps/web/src/pages/AgentPage.tsx
git commit -m "feat(agent): drop chapter/portrait caps and pause on step exhaustion"
```

---

## Task 2: 搜索类型与三个 provider

**Files:**
- Create: `apps/api/src/search/types.ts`
- Modify: `apps/api/src/search/tavily.ts`
- Create: `apps/api/src/search/searxng.ts`
- Create: `apps/api/src/search/duckduckgo.ts`
- Create: `apps/api/src/search/providers.test.ts`
- Modify: `apps/api/src/search/tavily.int.test.ts`
- Modify: `apps/api/package.json`（新增 linkedom）

**Interfaces:**
- Consumes: `FetchLike`（`apps/api/src/llm/types.ts`）
- Produces:
  ```ts
  export type SearchProviderId = 'tavily' | 'searxng' | 'duckduckgo'
  export interface SearchHit {
    title: string
    url: string
    snippet: string
    publishedAt?: string
    provider: SearchProviderId
  }
  export interface SearchProvider {
    readonly id: SearchProviderId
    search(query: string, maxResults: number): Promise<SearchHit[]>
  }
  export function createTavilySearch(opts: TavilySearchOptions): SearchProvider
  export function createSearxngSearch(baseUrl: string, opts?: ProviderOptions): SearchProvider
  export function createDuckDuckGoSearch(opts?: ProviderOptions): SearchProvider
  ```

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @inkloom/api add @mozilla/readability linkedom`
Expected: `apps/api/package.json` 出现两个依赖，lockfile 更新。

- [ ] **Step 2: 写类型**

`apps/api/src/search/types.ts`：

```ts
import type { FetchLike } from '../llm/types.js'

export type SearchProviderId = 'tavily' | 'searxng' | 'duckduckgo'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  publishedAt?: string
  provider: SearchProviderId
}

export interface SearchProvider {
  readonly id: SearchProviderId
  search(query: string, maxResults: number): Promise<SearchHit[]>
}

export interface SearchResult {
  hits: SearchHit[]
  provider: SearchProviderId | null
  degraded: boolean
  warnings: string[]
}

export interface ProviderOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
}
```

- [ ] **Step 3: 写失败测试**

`apps/api/src/search/providers.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { createDuckDuckGoSearch } from './duckduckgo.js'
import { createSearxngSearch } from './searxng.js'
import { createTavilySearch } from './tavily.js'

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('searxng', () => {
  it('把 results 归一化成 SearchHit', async () => {
    const fetchImpl: FetchLike = async () =>
      json({
        results: [
          { title: '剑冢考据', url: 'https://a.example/1', content: '摘要一', publishedDate: '2026-01-02' },
        ],
      })
    const p = createSearxngSearch('https://searx.example', { fetchImpl })
    const hits = await p.search('剑冢', 5)
    expect(p.id).toBe('searxng')
    expect(hits).toEqual([
      {
        title: '剑冢考据',
        url: 'https://a.example/1',
        snippet: '摘要一',
        publishedAt: '2026-01-02',
        provider: 'searxng',
      },
    ])
  })

  it('★ HTTP 失败抛状态码', async () => {
    const fetchImpl: FetchLike = async () => html('forbidden', 403)
    await expect(createSearxngSearch('https://searx.example', { fetchImpl }).search('q', 3)).rejects.toThrow(
      'searxng 403',
    )
  })

  it('★ 丢掉没有 url 的脏结果', async () => {
    const fetchImpl: FetchLike = async () => json({ results: [{ title: '无链接' }, { url: 'https://a.example/2' }] })
    const hits = await createSearxngSearch('https://searx.example', { fetchImpl }).search('q', 3)
    expect(hits.map((h) => h.url)).toEqual(['https://a.example/2'])
  })
})

describe('duckduckgo lite', () => {
  it('解析 result-link 与 result-snippet', async () => {
    const fetchImpl: FetchLike = async () =>
      html(`
        <table>
          <tr><td><a class="result-link" href="https://b.example/x">剑冢是什么</a></td></tr>
          <tr><td class="result-snippet">一种埋剑的墓。</td></tr>
        </table>`)
    const hits = await createDuckDuckGoSearch({ fetchImpl }).search('剑冢', 5)
    expect(hits).toEqual([
      { title: '剑冢是什么', url: 'https://b.example/x', snippet: '一种埋剑的墓。', provider: 'duckduckgo' },
    ])
  })

  it('★ 挑战页（没有 result-link）返回空数组，不抛错', async () => {
    const fetchImpl: FetchLike = async () => html('<html><body>challenge</body></html>')
    await expect(createDuckDuckGoSearch({ fetchImpl }).search('q', 3)).resolves.toEqual([])
  })
})

describe('tavily', () => {
  it('返回 snippet 与 provider', async () => {
    const fetchImpl: FetchLike = async () =>
      json({ results: [{ title: 'T', url: 'https://c.example', content: 'C' }] })
    const hits = await createTavilySearch({ apiKey: 'k', fetchImpl }).search('q', 3)
    expect(hits[0]).toMatchObject({ title: 'T', url: 'https://c.example', snippet: 'C', provider: 'tavily' })
  })
})
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/search/providers.test.ts`
Expected: FAIL — `createSearxngSearch` / `createDuckDuckGoSearch` 不存在。

- [ ] **Step 5: 实现三个 provider**

`apps/api/src/search/tavily.ts` 改 import 与返回：

```ts
import type { FetchLike } from '../llm/types.js'
import type { SearchHit, SearchProvider, ProviderOptions } from './types.js'

export interface TavilySearchOptions extends ProviderOptions {
  apiKey: string
  baseUrl?: string
}
```

`search` 的返回改为：

```ts
      return (body.results ?? [])
        .filter((r) => typeof r.url === 'string')
        .map((r) => ({
          title: r.title ?? r.url ?? '',
          url: r.url ?? '',
          snippet: r.content ?? '',
          provider: 'tavily' as const,
        }))
```

并在 `fetchImpl(...)` 的 init 里加超时（与其它 provider 一致）：

```ts
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
```

`apps/api/src/search/searxng.ts`：

```ts
import type { FetchLike } from '../llm/types.js'
import type { ProviderOptions, SearchHit, SearchProvider } from './types.js'

interface SearxngResult {
  title?: string
  url?: string
  content?: string
  publishedDate?: string
}

export function createSearxngSearch(baseUrl: string, opts: ProviderOptions = {}): SearchProvider {
  const base = baseUrl.replace(/\/+$/, '')
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'searxng',
    async search(query, maxResults) {
      const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN&safesearch=1`
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': 'inkloom/0.0.1' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      })
      if (!res.ok) throw new Error(`searxng ${res.status}`)

      const body = (await res.json()) as { results?: SearxngResult[] }
      return (body.results ?? [])
        .filter((r): r is SearxngResult & { url: string } => typeof r.url === 'string' && r.url.length > 0)
        .slice(0, maxResults)
        .map((r): SearchHit => ({
          title: r.title ?? r.url,
          url: r.url,
          snippet: r.content ?? '',
          ...(r.publishedDate === undefined ? {} : { publishedAt: r.publishedDate }),
          provider: 'searxng',
        }))
    },
  }
}
```

`apps/api/src/search/duckduckgo.ts`：

```ts
import { parseHTML } from 'linkedom'
import type { FetchLike } from '../llm/types.js'
import type { ProviderOptions, SearchHit, SearchProvider } from './types.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * DuckDuckGo lite：无 key 兜底。
 * ★ 它是 HTML 抓取，结构随时可能变；没有 result-link 时返回空数组，由上层提示降级。
 */
export function createDuckDuckGoSearch(opts: ProviderOptions = {}): SearchProvider {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'duckduckgo',
    async search(query, maxResults) {
      const res = await fetchImpl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      })
      if (!res.ok) throw new Error(`duckduckgo ${res.status}`)

      const { document } = parseHTML(await res.text())
      const links = [...document.querySelectorAll('a.result-link')].slice(0, maxResults)
      const snippets = [...document.querySelectorAll('td.result-snippet')]

      return links
        .map((a, i): SearchHit => ({
          title: (a.textContent ?? '').trim(),
          url: a.getAttribute('href') ?? '',
          snippet: (snippets[i]?.textContent ?? '').trim(),
          provider: 'duckduckgo',
        }))
        .filter((h) => h.url.length > 0)
    },
  }
}
```

- [ ] **Step 6: 适配旧测试**

`apps/api/src/search/tavily.int.test.ts`：把所有 `content` 断言改为 `snippet`；`expect(provider.id).toBe('tavily')` 保留。

- [ ] **Step 7: 跑测试**

Run: `pnpm vitest run --project unit apps/api/src/search/providers.test.ts`
Run: `pnpm vitest run --project integration apps/api/src/search/tavily.int.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/search
git commit -m "feat(search): add searxng and duckduckgo providers with shared types"
```

---

## Task 3: 搜索降级链与熔断

**Files:**
- Create: `apps/api/src/search/service.ts`
- Create: `apps/api/src/search/service.test.ts`

**Interfaces:**
- Consumes: `SearchProvider` / `SearchResult`（Task 2）
- Produces:
  ```ts
  export interface SearchService {
    search(query: string, maxResults?: number): Promise<SearchResult>
    available(): SearchProviderId[]
  }
  export function createSearchService(opts?: {
    env?: NodeJS.ProcessEnv
    fetchImpl?: FetchLike
    now?: () => number
  }): SearchService
  ```

- [ ] **Step 1: 写失败测试**

`apps/api/src/search/service.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { createSearchService, resetSearchBreakersForTest } from './service.js'

beforeEach(() => resetSearchBreakersForTest())

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('search service', () => {
  it('有 TAVILY key 时优先 Tavily，degraded=false', async () => {
    const fetchImpl: FetchLike = async () =>
      json({ results: [{ title: 'T', url: 'https://a.example', content: 'S' }] })
    const svc = createSearchService({ env: { TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv, fetchImpl })
    const r = await svc.search('q')
    expect(r.provider).toBe('tavily')
    expect(r.degraded).toBe(false)
    expect(r.hits).toHaveLength(1)
  })

  it('★ Tavily 失败后降级到 SearXNG，并记录 warning', async () => {
    let call = 0
    const fetchImpl: FetchLike = async () => {
      call += 1
      if (call === 1) return json({ detail: 'bad' }, 401)
      return json({ results: [{ title: 'S', url: 'https://b.example', content: 'X' }] })
    }
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k', SEARXNG_BASE_URLS: 'https://searx.example' } as NodeJS.ProcessEnv,
      fetchImpl,
    })
    const r = await svc.search('q')
    expect(r.provider).toBe('searxng')
    expect(r.degraded).toBe(true)
    expect(r.warnings.join(' ')).toContain('tavily')
  })

  it('★ 无 key 时走 DuckDuckGo，degraded=true', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('<a class="result-link" href="https://c.example">C</a><td class="result-snippet">S</td>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    const svc = createSearchService({ env: {} as NodeJS.ProcessEnv, fetchImpl })
    const r = await svc.search('q')
    expect(r.provider).toBe('duckduckgo')
    expect(r.degraded).toBe(true)
  })

  it('★ 连续 2 次失败后熔断 10 分钟，不再请求该 provider', async () => {
    const fetchImpl = vi.fn(async () => json({ detail: 'down' }, 500)) as unknown as FetchLike
    let now = 0
    const svc = createSearchService({
      env: { TAVILY_API_KEY: 'k' } as NodeJS.ProcessEnv,
      fetchImpl,
      now: () => now,
    })

    await svc.search('a')
    await svc.search('b')
    const before = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    now += 60_000
    await svc.search('c')
    const after = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length

    // calls: 2 次 tavily + 2 次 ddg；第 3 次只剩 ddg
    expect(before).toBe(4)
    expect(after).toBe(5)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/search/service.test.ts`
Expected: FAIL — `service.ts` 不存在。

- [ ] **Step 3: 实现 service**

`apps/api/src/search/service.ts`：

```ts
import type { FetchLike } from '../llm/types.js'
import { createDuckDuckGoSearch } from './duckduckgo.js'
import { createSearxngSearch } from './searxng.js'
import { createTavilySearch } from './tavily.js'
import type { SearchProvider, SearchProviderId, SearchResult } from './types.js'

export interface SearchService {
  search(query: string, maxResults?: number): Promise<SearchResult>
  available(): SearchProviderId[]
}

interface Breaker {
  count: number
  until: number
}

const OPEN_MS = 10 * 60_000
const MAX_FAILURES = 2

/** 进程级熔断表：跨多次工具调用保持；测试用 resetSearchBreakersForTest 清空 */
const breakers = new Map<string, Breaker>()

export function resetSearchBreakersForTest(): void {
  breakers.clear()
}

function buildProviders(env: NodeJS.ProcessEnv, fetchImpl?: FetchLike): SearchProvider[] {
  const out: SearchProvider[] = []
  const tavilyKey = (env['TAVILY_API_KEY'] ?? '').trim()
  if (tavilyKey.length > 0) out.push(createTavilySearch({ apiKey: tavilyKey, ...(fetchImpl ? { fetchImpl } : {}) }))

  const bases = (env['SEARXNG_BASE_URLS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const base of bases) out.push(createSearxngSearch(base, fetchImpl ? { fetchImpl } : {}))

  out.push(createDuckDuckGoSearch(fetchImpl ? { fetchImpl } : {}))
  return out
}

export function createSearchService(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => number } = {},
): SearchService {
  const env = opts.env ?? process.env
  const now = opts.now ?? (() => Date.now())
  const providers = buildProviders(env, opts.fetchImpl)

  function isOpen(id: string): boolean {
    const b = breakers.get(id)
    return b !== undefined && b.until > now()
  }

  function fail(id: string): void {
    const b = breakers.get(id) ?? { count: 0, until: 0 }
    b.count += 1
    if (b.count >= MAX_FAILURES) {
      b.until = now() + OPEN_MS
      b.count = 0
    }
    breakers.set(id, b)
  }

  return {
    available: () => providers.map((p) => p.id),

    async search(query, maxResults = 5) {
      const warnings: string[] = []
      for (const provider of providers) {
        if (isOpen(provider.id)) {
          warnings.push(`${provider.id}：熔断中，跳过`)
          continue
        }
        try {
          const hits = await provider.search(query, maxResults)
          breakers.delete(provider.id)
          return { hits, provider: provider.id, degraded: provider.id !== 'tavily', warnings }
        } catch (e) {
          fail(provider.id)
          warnings.push(`${provider.id}：${(e as Error).message.slice(0, 120)}`)
        }
      }
      return { hits: [], provider: null, degraded: true, warnings }
    },
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `pnpm vitest run --project unit apps/api/src/search/service.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/search/service.ts apps/api/src/search/service.test.ts
git commit -m "feat(search): provider fallback chain with breaker"
```

---

## Task 4: `read_url` 的 URL 校验与正文提取

**Files:**
- Create: `apps/api/src/search/ssrf.ts`
- Create: `apps/api/src/search/extract.ts`
- Create: `apps/api/src/search/extract.test.ts`

**Interfaces:**
- Consumes: `FetchLike`
- Produces:
  ```ts
  export function assertPublicUrl(raw: string): URL
  export interface ExtractResult {
    title: string
    text: string
    url: string
    extracted: boolean
  }
  export function decodeHtml(buf: ArrayBuffer, contentType: string | null): string
  export async function fetchReadable(
    url: string,
    opts?: { fetchImpl?: FetchLike; maxChars?: number; timeoutMs?: number },
  ): Promise<ExtractResult>
  ```

- [ ] **Step 1: 写失败测试**

`apps/api/src/search/extract.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { decodeHtml, fetchReadable } from './extract.js'
import { assertPublicUrl } from './ssrf.js'

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
}

describe('assertPublicUrl', () => {
  it('拒绝本机与内网', () => {
    for (const bad of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://10.0.0.2/x',
      'http://172.20.1.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest',
      'http://[::1]/x',
      'file:///c:/secret.txt',
    ]) {
      expect(() => assertPublicUrl(bad)).toThrow()
    }
  })

  it('放行公网 http/https', () => {
    expect(assertPublicUrl('https://example.com/a?b=1').hostname).toBe('example.com')
  })
})

describe('decodeHtml', () => {
  it('按 header 的 charset 解码 gb18030', () => {
    // "中文" 的 GBK 字节
    const buf = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer
    expect(decodeHtml(buf, 'text/html; charset=gb18030')).toBe('中文')
  })

  it('从 meta charset 推断', () => {
    const bytes = Uint8Array.from([
      ...Buffer.from('<meta charset="gbk"><p>', 'latin1'),
      0xd6, 0xd0, 0xce, 0xc4,
      ...Buffer.from('</p>', 'latin1'),
    ]).buffer
    expect(decodeHtml(bytes, 'text/html')).toContain('中文')
  })
})

describe('fetchReadable', () => {
  it('提取正文并截断', async () => {
    const long = '剑冢是一种埋剑的墓。'.repeat(400)
    const fetchImpl: FetchLike = async () => html(`<html><head><title>剑冢</title></head><body><article><p>${long}</p></article></body></html>`)
    const r = await fetchReadable('https://example.com/a', { fetchImpl, maxChars: 500 })
    expect(r.title).toBe('剑冢')
    expect(r.extracted).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(500)
  })

  it('★ 正文提取失败时退回纯文本，extracted=false', async () => {
    const fetchImpl: FetchLike = async () => html('<html><body>只有一句话</body></html>')
    const r = await fetchReadable('https://example.com/b', { fetchImpl })
    expect(r.extracted).toBe(false)
    expect(r.text).toContain('只有一句话')
  })

  it('★ 非 HTML 直接拒绝', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('binary', { status: 200, headers: { 'content-type': 'application/pdf' } })
    await expect(fetchReadable('https://example.com/c', { fetchImpl })).rejects.toThrow('不是网页')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/search/extract.test.ts`
Expected: FAIL — `extract.ts` / `ssrf.ts` 不存在。

- [ ] **Step 3: 实现 URL 校验**

`apps/api/src/search/ssrf.ts`：

```ts
/** 只允许公网 http(s)；拒绝本机、内网、链路本地与 file。 */
export function assertPublicUrl(raw: string): URL {
  const u = new URL(raw)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 链接')

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址')
  if (host === '::1' || host === '0.0.0.0') throw new Error('不允许访问本机地址')
  if (/^127\./.test(host)) throw new Error('不允许访问本机地址')
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    throw new Error('不允许访问内网地址')
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('不允许访问内网地址')

  return u
}
```

- [ ] **Step 4: 实现正文提取**

`apps/api/src/search/extract.ts`：

```ts
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import type { FetchLike } from '../llm/types.js'
import { assertPublicUrl } from './ssrf.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_BYTES = 5 * 1024 * 1024

export interface ExtractResult {
  title: string
  text: string
  url: string
  extracted: boolean
}

function charsetOf(contentType: string | null, head: string): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]
  if (fromHeader !== undefined) return fromHeader.toLowerCase()
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1]
  return (fromMeta ?? 'utf-8').toLowerCase()
}

/** 先把字节按声明编码解码，再做 DOM 解析；gb18030 由 TextDecoder 支持。 */
export function decodeHtml(buf: ArrayBuffer, contentType: string | null): string {
  const head = new TextDecoder('utf-8').decode(buf.slice(0, 2048))
  const charset = charsetOf(contentType, head)
  try {
    return new TextDecoder(charset).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

export async function fetchReadable(
  url: string,
  opts: { fetchImpl?: FetchLike; maxChars?: number; timeoutMs?: number } = {},
): Promise<ExtractResult> {
  const target = assertPublicUrl(url)
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  const res = await fetchImpl(target.toString(), {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  })
  if (!res.ok) throw new Error(`读取失败：HTTP ${res.status}`)

  const contentType = res.headers.get('content-type')
  if (contentType !== null && !contentType.includes('text/html')) {
    throw new Error(`不是网页：${contentType}`)
  }

  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new Error('网页太大（超过 5MB）')

  const html = decodeHtml(buf, contentType)
  const { document } = parseHTML(html)
  const maxChars = opts.maxChars ?? 6000

  try {
    const doc = document as unknown as ConstructorParameters<typeof Readability>[0]
    const article = new Readability(doc).parse()
    const text = (article?.textContent ?? '').trim()
    if (text.length > 0) {
      return {
        title: (article?.title ?? document.title ?? '').trim(),
        text: text.slice(0, maxChars),
        url: target.toString(),
        extracted: true,
      }
    }
  } catch {
    // 落到纯文本兜底
  }

  const fallback = (document.body?.textContent ?? '').trim()
  return {
    title: (document.title ?? '').trim(),
    text: fallback.slice(0, Math.min(maxChars, 3000)),
    url: target.toString(),
    extracted: false,
  }
}
```

- [ ] **Step 5: 跑测试**

Run: `pnpm vitest run --project unit apps/api/src/search/extract.test.ts`
Expected: PASS

若 meta charset 用例失败，打印 `charsetOf` 的判定结果并修正正则；不要改测试期望。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/search/ssrf.ts apps/api/src/search/extract.ts apps/api/src/search/extract.test.ts
git commit -m "feat(search): readable extraction with ssrf guard and charset detection"
```

---

## Task 5: 资料卡存储与三个 Agent 工具

**Files:**
- Create: `apps/api/src/services/lore-service.ts`
- Create: `apps/api/src/services/lore-service.int.test.ts`
- Modify: `apps/api/src/agent/tools.ts`（`AgentToolDeps`、三个工具、返回数组）
- Modify: `apps/api/src/agent/run-service.ts`（注入 `getRunId`）
- Create: `apps/api/src/agent/web-tools.test.ts`

**Interfaces:**
- Consumes: `IndexDb`、`SearchService`、`fetchReadable`、`SearchHit`
- Produces:
  ```ts
  export async function saveSearchHits(
    db: IndexDb, projectId: string, runId: string, query: string, hits: SearchHit[],
  ): Promise<{ id: string; title: string; url: string }[]>
  export async function savePage(
    db: IndexDb, projectId: string, runId: string, page: ExtractResult,
  ): Promise<{ id: string }>
  export async function getLoreForRun(db: IndexDb, id: string, runId: string): Promise<LoreView | null>
  export interface LoreView { id: string; title: string; url: string; snippet: string; content: string | null; provider: string }
  ```

- [ ] **Step 1: 写集成测试**

`apps/api/src/services/lore-service.int.test.ts`：

```ts
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { getLoreForRun, savePage, saveSearchHits } from './lore-service.js'

async function freshDb(): Promise<{ db: Awaited<ReturnType<typeof freshIndexDb>>; projectId: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'inkloom-lore-'))
  const db = await freshIndexDb(dir)
  const { project } = await createProject({ rootPath: join(dir, 'book'), name: '测试书', genre: '玄幻' })
  return { db, projectId: project.id }
}

describe('lore service', () => {
  it('搜索结果落卡，带 provider 与 runId，默认未批准', async () => {
    const { db, projectId } = await freshDb()
    try {
      const ids = await saveSearchHits(db, projectId, 'ar_1', '剑冢 设定', [
        { title: '剑冢', url: 'https://a.example', snippet: '摘要', provider: 'tavily' },
      ])
      expect(ids).toHaveLength(1)
      const row = await db.loreReference.findUnique({ where: { id: ids[0]?.id } })
      expect(row?.provider).toBe('tavily')
      expect(row?.approved).toBe(false)
      expect(row?.usedInRunIds).toContain('ar_1')
    } finally {
      await db.$disconnect()
    }
  })

  it('★ 本 run 的卡可读；别的 run 未批准不可读', async () => {
    const { db, projectId } = await freshDb()
    try {
      const [{ id }] = await saveSearchHits(db, projectId, 'ar_1', 'q', [
        { title: 'T', url: 'https://a.example', snippet: 'S', provider: 'searxng' },
      ])
      expect((await getLoreForRun(db, id as string, 'ar_1'))?.title).toBe('T')
      expect(await getLoreForRun(db, id as string, 'ar_2')).toBeNull()
    } finally {
      await db.$disconnect()
    }
  })

  it('read_url 的正文进 content', async () => {
    const { db, projectId } = await freshDb()
    try {
      const { id } = await savePage(db, projectId, 'ar_1', {
        title: '页面', url: 'https://b.example', text: '正文正文', extracted: true,
      })
      const row = await db.loreReference.findUnique({ where: { id } })
      expect(row?.content).toBe('正文正文')
      expect(row?.provider).toBe('url')
    } finally {
      await db.$disconnect()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:int -- apps/api/src/services/lore-service.int.test.ts`
Expected: FAIL — `lore-service.ts` 不存在。

- [ ] **Step 3: 实现 lore service**

`apps/api/src/services/lore-service.ts`：

```ts
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

export async function getLoreForRun(db: IndexDb, id: string, runId: string): Promise<LoreView | null> {
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
```

- [ ] **Step 4: 跑集成测试**

Run: `pnpm test:int -- apps/api/src/services/lore-service.int.test.ts`
Expected: PASS

- [ ] **Step 5: 写工具测试**

`apps/api/src/agent/web-tools.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  search: vi.fn(),
  saveHits: vi.fn(),
  savePage: vi.fn(),
  getLore: vi.fn(),
  fetchReadable: vi.fn(),
}))

vi.mock('../search/service.js', () => ({
  createSearchService: () => ({ search: h.search, available: () => ['duckduckgo'] }),
}))
vi.mock('../services/lore-service.js', () => ({
  saveSearchHits: h.saveHits,
  savePage: h.savePage,
  getLoreForRun: h.getLore,
}))
vi.mock('../search/extract.js', () => ({ fetchReadable: h.fetchReadable }))
vi.mock('../services/context.js', () => ({
  getContext: () => ({ root: 'C:/book', project: { id: 'p1' }, db: {} }),
}))

import { createAgentTools } from './tools.js'

function tool(name: string) {
  const deps = {
    apiKey: 'k',
    imageApiKey: null,
    model: 'm',
    budget: { steps: 0, maxSteps: 80, chapterCalls: 0, portraitCalls: 0 },
    plan: { getPlanId: () => null, setPlanId: () => undefined, notify: () => undefined },
    onGate: () => undefined,
    getRunId: () => 'ar_1',
  }
  const found = createAgentTools(deps).find((t) => t.name === name)
  if (found === undefined) throw new Error(`没有工具 ${name}`)
  return found
}

describe('web tools', () => {
  it('web_search 落卡并在文本里带资料卡 id', async () => {
    h.search.mockResolvedValue({
      hits: [{ title: 'T', url: 'https://a.example', snippet: 'S', provider: 'duckduckgo' }],
      provider: 'duckduckgo',
      degraded: true,
      warnings: [],
    })
    h.saveHits.mockResolvedValue([{ id: 'lr-abcdef12', title: 'T', url: 'https://a.example' }])

    const res = await tool('web_search').execute('1', { query: '剑冢' })
    expect(res.isError).toBeFalsy()
    expect(String(res.content[0]?.text)).toContain('lr-abcdef12')
    expect(String(res.content[0]?.text)).toContain('duckduckgo')
  })

  it('read_url 把正文落卡并返回标题', async () => {
    h.fetchReadable.mockResolvedValue({ title: '页面', url: 'https://b.example', text: '正文', extracted: true })
    h.savePage.mockResolvedValue({ id: 'lr-11112222' })

    const res = await tool('read_url').execute('2', { url: 'https://b.example' })
    expect(String(res.content[0]?.text)).toContain('页面')
    expect(String(res.content[0]?.text)).toContain('lr-11112222')
  })

  it('★ read_lore 读不到时 isError', async () => {
    h.getLore.mockResolvedValue(null)
    const res = await tool('read_lore').execute('3', { id: 'lr-nope' })
    expect(res.isError).toBe(true)
  })
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm vitest run --project unit apps/api/src/agent/web-tools.test.ts`
Expected: FAIL — 工具不存在。

- [ ] **Step 7: 实现三个工具**

`apps/api/src/agent/tools.ts` 顶部加：

```ts
import { createSearchService } from '../search/service.js'
import { fetchReadable } from '../search/extract.js'
import { getLoreForRun, savePage, saveSearchHits } from '../services/lore-service.js'
```

`AgentToolDeps` 加：

```ts
  /** 当前 run id：资料卡用它判断「本 run 可读」 */
  getRunId: () => string
```

参数 schema（放在 `GENERATE_CHAPTER` 附近）：

```ts
const WEB_SEARCH = Type.Object({
  query: Type.String({ minLength: 1, description: '搜索词，尽量具体' }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: '默认 5' })),
})

const READ_URL = Type.Object({
  url: Type.String({ minLength: 8, description: 'http/https 公网地址' }),
  maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 12000, description: '默认 6000' })),
})

const READ_LORE = Type.Object({
  id: Type.String({ minLength: 4, description: '资料卡 id，形如 lr-a1b2c3d4' }),
})
```

三个工具（放在 `readElementTool` 之后）：

```ts
  const webSearchTool: AgentTool<typeof WEB_SEARCH> = {
    name: 'web_search',
    label: '联网搜索',
    description:
      '搜索公开网页，返回标题/链接/摘要，并把每条结果落成资料卡（默认未批准）。需要外部考据时用；一次一个问题，不要连续搜同一主题。',
    parameters: WEB_SEARCH,
    execute: async (_id, params) => {
      const ctx = getContext()
      const r = await createSearchService().search(params.query, params.maxResults ?? 5)
      if (r.hits.length === 0) {
        return fail(
          `没有搜到结果${r.warnings.length > 0 ? `（${r.warnings.join('；')}）` : ''}。可以换个说法，或让作者在设置里配搜索 key。`,
        )
      }
      const saved = await saveSearchHits(ctx.db, ctx.project.id, deps.getRunId(), params.query, r.hits)
      const lines = saved.map((s, i) => `${i + 1}. ${s.title} — ${s.url}（资料卡 ${s.id}）`)
      return ok(
        `找到 ${saved.length} 条（provider=${r.provider ?? 'none'}${r.degraded ? '，已降级' : ''}）\n${lines.join('\n')}`,
        { provider: r.provider, degraded: r.degraded, ids: saved.map((s) => s.id) },
      )
    },
  }

  const readUrlTool: AgentTool<typeof READ_URL> = {
    name: 'read_url',
    label: '读取网页正文',
    description:
      '抓取一个公网网页并提取正文（最长 1.2 万字），落成资料卡后返回摘要。一次只读一个链接。',
    parameters: READ_URL,
    execute: async (_id, params) => {
      try {
        const ctx = getContext()
        const page = await fetchReadable(params.url, {
          ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars }),
        })
        const { id } = await savePage(ctx.db, ctx.project.id, deps.getRunId(), page)
        return ok(
          `已读取「${page.title || page.url}」（${page.text.length} 字，extracted=${page.extracted}，资料卡 ${id}）\n\n${page.text.slice(0, 2000)}`,
          { id, url: page.url, extracted: page.extracted },
        )
      } catch (e) {
        return fail(`读取失败：${(e as Error).message}`)
      }
    },
  }

  const readLoreTool: AgentTool<typeof READ_LORE> = {
    name: 'read_lore',
    label: '读取资料卡',
    description: '读取本次会话搜到/抓到的资料卡正文；跨会话的卡必须作者批准过才可读。',
    parameters: READ_LORE,
    execute: async (_id, params) => {
      const ctx = getContext()
      const row = await getLoreForRun(ctx.db, params.id, deps.getRunId())
      if (row === null) {
        return fail(`资料卡 ${params.id} 不存在，或未获作者批准（跨会话资料需要先在资料页批准）`)
      }
      const body = row.content ?? row.snippet
      return ok(`${row.title} — ${row.url}\n\n${body.slice(0, 4000)}`, { id: row.id, provider: row.provider })
    },
  }
```

返回数组加上这三个：

```ts
  return [
    readBook,
    readElementTool,
    webSearchTool,
    readUrlTool,
    readLoreTool,
    writeElementTool,
    ...
  ]
```

- [ ] **Step 8: 在 run-service 注入 runId**

`startAgentRun` 里 `createAgentTools({...})` 增加：

```ts
    getRunId: () => run.id,
```

（`run` 在之后才赋值，但工具执行时一定已赋值；沿用现有 `getPlanId` 的闭包模式。）

同时 `apps/api/src/agent/plan-tools.test.ts:88` 的 `createAgentTools({...})` 参数在 `onGate` 后补：

```ts
    getRunId: () => 'ar_test',
```

- [ ] **Step 9: 跑测试**

Run: `pnpm vitest run --project unit apps/api/src/agent/web-tools.test.ts`
Expected: PASS

Run: `pnpm test:int -- apps/api/src/services/lore-service.int.test.ts`
Expected: PASS

- [ ] **Step 10: 提交**

```bash
git add apps/api/src/services/lore-service.ts apps/api/src/services/lore-service.int.test.ts apps/api/src/agent/tools.ts apps/api/src/agent/web-tools.test.ts apps/api/src/agent/run-service.ts
git commit -m "feat(agent): web_search/read_url/read_lore tools with lore cards"
```

---

## Task 6: 资料卡 HTTP、`/search` 改造与设置项

**Files:**
- Create: `apps/api/src/routes/lore.ts`
- Modify: `apps/api/src/app.ts:14-40`
- Modify: `apps/api/src/routes/actions.ts:139-153`
- Modify: `apps/api/src/routes/settings.ts:18-45`
- Modify: `apps/api/src/routes/api.http.test.ts`（文末追加 lore 用例）

**Interfaces:**
- Consumes: `listLore` / `approveLore` / `deleteLore`、`createSearchService`
- Produces:
  - `GET /api/lore?approved=&limit=`
  - `POST /api/lore/:id/approve`
  - `DELETE /api/lore/:id`
  - `POST /api/search` 返回 `{ provider, query, hits, degraded, warnings }`

- [ ] **Step 1: 写 HTTP 测试**

在 `apps/api/src/routes/api.http.test.ts` 末尾追加（该文件已有 `db` / `pid` / `base` 夹具与 `createApp`）：

```ts
describe('lore', () => {
  async function seedLore(): Promise<string> {
    const id = 'lr-test0001'
    await db.loreReference.create({
      data: {
        id,
        projectId: pid,
        query: '剑冢',
        provider: 'tavily',
        title: '剑冢考据',
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
    expect(b1.items.map((x) => x.id)).toContain(id)

    const okRes = await createApp().request(`/api/lore/${id}/approve`, { method: 'POST' })
    expect(okRes.status).toBe(200)

    const after = await createApp().request('/api/lore?approved=1&limit=5')
    const b2 = (await after.json()) as { items: { id: string }[] }
    expect(b2.items.map((x) => x.id)).toContain(id)
  })

  it('★ 批准不存在的卡片返回 404', async () => {
    const res = await createApp().request('/api/lore/lr-nope/approve', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('★ q 过滤标题', async () => {
    await seedLore()
    const res = await createApp().request('/api/lore?q=剑冢')
    const body = (await res.json()) as { items: { title: string }[] }
    expect(body.items).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:int -- apps/api/src/routes/api.http.test.ts`
Expected: FAIL — `/api/lore` 404。

- [ ] **Step 3: 实现路由**

`apps/api/src/routes/lore.ts`：

```ts
import { Hono } from 'hono'
import { InkloomError } from '@inkloom/shared'
import { getContext } from '../services/context.js'
import { approveLore, deleteLore, listLore } from '../services/lore-service.js'

export const loreRoutes = new Hono()

loreRoutes.get('/lore', async (c) => {
  const { db, project } = getContext()
  const approvedRaw = c.req.query('approved')
  const q = c.req.query('q')?.trim()
  const limitRaw = Number(c.req.query('limit') ?? '50')
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50
  const items = await listLore(db, project.id, {
    ...(approvedRaw === '1' ? { approved: true } : {}),
    ...(approvedRaw === '0' ? { approved: false } : {}),
    ...(q === undefined || q.length === 0 ? {} : { q }),
    limit,
  })
  return c.json({ items })
})

loreRoutes.post('/lore/:id/approve', async (c) => {
  const { db } = getContext()
  const row = await approveLore(db, c.req.param('id')).catch(() => null)
  if (row === null) throw new InkloomError('NOT_FOUND', '资料卡不存在')
  return c.json(row)
})

loreRoutes.delete('/lore/:id', async (c) => {
  const { db } = getContext()
  try {
    await deleteLore(db, c.req.param('id'))
    return c.json({ ok: true })
  } catch (e) {
    const msg = (e as Error).message
    if (msg === 'NOT_FOUND') throw new InkloomError('NOT_FOUND', '资料卡不存在')
    throw new InkloomError('INVALID_INPUT', msg)
  }
})
```

`apps/api/src/app.ts` 加 import 与挂载：

```ts
import { loreRoutes } from './routes/lore.js'
```

```ts
  app.route('/api', loreRoutes)
```

- [ ] **Step 4: 改 `/search`**

`apps/api/src/routes/actions.ts`：

```ts
import { createSearchService } from '../search/service.js'
```

`actions.post('/search')` 改为：

```ts
  actions.post('/search', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { query?: string; maxResults?: number }
    const query = body.query?.trim() ?? ''
    if (query.length === 0) throw new InkloomError('INVALID_INPUT', '缺少 query')

    const max = Math.min(Math.max(body.maxResults ?? 5, 1), 8)
    const r = await createSearchService().search(query, max)
    return c.json({ query, ...r })
  })
```

删除旧的 `TAVILY_API_KEY` 检查与 `createTavilySearch` import。

- [ ] **Step 5: 设置项**

`apps/api/src/routes/settings.ts` 的 `WRITABLE` 加 `'SEARXNG_BASE_URLS'`（放在 `TAVILY_API_KEY` 后）。`SECRET` 不加（不是密钥）。`DEFAULTS` 不加。

- [ ] **Step 6: 跑测试**

Run: `pnpm test:int -- apps/api/src/routes/api.http.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add apps/api/src/routes/lore.ts apps/api/src/routes/api.http.test.ts apps/api/src/routes/actions.ts apps/api/src/routes/settings.ts apps/api/src/app.ts
git commit -m "feat(api): lore routes, multi-provider search endpoint and searxng setting"
```

---

## Task 7: 前端搜索与资料卡

**Files:**
- Modify: `apps/web/src/api/types.ts:173-183`、文末加 Lore 类型
- Modify: `apps/web/src/api/hooks.ts:298-302`、文末加 lore hooks
- Modify: `apps/web/src/components/Toolbar.tsx:277-312`
- Modify: `apps/web/src/pages/AgentPage.tsx:32-43`（工具标签）
- Modify: `apps/web/src/pages/SettingsPage.tsx:10-28`

**Interfaces:**
- Consumes: Task 6 的 HTTP
- Produces:
  ```ts
  export interface SearchHit { title: string; url: string; snippet: string; provider: string }
  export interface SearchResult { provider: string | null; query: string; hits: SearchHit[]; degraded: boolean; warnings: string[] }
  export interface LoreItem { id: string; title: string; url: string; snippet: string; content: string | null; provider: string }
  export function useLore(approved?: boolean): UseQueryResult<{ items: LoreItem[] }>
  export function useApproveLore(): UseMutationResult<LoreItem, Error, string>
  ```

- [ ] **Step 1: 改类型**

`apps/web/src/api/types.ts`：

```ts
export interface SearchHit {
  title: string
  url: string
  snippet: string
  provider: string
}

export interface SearchResult {
  provider: string | null
  query: string
  hits: SearchHit[]
  degraded: boolean
  warnings: string[]
}
```

文末追加：

```ts
export interface LoreItem {
  id: string
  title: string
  url: string
  snippet: string
  content: string | null
  provider: string
}
```

- [ ] **Step 2: 加 hooks**

`apps/web/src/api/hooks.ts` 文末：

```ts
export function useLore(approved?: boolean) {
  return useQuery({
    queryKey: ['lore', approved ?? 'all'],
    queryFn: () =>
      api<{ items: LoreItem[] }>(
        `/lore${approved === undefined ? '' : `?approved=${approved ? '1' : '0'}`}`,
      ),
  })
}

export function useApproveLore() {
  return useMutation({
    mutationFn: (id: string) => post<LoreItem>(`/lore/${id}/approve`, {}),
  })
}

export function useDeleteLore() {
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/lore/${id}`, { method: 'DELETE' }),
  })
}
```

`hooks.ts` 顶部已有 `import { api, post } from './client'`，不需要新增导入。

- [ ] **Step 3: 改 Toolbar 展示**

`apps/web/src/components/Toolbar.tsx` 的搜索结果块改为：

```tsx
          {found !== null && (
            <div className="mt-2 space-y-1 text-xs">
              <p className="text-[10px] text-neutral-400">
                {found.provider ?? '无可用搜索源'}
                {found.degraded ? ' · 已降级（未配置 key）' : ''}
              </p>
              {found.hits.map((h) => (
                <a
                  key={h.url}
                  href={h.url}
                  target="_blank"
                  rel="noreferrer"
                  title={h.snippet}
                  className="block truncate text-blue-700 hover:underline"
                >
                  {h.title}
                </a>
              ))}
              {found.hits.length === 0 && (
                <p className="text-neutral-400">
                  没有结果{found.warnings.length > 0 ? `：${found.warnings[0]}` : ''}
                </p>
              )}
            </div>
          )}
```

若 `hits` 为空但 `provider=null`，页面仍显示提示。

- [ ] **Step 4: 工具标签**

`apps/web/src/pages/AgentPage.tsx` 的 `TOOL_LABEL` 加：

```ts
  web_search: '联网搜索',
  read_url: '读网页',
  read_lore: '读资料卡',
```

- [ ] **Step 5: 设置页分组**

`apps/web/src/pages/SettingsPage.tsx` 的「判断层 / 生图 / 搜索」分组 keys 末尾加 `'SEARXNG_BASE_URLS'`：

```ts
    keys: [
      'INKLOOM_JUDGE',
      'SILICONFLOW_API_KEY',
      'INKLOOM_JUDGE_MODEL',
      'SILICONFLOW_IMAGE_MODEL',
      'TYPESAFE_API_KEY',
      'TAVILY_API_KEY',
      'SEARXNG_BASE_URLS',
    ],
```

`LABEL` 加：

```ts
  SEARXNG_BASE_URLS: 'SearXNG 实例（逗号分隔，可选）',
```

- [ ] **Step 6: 类型检查**

Run: `pnpm tsc`
Expected: 无输出

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/api/types.ts apps/web/src/api/hooks.ts apps/web/src/components/Toolbar.tsx apps/web/src/pages/AgentPage.tsx apps/web/src/pages/SettingsPage.tsx
git commit -m "feat(web): show search provider, degraded state and lore hooks"
```

---

## Task 8: 真实链路验收与文档

**Files:**
- Modify: `README.md`（环境变量表、共创章节）
- Create: `docs/screenshots/` 不新增图片（本轮不做截图）
- 无代码改动（只验证）

**Interfaces:**
- Consumes: Task 1–7 全部
- Produces: 一份验收记录（写在 README 的「验证」小节）

- [ ] **Step 1: 全量验证**

Run: `pnpm verify`
Expected: biome / tsc / check-deps / 单测 / 集成全绿。

- [ ] **Step 2: 起服务并打开真实书**

```bash
$env:INKLOOM_LIBRARY="C:\Users\xiesi\AppData\Local\Temp\inkloom-library"
pnpm api
```

另开一个终端：

```bash
pnpm web
```

在浏览器打开七霞，确认顶栏书名为「七霞」。

- [ ] **Step 3: 验证搜索（零 key 也要有结果或明确降级）**

```bash
curl.exe -s -X POST http://localhost:8787/api/search -H "content-type: application/json" -d '{"query":"剑冢 玄幻 设定","maxResults":3}'
```

Expected：HTTP 200；`provider` 为 `duckduckgo` 或 `tavily`；若为 `duckduckgo` 则 `degraded=true`；`hits` 里每项有 `snippet` 与 `provider`。

- [ ] **Step 4: 验证资料卡**

```bash
curl.exe -s "http://localhost:8787/api/lore?limit=5"
```

Expected：`items` 数组；刚搜到的条目在列表里，`content` 为 null。

- [ ] **Step 5: 验证 read_url**

没有单独的 HTTP 工具端点；在共创页发一句：

> 读一下 https://example.com 的正文，告诉我它讲了什么

Expected：工具卡片出现 `read_url`，返回里有资料卡 id；随后 `GET /api/lore?limit=5` 能看到同 id 的 `content` 不为空。

- [ ] **Step 6: 验证连续两章**

在共创页新建对话，说「连写第 1、2 章」，批准计划后确认第 2 章不再出现「正文额度已用完」。若模型未走到第 2 章，用单测 `plan-tools.test.ts` 的三次 `generate_chapter` 用例作为等价证据。

- [ ] **Step 7: 更新 README**

在「共创 Agent（计划驱动）」小节加：

```markdown
- **可联网**：Agent 有 `web_search` / `read_url` / `read_lore`；结果落资料卡，默认未批准，作者批准后才进 prompt。
- **不设章节/图片额度**：一个会话可以连续写多章；只有步数保护，用完显示「已暂停」，点「继续执行」接着跑。
```

在环境变量表加：

```markdown
| `SEARXNG_BASE_URLS` | 可选：SearXNG 实例，逗号分隔（无 key 时仍可用 DuckDuckGo 兜底） |
```

- [ ] **Step 8: 提交**

```bash
git add README.md
git commit -m "docs: creator slice 1 verification and search env"
```

---

## 自审

**Spec 覆盖（§4）**

| Spec 要求 | 任务 |
|---|---|
| 删 `maxChapters` / `maxPortraits` | Task 1 |
| `maxSteps = 80 + 2n`、耗尽 `paused`、可继续 | Task 1 |
| `SearchHit` / `Provider` / `Result` 类型 | Task 2 |
| Tavily / SearXNG / DuckDuckGo | Task 2 |
| 降级链 + 8s 超时 + 熔断 10 分钟 | Task 3 |
| `web_search` / `read_url` 工具 | Task 5 |
| SSRF 校验 + 编码 + Readability | Task 4 |
| 资料卡落 `LoreReference`，默认未批准 | Task 5 |
| `read_lore`：本 run 可读，跨 run 需批准 | Task 5 |
| `GET /api/lore`、approve、reject | Task 6 |
| 设置页 `SEARXNG_BASE_URLS` | Task 6 / Task 7 |
| `/search` 不再强制 key | Task 6 |
| 前端显示 provider / degraded | Task 7 |
| 真实链路验收 | Task 8 |

**类型一致性**

- `SearchHit.provider` 在三处（api types、web types、`lore-service`）都是 string 联合；DB 存 string。
- `RunBudget` 在 api 与 web 都只剩 4 个字段。
- `AgentRunStatus` 在 api 与 web 都含 `paused`。
- `getRunId` 只在 `AgentToolDeps` 出现一次；测试 fixture 也带它。

**已知边界**

- `read_lore` 对搜索结果只能返回 `snippet`（`content` 为 null），这是设计：搜索结果不抓正文，要正文请 `read_url`。
- DDG 是 HTML 抓取，结构变化时返回空数组而不是抛错；上层会显示「没有结果」。
- 不在本轮做：Critic、多智能体、图谱 2.0（切片 2/3）。
