import { useEffect, useRef, useState } from 'react'
import { api, post } from '../api/client'
import type { AgentEvent, AgentGate, AgentRun, AgentRunStatus } from '../api/types'
import { useSessionStore } from '../stores/session'

const RUN_KEY = 'inkloom.agent.runId'

type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; done: boolean }
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      name: string
      args: string
      status: 'running' | 'ok' | 'error'
      summary: string
    }
  | { kind: 'gate'; id: string; gate: AgentGate; resolved: 'approve' | 'revise' | null }
  | { kind: 'status'; id: string; text: string; tone: 'info' | 'error' }

const TOOL_LABEL: Record<string, string> = {
  read_book: '读取全书',
  read_element: '读取要素',
  write_element: '写入要素',
  write_blueprint: '写入蓝图',
  request_review: '请求审阅',
  generate_chapter: '生成章节',
  generate_portrait: '生成形象图',
}

const STAGE_LABEL: Record<AgentGate['stage'], string> = {
  world: '世界',
  cast: '人物',
  arcs: '故事',
  draft: '开篇',
}

const STAGES: { id: AgentGate['stage']; label: string; hint: string }[] = [
  { id: 'world', label: '世界', hint: '规则 · 力量体系 · 地点 · 路线' },
  { id: 'cast', label: '人物', hint: '角色 · 关系 · 签名' },
  { id: 'arcs', label: '故事', hint: '卷 · 章节蓝图' },
  { id: 'draft', label: '开篇', hint: '第 1 章正文 · 主角形象图' },
]

type StageState = 'todo' | 'working' | 'waiting' | 'done' | 'revise'

const STAGE_STATUS: Record<StageState, string> = {
  todo: '未开始',
  working: '进行中',
  waiting: '等你审阅',
  done: '完成',
  revise: '已打回',
}

const STAGE_TONE: Record<StageState, string> = {
  todo: 'text-neutral-400',
  working: 'text-amber-700',
  waiting: 'text-indigo-700',
  done: 'text-emerald-700',
  revise: 'text-rose-700',
}

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: '运行中',
  waiting_review: '等待审阅',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
}

const STATUS_TONE: Record<AgentRunStatus, string> = {
  running: 'bg-amber-50 text-amber-800 border-amber-200',
  waiting_review: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  done: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  failed: 'bg-rose-50 text-rose-800 border-rose-200',
  stopped: 'bg-neutral-100 text-neutral-600 border-neutral-200',
}

const DEFAULT_GOAL =
  '从零搭建这本书：世界观、力量体系、人物、关系、卷、蓝图，然后写第 1 章并生成主角形象图。每个阶段结束都停下来等我审阅。'

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function summarizeArgs(name: string, args: unknown): string {
  if (!isRec(args)) return ''
  const parts: string[] = []
  if (typeof args['path'] === 'string') parts.push(args['path'])
  if (typeof args['stage'] === 'string')
    parts.push(`阶段 ${STAGE_LABEL[args['stage'] as AgentGate['stage']] ?? args['stage']}`)
  if (typeof args['chapterNo'] === 'number') parts.push(`第 ${args['chapterNo']} 章`)
  if (typeof args['characterId'] === 'string') parts.push(args['characterId'])
  if (typeof args['entityId'] === 'string' && typeof args['path'] !== 'string')
    parts.push(`id ${args['entityId']}`)
  if (parts.length === 0) return JSON.stringify(args).slice(0, 140)
  return parts.join(' · ') + (name === 'write_element' ? ' · 整表写入' : '')
}

function reduce(blocks: Block[], ev: AgentEvent): Block[] {
  switch (ev.type) {
    // 目标就是这段对话的第一句用户消息，不再是“跑批任务”
    case 'run.started':
      return [...blocks, { kind: 'user', id: `u${ev.seq}`, text: ev.goal }]
    case 'user.message':
      return [...blocks, { kind: 'user', id: `u${ev.seq}`, text: ev.text }]
    case 'thinking.delta': {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'thinking' && !last.done) {
        return [...blocks.slice(0, -1), { ...last, text: last.text + ev.text }]
      }
      return [...blocks, { kind: 'thinking', id: `t${ev.seq}`, text: ev.text, done: false }]
    }
    case 'text.delta': {
      const last = blocks[blocks.length - 1]
      if (last?.kind === 'text') {
        return [...blocks.slice(0, -1), { ...last, text: last.text + ev.text }]
      }
      const head =
        last?.kind === 'thinking' ? [...blocks.slice(0, -1), { ...last, done: true }] : blocks
      return [...head, { kind: 'text', id: `x${ev.seq}`, text: ev.text }]
    }
    case 'tool.started': {
      const last = blocks[blocks.length - 1]
      const head =
        last?.kind === 'thinking' ? [...blocks.slice(0, -1), { ...last, done: true }] : blocks
      return [
        ...head,
        {
          kind: 'tool',
          id: ev.toolCallId,
          name: ev.toolName,
          args: summarizeArgs(ev.toolName, ev.args),
          status: 'running',
          summary: '',
        },
      ]
    }
    case 'tool.ended': {
      const idx = blocks.findIndex((b) => b.kind === 'tool' && b.id === ev.toolCallId)
      if (idx < 0) {
        return [
          ...blocks,
          {
            kind: 'tool',
            id: ev.toolCallId,
            name: ev.toolName,
            args: '',
            status: ev.isError ? 'error' : 'ok',
            summary: ev.summary,
          },
        ]
      }
      const next = [...blocks]
      const cur = next[idx] as Extract<Block, { kind: 'tool' }>
      next[idx] = { ...cur, status: ev.isError ? 'error' : 'ok', summary: ev.summary }
      return next
    }
    case 'gate.waiting':
      return [...blocks, { kind: 'gate', id: `g${ev.seq}`, gate: ev.gate, resolved: null }]
    case 'gate.resolved': {
      let idx = -1
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        const b = blocks[i]
        if (b?.kind === 'gate' && b.resolved === null) {
          idx = i
          break
        }
      }
      const next = [...blocks]
      const pending = idx >= 0 ? (next[idx] as Extract<Block, { kind: 'gate' }>) : null
      if (pending !== null) next[idx] = { ...pending, resolved: ev.decision }
      const finishedDraft = pending?.gate.stage === 'draft' && ev.decision === 'approve'
      next.push({
        kind: 'status',
        id: `s${ev.seq}`,
        text:
          ev.decision === 'revise'
            ? `作者打回：${ev.feedback ?? ''}`
            : finishedDraft
              ? '作者已通过开篇，本轮完成'
              : '作者已通过，继续下一阶段',
        tone: 'info',
      })
      return next
    }
    case 'run.failed':
      return [...blocks, { kind: 'status', id: `s${ev.seq}`, text: ev.error, tone: 'error' }]
    case 'run.stopped':
      return [...blocks, { kind: 'status', id: `s${ev.seq}`, text: '已停止', tone: 'info' }]
    default:
      return blocks
  }
}

function moduleFor(artifact: string): 'world' | 'cast' | 'story' | 'write' | 'assets' | null {
  if (artifact.startsWith('world/')) return 'world'
  if (artifact.startsWith('characters/')) return 'cast'
  if (artifact.startsWith('story/')) return 'story'
  if (artifact.startsWith('chapters/')) return 'write'
  if (artifact.startsWith('assets/')) return 'assets'
  return null
}

function stageStates(
  blocks: Block[],
  run: AgentRun | null,
): Record<AgentGate['stage'], StageState> {
  const states: Record<AgentGate['stage'], StageState> = {
    world: 'todo',
    cast: 'todo',
    arcs: 'todo',
    draft: 'todo',
  }
  for (const b of blocks) {
    if (b.kind !== 'gate') continue
    if (b.resolved === 'approve') states[b.gate.stage] = 'done'
    else if (b.resolved === 'revise') states[b.gate.stage] = 'revise'
    else states[b.gate.stage] = 'waiting'
  }
  if (run?.status === 'running') {
    const next = STAGES.find((s) => states[s.id] !== 'done')
    if (next !== undefined && states[next.id] === 'todo') states[next.id] = 'working'
  }
  return states
}

function currentHint(run: AgentRun | null, states: Record<AgentGate['stage'], StageState>): string {
  if (run === null) return '还没有开始'
  if (run.status === 'waiting_review' && run.gate !== null) {
    return `等你审阅「${STAGE_LABEL[run.gate.stage]}」：可以点门禁卡通过，或直接发消息让它改`
  }
  if (run.status === 'running') {
    const working = STAGES.find((s) => states[s.id] === 'working')
    return working === undefined ? '正在处理你的消息' : `正在做「${working.label}」`
  }
  if (run.status === 'done') return '本轮完成，可以继续聊下一件事'
  if (run.status === 'failed') return '本轮失败，开个新会话'
  return '已停止，可以继续聊或开新会话'
}

export function AgentPage() {
  const [goal, setGoal] = useState(DEFAULT_GOAL)
  const [run, setRun] = useState<AgentRun | null>(null)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [streamNote, setStreamNote] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [revising, setRevising] = useState(false)
  const lastSeq = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const setModule = useSessionStore((s) => s.setModule)

  const appendEvents = (events: AgentEvent[]): void => {
    const fresh = events.filter((e) => e.seq > lastSeq.current).sort((a, b) => a.seq - b.seq)
    if (fresh.length === 0) return
    lastSeq.current = fresh[fresh.length - 1]?.seq ?? lastSeq.current
    setBlocks((prev) => fresh.reduce(reduce, prev))
  }

  const adoptRun = (next: AgentRun, reset: boolean): void => {
    setRun(next)
    setGoal(next.goal)
    if (reset) {
      lastSeq.current = 0
      setBlocks(next.events.reduce(reduce, []))
      lastSeq.current = next.events.reduce((n, e) => Math.max(n, e.seq), 0)
    } else {
      appendEvents(next.events)
    }
  }

  // 刷新后恢复当前 run（服务重启则会 404，自动清掉）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时恢复一次；把 adoptRun 放进依赖会让每次渲染重跑并覆盖时间线
  useEffect(() => {
    const saved = localStorage.getItem(RUN_KEY)
    if (saved === null) return
    let cancelled = false
    void api<{ run: AgentRun }>(`/agent/runs/${saved}`)
      .then(({ run: restored }) => {
        if (cancelled) return
        adoptRun(restored, true)
      })
      .catch(() => {
        localStorage.removeItem(RUN_KEY)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // SSE：只在运行中/等待审阅时连；EventSource 自带重连，按 seq 去重
  // biome-ignore lint/correctness/useExhaustiveDependencies: appendEvents 用 ref 去重、不依赖状态；按 id/status 重连是有意的
  useEffect(() => {
    if (run === null) return
    if (run.status !== 'running' && run.status !== 'waiting_review') return
    const es = new EventSource(`/api/agent/runs/${run.id}/events`)
    es.onopen = () => setStreamNote(null)
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as AgentEvent
      if (ev.type === 'ping') return
      appendEvents([ev])
      if (ev.type === 'gate.waiting' || ev.type === 'gate.resolved' || ev.type === 'run.finished') {
        void api<{ run: AgentRun }>(`/agent/runs/${run.id}`)
          .then(({ run: next }) => setRun(next))
          .catch(() => undefined)
      }
    }
    es.onerror = () => setStreamNote('连接断开，正在重连（时间线会自动补齐）')
    return () => es.close()
  }, [run?.id, run?.status])

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随 blocks 变化滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [blocks])

  const start = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const { run: started } = await post<{ run: AgentRun }>('/agent/runs', { goal: goal.trim() })
      localStorage.setItem(RUN_KEY, started.id)
      adoptRun(started, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const send = async (): Promise<void> => {
    if (run === null || draft.trim().length === 0) return
    const text = draft.trim()
    setError(null)
    setBusy(true)
    try {
      const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/messages`, {
        text,
      })
      setDraft('')
      adoptRun(next, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const stop = async (): Promise<void> => {
    if (run === null) return
    try {
      const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/stop`)
      adoptRun(next, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const review = async (decision: 'approve' | 'revise'): Promise<void> => {
    if (run === null) return
    if (decision === 'revise' && feedback.trim().length === 0) {
      setError('打回请写清楚要改什么')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/review`, {
        decision,
        ...(decision === 'revise' ? { feedback: feedback.trim() } : {}),
      })
      adoptRun(next, false)
      setFeedback('')
      setRevising(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const newConversation = async (): Promise<void> => {
    if (run !== null && (run.status === 'running' || run.status === 'waiting_review')) {
      if (!window.confirm('结束当前对话并开始新会话？当前进度会停止。')) return
      try {
        await post(`/agent/runs/${run.id}/stop`)
      } catch {
        // run 可能已经结束，忽略
      }
    }
    localStorage.removeItem(RUN_KEY)
    setRun(null)
    setBlocks([])
    lastSeq.current = 0
    setError(null)
    setStreamNote(null)
    setDraft('')
    setGoal(DEFAULT_GOAL)
  }

  const live = run?.status === 'running' || run?.status === 'waiting_review'
  const states = stageStates(blocks, run)
  const hint = currentHint(run, states)
  const canSend = run !== null && run.status !== 'failed'
  const placeholder =
    run === null
      ? ''
      : run.status === 'waiting_review'
        ? '发消息 = 打回本阶段并说明要改什么；想放行请点门禁卡「通过」'
        : run.status === 'running'
          ? 'Agent 正在工作：你的消息会在当前步骤之后送达'
          : run.status === 'failed'
            ? '本轮失败，请开新会话'
            : '继续聊，比如：把第 2 场改得更克制'

  return (
    <div className="flex h-full min-h-0 w-full bg-white">
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/60">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h1 className="text-sm font-semibold text-neutral-900">共创</h1>
          <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">
            像和编辑对话一样推进；每一步的产物都能去对应模块细看。
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          <p className="mb-2 px-1 text-[10px] font-medium tracking-wide text-neutral-400">阶段</p>
          <ol className="space-y-1">
            {STAGES.map((s, i) => {
              const st = states[s.id]
              return (
                <li
                  key={s.id}
                  className={`rounded px-2 py-1.5 ${
                    st === 'waiting' ? 'bg-indigo-50' : st === 'working' ? 'bg-amber-50' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="w-3 text-[10px] text-neutral-400">{i + 1}</span>
                    <span className="font-medium text-neutral-800">{s.label}</span>
                    <span className={`ml-auto text-[10px] ${STAGE_TONE[st]}`}>
                      {STAGE_STATUS[st]}
                    </span>
                  </div>
                  <p className="ml-5 text-[10px] leading-4 text-neutral-400">{s.hint}</p>
                </li>
              )
            })}
          </ol>

          <div className="mt-4 rounded border border-neutral-200 bg-white px-2.5 py-2">
            <p className="text-[10px] font-medium text-neutral-400">现在</p>
            <p className="mt-1 text-[11px] leading-5 text-neutral-700">{hint}</p>
          </div>
        </div>

        <div className="border-t border-neutral-200 px-3 py-2 text-[10px] leading-4 text-neutral-500">
          {run !== null ? (
            <>
              <p>
                预算 {run.budget.steps}/{run.budget.maxSteps} 步 · 章节 {run.budget.chapterCalls}/
                {run.budget.maxChapters} · 图 {run.budget.portraitCalls}/{run.budget.maxPortraits}
              </p>
              <p className="mt-0.5">{run.tokens.toLocaleString()} tokens</p>
            </>
          ) : (
            <p>预算：40 步 · 1 章正文 · 1 张形象图</p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-5 py-2.5">
          <p className="text-[12px] text-neutral-500">
            {run === null ? '新对话' : `对话 ${run.id.replace('ar_', '')}`}
          </p>
          {run !== null && (
            <span className={`rounded border px-2 py-0.5 text-[11px] ${STATUS_TONE[run.status]}`}>
              {STATUS_LABEL[run.status]}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
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
              onClick={() => void newConversation()}
              className="rounded border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-600 hover:bg-neutral-100"
            >
              新会话
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-5 py-5">
            {run === null && (
              <div className="rounded border border-dashed border-neutral-200 p-5">
                <p className="text-[13px] font-medium text-neutral-800">开始一段共创</p>
                <p className="mt-1 text-[11px] leading-5 text-neutral-500">
                  说清楚这本书要什么。Agent 会自己读全书、按 世界 → 人物 → 故事 → 开篇
                  推进，每个阶段末尾停下等你放行。
                </p>
                <textarea
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  rows={3}
                  className="mt-3 w-full resize-none rounded border border-neutral-300 px-3 py-2 text-[13px] leading-6 focus:border-neutral-500 focus:outline-none"
                />
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={busy || goal.trim().length === 0}
                    onClick={() => void start()}
                    className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
                  >
                    开始共创
                  </button>
                  <span className="text-[11px] text-neutral-500">
                    预算：40 步 · 1 章正文 · 1 张形象图
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-4">
              {blocks.map((b) => {
                if (b.kind === 'user') {
                  return (
                    <div key={b.id} className="flex justify-end">
                      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-neutral-900 px-3.5 py-2 text-[13px] leading-6 text-white">
                        {b.text}
                      </p>
                    </div>
                  )
                }
                if (b.kind === 'thinking') {
                  return (
                    <details
                      key={b.id}
                      className="rounded border border-neutral-200 bg-neutral-50 px-3 py-2"
                      open={!b.done}
                    >
                      <summary className="cursor-pointer text-[11px] text-neutral-500">
                        思考 · {b.text.length} 字{b.done ? '' : ' · 流式中'}
                      </summary>
                      <div className="mt-2 whitespace-pre-wrap text-[11px] leading-5 text-neutral-500">
                        {b.text}
                      </div>
                    </details>
                  )
                }
                if (b.kind === 'text') {
                  return (
                    <p
                      key={b.id}
                      className="whitespace-pre-wrap text-[13px] leading-7 text-neutral-800"
                    >
                      {b.text}
                    </p>
                  )
                }
                if (b.kind === 'tool') {
                  const tone =
                    b.status === 'running'
                      ? 'border-amber-200 bg-amber-50'
                      : b.status === 'error'
                        ? 'border-rose-200 bg-rose-50'
                        : 'border-neutral-200 bg-white'
                  return (
                    <div key={b.id} className={`rounded border px-3 py-2 ${tone}`}>
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="font-medium text-neutral-800">
                          {TOOL_LABEL[b.name] ?? b.name}
                        </span>
                        {b.args.length > 0 && (
                          <span className="truncate text-[11px] text-neutral-500">{b.args}</span>
                        )}
                        <span
                          className={`ml-auto text-[10px] ${
                            b.status === 'running'
                              ? 'text-amber-700'
                              : b.status === 'error'
                                ? 'text-rose-700'
                                : 'text-emerald-700'
                          }`}
                        >
                          {b.status === 'running'
                            ? '执行中…'
                            : b.status === 'error'
                              ? '失败'
                              : '完成'}
                        </span>
                      </div>
                      {b.summary.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-neutral-500">
                            查看结果
                          </summary>
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-[11px] leading-5 text-neutral-600">
                            {b.summary}
                          </pre>
                        </details>
                      )}
                    </div>
                  )
                }
                if (b.kind === 'status') {
                  return (
                    <p
                      key={b.id}
                      className={`text-[11px] ${b.tone === 'error' ? 'text-rose-700' : 'text-neutral-500'}`}
                    >
                      {b.text}
                    </p>
                  )
                }
                const g = b.gate
                return (
                  <div key={b.id} className="rounded border border-indigo-200 bg-indigo-50/40 p-4">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-800">
                        等待审阅 · {STAGE_LABEL[g.stage]}
                      </span>
                      {b.resolved !== null && (
                        <span className="text-[10px] text-neutral-500">
                          {b.resolved === 'approve' ? '已通过' : '已打回'}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-neutral-700">
                      {g.summary}
                    </div>
                    {g.artifacts.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {g.artifacts.map((a) => {
                          const mod = moduleFor(a)
                          return (
                            <button
                              key={a}
                              type="button"
                              disabled={mod === null}
                              onClick={() => mod !== null && setModule(mod)}
                              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-50"
                            >
                              {a} ↗
                            </button>
                          )
                        })}
                      </div>
                    )}

                    {b.resolved === null && run?.status === 'waiting_review' && (
                      <div className="mt-3">
                        {revising && (
                          <textarea
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value)}
                            rows={2}
                            placeholder="要改什么？写具体一点，Agent 会按这条意见重做本阶段"
                            className="mb-2 w-full resize-none rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:border-neutral-500 focus:outline-none"
                          />
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void review('approve')}
                            className="rounded bg-neutral-900 px-3 py-1.5 text-[11px] text-white disabled:opacity-40"
                          >
                            {g.stage === 'draft' ? '通过，完成本轮' : '通过，继续'}
                          </button>
                          {revising ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void review('revise')}
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
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>

        <footer className="shrink-0 border-t border-neutral-200 px-5 py-3">
          {error !== null && (
            <p className="mb-2 rounded border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-800">
              {error}
            </p>
          )}
          {streamNote !== null && <p className="mb-2 text-[11px] text-amber-700">{streamNote}</p>}
          {run !== null && (
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey) return
                  if (e.nativeEvent.isComposing) return
                  e.preventDefault()
                  void send()
                }}
                rows={2}
                disabled={!canSend}
                placeholder={placeholder}
                className="min-h-[44px] w-full resize-none rounded border border-neutral-300 px-3 py-2 text-[13px] leading-6 focus:border-neutral-500 focus:outline-none disabled:bg-neutral-50"
              />
              <button
                type="button"
                disabled={busy || !canSend || draft.trim().length === 0}
                onClick={() => void send()}
                className="shrink-0 rounded bg-neutral-900 px-3 py-2 text-[12px] text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
              >
                发送
              </button>
            </div>
          )}
          <p className="mt-2 text-[10px] text-neutral-400">
            Enter 发送 · Shift+Enter 换行；所有写入都经过 CAS、revision 与 git commit。
          </p>
        </footer>
      </div>
    </div>
  )
}
