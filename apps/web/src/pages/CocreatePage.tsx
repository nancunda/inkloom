import type { TraceRecord, TraceSpan } from '@evilmartians/agent-prism-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { planTasksFrom } from '../agent-trace/plan-view'
import { SessionList } from '../agent-trace/SessionList'
import { toTraceData } from '../agent-trace/to-trace'
import { api, post } from '../api/client'
import { useChapterText } from '../api/hooks'
import type {
  AgentEvent,
  AgentGate,
  AgentPlanTask,
  AgentRun,
  AgentSessionMeta,
  AgentSessionStatus,
  AgentSkill,
} from '../api/types'
import { DetailsView } from '../components/agent-prism/DetailsView/DetailsView'
import { TreeView } from '../components/agent-prism/TreeView'
import { useSessionStore } from '../stores/session'

/**
 * 共创页：左「会话列表」/ 中「trace 树」/ 右「详情」/ 底「输入」。
 *
 * ★ 为什么改成 trace 而不是聊天气泡：一次共创里真正发生的是一棵动作树
 *   （主笔 → 工具 / 子智能体 / 计划 / 门禁），气泡只能看见最后一层文本，
 *   中间「派了谁、读了什么、卡在哪」全丢了。会话列表让上一次共创可以接着聊。
 */

const STATUS_LABEL: Record<AgentSessionStatus, string> = {
  running: '运行中',
  waiting_review: '等待审阅',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
  legacy: '历史（只读）',
}

const STATUS_TONE: Record<AgentSessionStatus, string> = {
  running: 'border-amber-200 bg-amber-50 text-amber-800',
  waiting_review: 'border-indigo-200 bg-indigo-50 text-indigo-800',
  paused: 'border-yellow-200 bg-yellow-50 text-yellow-800',
  done: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  failed: 'border-rose-200 bg-rose-50 text-rose-800',
  stopped: 'border-neutral-200 bg-neutral-100 text-neutral-600',
  legacy: 'border-neutral-200 bg-neutral-50 text-neutral-500',
}

const TASK_STATUS_LABEL: Record<AgentPlanTask['status'], string> = {
  todo: '待做',
  doing: '进行中',
  done: '完成',
  skipped: '已跳过',
  blocked: '卡住',
}

const TASK_TONE: Record<AgentPlanTask['status'], string> = {
  todo: 'text-neutral-500',
  doing: 'text-amber-700',
  done: 'text-emerald-700',
  skipped: 'text-neutral-400',
  blocked: 'text-rose-700',
}

const SKILL_LABEL: Record<AgentSkill, string> = {
  world: '世界',
  characters: '人物',
  story: '故事',
  chapter: '正文',
  review: '审阅',
  free: '自由',
}

const DEFAULT_GOAL =
  '从零开始搭这本书：先给我一份计划（世界、人物、故事、第 1 章正文），我批准后你按计划逐个任务执行，需要我拍板的地方停下来。'

const RESUME_TEXT = '继续执行计划里没做完的任务'

function moduleFor(artifact: string): 'world' | 'cast' | 'story' | 'write' | 'assets' | null {
  if (artifact.startsWith('world/')) return 'world'
  if (artifact.startsWith('characters/')) return 'cast'
  if (artifact.startsWith('story/')) return 'story'
  if (artifact.startsWith('chapters/')) return 'write'
  if (artifact.startsWith('assets/')) return 'assets'
  return null
}

function isLive(run: AgentRun | null): boolean {
  return run !== null && (run.status === 'running' || run.status === 'waiting_review')
}

/** 会话行的轻量 TraceRecord：列表不预载 span，用步数近似「动作数」 */
function toTraceRecordLite(meta: AgentSessionMeta): TraceRecord {
  return {
    id: meta.id,
    name: meta.title,
    spansCount: meta.steps,
    durationMs: Math.max(
      0,
      new Date(meta.updatedAt).getTime() - new Date(meta.createdAt).getTime(),
    ),
    agentDescription: `${STATUS_LABEL[meta.status]} · ${meta.steps} 步`,
    startTime: new Date(meta.createdAt).getTime(),
    totalTokens: meta.tokens,
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// 详情面板的两个附加 tab
// ---------------------------------------------------------------------------

function PlanTab({
  tasks,
  onOpenArtifact,
}: {
  tasks: AgentPlanTask[]
  onOpenArtifact: (path: string) => void
}) {
  if (tasks.length === 0) {
    return <p className="text-[11px] leading-5 text-neutral-500">这个会话还没有计划快照。</p>
  }
  const done = tasks.filter((t) => t.status === 'done').length
  return (
    <div>
      <p className="mb-2 text-[11px] text-neutral-500">
        {done}/{tasks.length} 完成
      </p>
      <ol className="space-y-1.5">
        {tasks.map((t, i) => (
          <li key={t.id} className="rounded border border-neutral-200 px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className="w-3 shrink-0 text-[10px] text-neutral-400">{i + 1}</span>
              <span className="truncate text-neutral-800">{t.title}</span>
              <span className={`ml-auto shrink-0 text-[10px] ${TASK_TONE[t.status]}`}>
                {TASK_STATUS_LABEL[t.status]}
              </span>
            </div>
            <p className="mt-1 ml-[18px] text-[10px] text-neutral-500">
              {SKILL_LABEL[t.skill]} · {t.review === 'required' ? '需审阅' : '自动'}
            </p>
            {t.artifacts.length > 0 && (
              <div className="mt-1 ml-[18px] flex flex-wrap gap-1">
                {t.artifacts.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => onOpenArtifact(a)}
                    className="break-all rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-100"
                  >
                    {a} ↗
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function ChapterTab({ chapterNo }: { chapterNo: number }) {
  const { data, error, isLoading } = useChapterText(chapterNo)
  const setModule = useSessionStore((s) => s.setModule)
  const setChapter = useSessionStore((s) => s.setChapter)

  if (isLoading) return <p className="text-[11px] text-neutral-500">读取第 {chapterNo} 章…</p>
  if (error !== null) {
    return <p className="text-[11px] text-rose-700">第 {chapterNo} 章还没有正文。</p>
  }
  const text = data?.text ?? ''
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] text-neutral-500">
          第 {chapterNo} 章 · {text.length} 字
        </span>
        <button
          type="button"
          onClick={() => {
            setChapter(chapterNo)
            setModule('write')
          }}
          className="ml-auto rounded border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-100"
        >
          去写作页 ↗
        </button>
      </div>
      {text.length === 0 ? (
        <p className="text-[11px] text-neutral-500">这一章还是空的。</p>
      ) : (
        <article className="whitespace-pre-wrap text-[13px] leading-7 text-neutral-800">
          {text}
        </article>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 门禁横幅
// ---------------------------------------------------------------------------

function GateBanner({
  gate,
  busy,
  onDecide,
}: {
  gate: AgentGate
  busy: boolean
  onDecide: (decision: 'approve' | 'revise' | 'skip', feedback?: string) => void
}) {
  const [feedback, setFeedback] = useState('')
  const [revising, setRevising] = useState(false)

  return (
    <div className="shrink-0 border-b border-indigo-200 bg-indigo-50/50 px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-800">
          {gate.kind === 'plan' ? `计划待批准 · ${gate.title}` : `任务待审阅 · ${gate.title}`}
        </span>
        <span className="text-[11px] text-neutral-500">需要你拍板，Agent 停在这里等你</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-neutral-700">
        {gate.summary}
      </p>
      {gate.artifacts.length > 0 && (
        <p className="mt-1 break-all text-[10px] text-neutral-500">
          产物：{gate.artifacts.join('、')}
        </p>
      )}
      {revising && (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={2}
          placeholder="要改什么？写具体一点，Agent 会按这条意见重做"
          className="mt-2 w-full resize-none rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:border-neutral-500 focus:outline-none"
        />
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide('approve')}
          className="rounded bg-neutral-900 px-3 py-1.5 text-[11px] text-white disabled:opacity-40"
        >
          {gate.kind === 'plan' ? '批准计划' : '通过任务'}
        </button>
        {revising ? (
          <button
            type="button"
            disabled={busy || feedback.trim().length === 0}
            onClick={() => onDecide('revise', feedback.trim())}
            className="rounded border border-rose-300 px-3 py-1.5 text-[11px] text-rose-700 hover:bg-rose-50 disabled:opacity-40"
          >
            提交打回
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setRevising(true)}
            className="rounded border border-neutral-300 px-3 py-1.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
          >
            打回修改
          </button>
        )}
        {gate.kind === 'task' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecide('skip')}
            className="rounded border border-neutral-300 px-3 py-1.5 text-[11px] text-neutral-500 hover:bg-neutral-100 disabled:opacity-40"
          >
            跳过
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export function CocreatePage() {
  const setModule = useSessionStore((s) => s.setModule)
  const chapterNo = useSessionStore((s) => s.chapterNo)

  const [sessions, setSessions] = useState<AgentSessionMeta[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [meta, setMeta] = useState<AgentSessionMeta | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [run, setRun] = useState<AgentRun | null>(null)
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | undefined>()
  const [expandedSpansIds, setExpandedSpansIds] = useState<string[]>(['root'])
  const [draft, setDraft] = useState('')
  const [goal, setGoal] = useState(DEFAULT_GOAL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamNote, setStreamNote] = useState<string | null>(null)
  /** SSE 与初载可能重复投递同一事件；按 runId+seq 去重 */
  const seen = useRef<Set<string>>(new Set())

  const refreshSessions = useCallback(async (): Promise<AgentSessionMeta[]> => {
    const data = await api<{ sessions: AgentSessionMeta[] }>('/agent/sessions?limit=100')
    setSessions(data.sessions)
    return data.sessions
  }, [])

  /** 载入一个会话（meta + 全部事件），并入内存里仍然活着的 run */
  const loadSession = useCallback(async (id: string): Promise<void> => {
    const detail = await api<{ meta: AgentSessionMeta; events: AgentEvent[] }>(
      `/agent/sessions/${id}?limit=2000`,
    )
    setSelectedId(id)
    setMeta(detail.meta)
    setEvents(detail.events)
    seen.current = new Set(detail.events.map((e) => `${e.runId}:${e.seq}`))
    setSelectedSpan(undefined)
    setExpandedSpansIds(['root'])
    // 会话可能是崩溃残留的 running：只有内存里真有 live run 才算在跑
    if (detail.meta.status === 'running' || detail.meta.status === 'waiting_review') {
      const lastRunId = detail.meta.runIds.at(-1)
      if (lastRunId !== undefined) {
        try {
          const { run: live } = await api<{ run: AgentRun }>(`/agent/runs/${lastRunId}`)
          setRun(live)
        } catch {
          setRun(null)
        }
      }
    } else {
      setRun(null)
    }
  }, [])

  // 挂载：拉会话列表；有正在跑的会话就自动选中它
  useEffect(() => {
    let cancelled = false
    void refreshSessions()
      .then(async (list) => {
        if (cancelled) return
        const active = list.find((s) => s.status === 'running' || s.status === 'waiting_review')
        const first = active ?? list[0]
        if (first !== undefined) await loadSession(first.id)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e))
      })
    return () => {
      cancelled = true
    }
  }, [refreshSessions, loadSession])

  // SSE：只在运行中/等待审阅时连；EventSource 自带重连，按 runId+seq 去重
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 run.id/状态变化时重连；把 run 整个放进依赖会在每次刷新快照时重连
  useEffect(() => {
    if (run === null) return
    if (run.status !== 'running' && run.status !== 'waiting_review') return
    const runId = run.id
    const es = new EventSource(`/api/agent/runs/${runId}/events`)
    let closed = false
    es.onopen = () => setStreamNote(null)
    es.onmessage = (m) => {
      if (closed) return
      const ev = JSON.parse(m.data) as AgentEvent
      if (ev.type === 'ping') return
      const key = `${ev.runId}:${ev.seq}`
      if (seen.current.has(key)) return
      seen.current.add(key)
      setEvents((prev) => [...prev, ev])
      if (
        ev.type === 'run.finished' ||
        ev.type === 'run.paused' ||
        ev.type === 'run.failed' ||
        ev.type === 'run.stopped'
      ) {
        void api<{ run: AgentRun }>(`/agent/runs/${runId}`)
          .then(({ run: next }) => setRun(next))
          .catch(() => undefined)
        void refreshSessions().catch(() => undefined)
      }
    }
    es.onerror = () => {
      if (!closed) setStreamNote('连接断开，正在重连（时间线会自动补齐）')
    }
    return () => {
      closed = true
      es.close()
    }
  }, [run?.id, run?.status, refreshSessions])

  const trace = useMemo(() => (meta === null ? null : toTraceData(meta, events)), [meta, events])
  const planTasks = useMemo(() => planTasksFrom(events), [events])
  const traces = useMemo(() => sessions.map(toTraceRecordLite), [sessions])
  const selectedTrace = useMemo(() => (meta === null ? undefined : toTraceRecordLite(meta)), [meta])

  const extraTabs = useMemo(
    () => [
      {
        key: 'plan',
        title: '计划',
        content: (
          <PlanTab
            onOpenArtifact={(path) => {
              const mod = moduleFor(path)
              if (mod !== null) setModule(mod)
            }}
            tasks={planTasks}
          />
        ),
      },
      { key: 'chapter', title: '正文', content: <ChapterTab chapterNo={chapterNo} /> },
    ],
    [planTasks, chapterNo, setModule],
  )

  const live = isLive(run)
  const resumable = meta?.resumable === true && !meta.id.startsWith('lg_')

  const gate = live ? (run?.gate ?? null) : null

  const adoptRun = useCallback(async (next: AgentRun): Promise<void> => {
    setRun(next)
    // 服务端是真相：拉一遍会话，把本地增量换成完整事件序列（顺序、去重都以它为准）
    await api<{ meta: AgentSessionMeta; events: AgentEvent[] }>(
      `/agent/sessions/${next.sessionId}?limit=2000`,
    )
      .then((detail) => {
        setSelectedId(detail.meta.id)
        setMeta(detail.meta)
        setEvents(detail.events)
        seen.current = new Set(detail.events.map((e) => `${e.runId}:${e.seq}`))
      })
      .catch(() => undefined)
  }, [])

  const startNew = async (text: string): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const { run: started } = await post<{ run: AgentRun; meta: AgentSessionMeta }>(
        '/agent/sessions',
        { goal: text, mode: 'new' },
      )
      setDraft('')
      setGoal(text)
      await adoptRun(started)
      await refreshSessions()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0) return
    // 没有选中会话 = 开一段新的
    if (meta === null) {
      await startNew(text)
      return
    }
    setError(null)
    setBusy(true)
    try {
      if (run !== null && run.status === 'waiting_review') {
        const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/review`, {
          decision: 'revise',
          feedback: text,
        })
        setDraft('')
        await adoptRun(next)
      } else if (live && run !== null) {
        const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/messages`, {
          text,
        })
        setDraft('')
        await adoptRun(next)
      } else if (resumable) {
        const { run: next } = await post<{ run: AgentRun }>(`/agent/sessions/${meta.id}/messages`, {
          text,
        })
        setDraft('')
        await adoptRun(next)
        await refreshSessions()
      } else {
        setError('这个会话不能接着聊：请开一段新会话。')
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (run === null) return
    try {
      const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/stop`)
      await adoptRun(next)
      await refreshSessions()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const resumeRun = async (): Promise<void> => {
    setBusy(true)
    try {
      // 内存里的 run 还是 paused/stopped/failed → 直接叫它接着跑；
      // 已经收尾或服务重启过（run 没了）→ 走会话续接，让服务端按快照接上
      if (run !== null && ended) {
        const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/resume`)
        await adoptRun(next)
      } else if (meta !== null && resumable) {
        const { run: next } = await post<{ run: AgentRun }>(`/agent/sessions/${meta.id}/messages`, {
          text: RESUME_TEXT,
        })
        await adoptRun(next)
      } else {
        setError('这个会话已经收尾，开一段新会话继续。')
        return
      }
      await refreshSessions()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const review = async (
    decision: 'approve' | 'revise' | 'skip',
    feedback?: string,
  ): Promise<void> => {
    if (run === null) return
    if (decision === 'skip' && !window.confirm('跳过这个任务？它会记为已跳过，计划继续往下走。')) {
      return
    }
    setError(null)
    setBusy(true)
    try {
      const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/review`, {
        decision,
        ...(feedback === undefined ? {} : { feedback }),
      })
      await adoptRun(next)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const renameSession = async (id: string, title: string): Promise<void> => {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    try {
      const { meta: next } = await api<{ meta: AgentSessionMeta }>(`/agent/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      })
      setSessions((prev) => prev.map((s) => (s.id === id ? next : s)))
      if (meta?.id === id) setMeta(next)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const deleteSession = async (id: string): Promise<void> => {
    if (!window.confirm('删除这个会话？主笔、工具、子智能体的时间线都会消失（书里的文件不动）。')) {
      return
    }
    try {
      await api<{ ok: true }>(`/agent/sessions/${id}`, { method: 'DELETE' })
      const list = await refreshSessions()
      if (selectedId === id) {
        const next = list[0]
        if (next === undefined) {
          setSelectedId(null)
          setMeta(null)
          setEvents([])
          setRun(null)
        } else {
          await loadSession(next.id)
        }
      }
    } catch (e) {
      setError(errorText(e))
    }
  }

  const newConversation = (): void => {
    if (live && !window.confirm('当前会话还在跑。开新会话不会停止它，继续？')) return
    setSelectedId(null)
    setMeta(null)
    setEvents([])
    setRun(null)
    setSelectedSpan(undefined)
    setExpandedSpansIds(['root'])
    setDraft('')
    setError(null)
    seen.current = new Set()
  }

  const canSend = draft.trim().length > 0 && !busy && (meta === null || live || resumable)
  const sendLabel =
    meta === null
      ? '开始共创'
      : run !== null && run.status === 'waiting_review'
        ? '打回并说明'
        : live
          ? '发送（当前步骤后送达）'
          : '接着说'
  const ended =
    run !== null && (run.status === 'paused' || run.status === 'stopped' || run.status === 'failed')
  const canResume = !live && (resumable || ended)

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 px-5 py-2">
        <input
          value={meta?.title ?? ''}
          onChange={(e) => setMeta(meta === null ? meta : { ...meta, title: e.target.value })}
          onBlur={(e) => {
            if (meta !== null && e.target.value.trim() !== '' && e.target.value !== meta.title) {
              void renameSession(meta.id, e.target.value)
            }
          }}
          placeholder="未命名会话"
          disabled={meta === null}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-neutral-900 placeholder:text-neutral-400 focus:outline-none disabled:text-neutral-400"
        />
        <span
          className={`shrink-0 rounded border px-2 py-0.5 text-[11px] ${
            STATUS_TONE[meta?.status ?? 'done']
          }`}
        >
          {STATUS_LABEL[meta?.status ?? 'done']}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-500">
          步数 {meta?.steps ?? 0}
          {run === null ? '' : `/${run.budget.maxSteps}`} · 子智能体 {meta?.subagentCalls ?? 0} ·{' '}
          {(meta?.tokens ?? 0).toLocaleString()} tokens
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {canResume && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void resumeRun()}
              className="rounded bg-neutral-900 px-2.5 py-1 text-[11px] text-white hover:bg-neutral-800 disabled:opacity-40"
            >
              继续执行
            </button>
          )}
          {live && (
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
            >
              停止
            </button>
          )}
          <button
            type="button"
            onClick={newConversation}
            className="rounded border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
          >
            新会话
          </button>
        </div>
      </header>

      {gate !== null && (
        <GateBanner
          busy={busy}
          gate={gate}
          key={`${gate.kind}:${gate.title}`}
          onDecide={(d, f) => void review(d, f)}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/60">
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {traces.length === 0 ? (
              <p className="px-2 py-3 text-[11px] leading-5 text-neutral-500">
                还没有会话。在下面说清楚这本书要什么，Agent 会先读全书再写计划。
              </p>
            ) : (
              <SessionList
                onDelete={(t) => void deleteSession(t.id)}
                onRename={(t) => {
                  const next = window.prompt('会话标题', t.name)
                  if (next !== null) void renameSession(t.id, next)
                }}
                onSelect={(t) => void loadSession(t.id)}
                {...(selectedTrace === undefined ? {} : { selected: selectedTrace })}
                traces={traces}
              />
            )}
          </div>
          <div className="shrink-0 border-t border-neutral-200 px-3 py-2 text-[10px] leading-4 text-neutral-500">
            会话存在书里（.inkloom/agent/sessions），刷新或重启都还在；点开就能接着聊。
          </div>
        </aside>

        <section className="min-w-0 flex-1 overflow-auto">
          {trace === null ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div>
                <p className="text-[13px] font-medium text-neutral-800">开始一段共创</p>
                <p className="mx-auto mt-1 max-w-md text-[11px] leading-5 text-neutral-500">
                  说清楚这本书要什么。Agent 会先读全书、写一份带任务的计划；你批准后它逐项执行，
                  需要你拍板的地方停下来。每一步都会落到右边这棵树上。
                </p>
              </div>
            </div>
          ) : (
            <TreeView
              expandedSpansIds={expandedSpansIds}
              onExpandSpansIdsChange={(ids) => setExpandedSpansIds([...ids])}
              onSpanSelect={(span) => setSelectedSpan(span as unknown as TraceSpan)}
              selectedSpan={selectedSpan}
              spanCardViewOptions={{ expandButton: 'inside' }}
              spans={trace.spans}
            />
          )}
        </section>

        <aside className="w-[420px] shrink-0 overflow-auto border-l border-neutral-200 bg-white p-2">
          {selectedSpan === undefined || trace === null ? (
            <div className="p-3 text-[11px] leading-5 text-neutral-500">
              点左边任意一个节点看细节：输入输出、思考过程、计划、这一章的正文。
            </div>
          ) : (
            <DetailsView allSpans={trace.spans} data={selectedSpan} extraTabs={extraTabs} />
          )}
        </aside>
      </div>

      <footer className="shrink-0 border-t border-neutral-200 px-5 py-3">
        {error !== null && (
          <p className="mb-2 rounded border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-800">
            {error}
          </p>
        )}
        {streamNote !== null && <p className="mb-2 text-[11px] text-amber-700">{streamNote}</p>}
        <div className="flex items-end gap-2">
          <textarea
            value={meta === null ? goal : draft}
            onChange={(e) => (meta === null ? setGoal(e.target.value) : setDraft(e.target.value))}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return
              if (e.nativeEvent.isComposing) return
              e.preventDefault()
              if (meta === null) {
                if (goal.trim().length > 0) void startNew(goal.trim())
              } else {
                void send()
              }
            }}
            rows={2}
            placeholder={
              meta === null
                ? '说清楚你要这本书做什么，回车开始'
                : run !== null && run.status === 'waiting_review'
                  ? '发消息 = 打回并说明要改什么；想放行请用上面的门禁按钮'
                  : live
                    ? 'Agent 正在工作：你的消息会在当前步骤之后送达'
                    : '接着聊，比如：第 2 章的钩子再狠一点'
            }
            className="min-h-[44px] w-full resize-none rounded border border-neutral-300 px-3 py-2 text-[13px] leading-6 focus:border-neutral-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={meta === null ? busy || goal.trim().length === 0 : busy || !canSend}
            onClick={() => {
              if (meta === null) void startNew(goal.trim())
              else void send()
            }}
            className="shrink-0 rounded bg-neutral-900 px-3 py-2 text-[12px] text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {meta === null ? '开始共创' : sendLabel}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-neutral-400">
          Enter 发送 · Shift+Enter 换行；所有写入都经过 CAS、revision 与 git commit。
        </p>
      </footer>
    </div>
  )
}
