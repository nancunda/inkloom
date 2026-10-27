import { useEffect, useRef, useState } from 'react'
import { api, post } from '../api/client'
import type {
  AgentEvent,
  AgentGate,
  AgentPlan,
  AgentPlanTask,
  AgentRun,
  AgentRunStatus,
  AgentSkill,
} from '../api/types'
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
      status: 'running' | 'ok' | 'error' | 'stopped'
      summary: string
    }
  | { kind: 'gate'; id: string; gate: AgentGate; resolved: 'approve' | 'revise' | 'skip' | null }
  | { kind: 'plan'; id: string; plan: AgentPlan }
  | { kind: 'status'; id: string; text: string; tone: 'info' | 'error' }

const TOOL_LABEL: Record<string, string> = {
  read_book: '读取全书',
  read_element: '读取要素',
  web_search: '联网搜索',
  read_url: '读网页',
  read_lore: '读资料卡',
  write_element: '写入要素',
  write_blueprint: '写入蓝图',
  write_plan: '写计划',
  update_plan: '改计划',
  update_task: '更新任务',
  request_review: '请求审阅',
  generate_chapter: '生成章节',
  generate_portrait: '生成形象图',
}

const SKILL_LABEL: Record<AgentSkill, string> = {
  world: '世界',
  characters: '人物',
  story: '故事',
  chapter: '正文',
  review: '审阅',
  free: '自由',
}

const PLAN_STATUS_LABEL: Record<AgentPlan['status'], string> = {
  drafting: '规划中',
  awaiting_approval: '待批准',
  approved: '执行中',
  done: '已完成',
  aborted: '已中止',
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
  skipped: 'text-neutral-500',
  blocked: 'text-rose-700',
}

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

const DEFAULT_GOAL =
  '从零开始搭这本书：先给我一份计划（世界、人物、故事、第 1 章正文），我批准后你按计划逐个任务执行，需要我拍板的地方停下来。'

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function summarizeArgs(name: string, args: unknown): string {
  if (!isRec(args)) return ''
  const parts: string[] = []
  if (typeof args['path'] === 'string') parts.push(args['path'])
  if (typeof args['kind'] === 'string') {
    const kind = args['kind'] === 'plan' ? '计划' : '任务'
    const taskId = typeof args['taskId'] === 'string' ? ` · ${args['taskId']}` : ''
    parts.push(`${kind}审阅${taskId}`)
  } else if (typeof args['taskId'] === 'string') {
    parts.push(`任务 ${args['taskId']}`)
  }
  if (typeof args['title'] === 'string' && name === 'write_plan') parts.push(args['title'])
  if (typeof args['status'] === 'string' && name === 'update_task') parts.push(args['status'])
  if (typeof args['chapterNo'] === 'number') parts.push(`第 ${args['chapterNo']} 章`)
  if (typeof args['characterId'] === 'string') parts.push(args['characterId'])
  if (typeof args['entityId'] === 'string' && typeof args['path'] !== 'string') {
    parts.push(`id ${args['entityId']}`)
  }
  if (parts.length === 0) return JSON.stringify(args).slice(0, 140)
  return parts.join(' · ') + (name === 'write_element' ? ' · 整表写入' : '')
}

/**
 * run 结束后，还在「执行中」的工具卡不能永远转圈：
 * 停止/失败时真实结果未知，标成「已停止」，不能和状态栏矛盾。
 */
function settleRunningTools(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'tool' && b.status === 'running'
      ? {
          ...b,
          status: 'stopped' as const,
          summary: b.summary.length > 0 ? b.summary : '本轮已结束，结果未知',
        }
      : b,
  )
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
    case 'plan.updated':
      return [...blocks, { kind: 'plan', id: `p${ev.seq}`, plan: ev.plan }]
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
      const text =
        ev.decision === 'revise'
          ? `已打回：${ev.feedback ?? ''}`
          : ev.decision === 'skip'
            ? '已跳过这个任务，继续下一个'
            : pending?.gate.kind === 'plan'
              ? '计划已批准，开始执行任务'
              : '任务已通过，继续下一个'
      next.push({ kind: 'status', id: `s${ev.seq}`, text, tone: 'info' })
      return next
    }
    case 'run.paused':
      return [
        ...settleRunningTools(blocks),
        { kind: 'status', id: `s${ev.seq}`, text: ev.reason, tone: 'info' },
      ]
    case 'run.failed':
      return [
        ...settleRunningTools(blocks),
        { kind: 'status', id: `s${ev.seq}`, text: ev.error, tone: 'error' },
      ]
    case 'run.stopped':
      return [
        ...settleRunningTools(blocks),
        { kind: 'status', id: `s${ev.seq}`, text: '已停止', tone: 'info' },
      ]
    default:
      return blocks
  }
}

function latestPlan(blocks: Block[]): AgentPlan | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i]
    if (b?.kind === 'plan') return b.plan
  }
  return null
}

function moduleFor(artifact: string): 'world' | 'cast' | 'story' | 'write' | 'assets' | null {
  if (artifact.startsWith('world/')) return 'world'
  if (artifact.startsWith('characters/')) return 'cast'
  if (artifact.startsWith('story/')) return 'story'
  if (artifact.startsWith('chapters/')) return 'write'
  if (artifact.startsWith('assets/')) return 'assets'
  return null
}

function currentHint(run: AgentRun | null, plan: AgentPlan | null): string {
  if (run === null) {
    if (plan === null) return '还没有开始'
    return plan.status === 'aborted'
      ? '上一轮计划已中止：可以「继续执行」或「重新规划」'
      : '书里有一份上次的计划：可以「继续执行」接着做'
  }
  if (run.status === 'waiting_review' && run.gate !== null) {
    return run.gate.kind === 'plan'
      ? `等你批准计划「${run.gate.title}」：通过后我会按任务自动推进`
      : `等你审阅任务「${run.gate.title}」：可以在卡上通过，或直接发消息让它改`
  }
  if (run.status === 'paused') return '已暂停：点「继续执行」接着跑，任务进度不会丢'
  if (run.status === 'running') {
    if (plan === null) return '正在读全书、制定计划'
    const doing = plan.tasks.find((t) => t.status === 'doing')
    return doing === undefined ? '正在处理你的消息' : `正在做「${doing.title}」`
  }
  if (plan !== null && plan.status === 'done') return '计划完成，可以继续聊下一件事'
  if (plan !== null && plan.status === 'aborted') {
    return '计划已中止；可以「继续执行」接着做，或「重新规划」重来'
  }
  if (run.status === 'done') return '本轮完成；如果计划还有任务，可以点「继续执行」'
  if (run.status === 'failed') return '本轮失败；可以「继续执行」或开新会话'
  return '已停止；可以继续聊，或点「继续执行」'
}

function Plancard({ plan, loading }: { plan: AgentPlan | null; loading: boolean }) {
  if (plan === null) {
    return (
      <p className="px-1 text-[11px] leading-5 text-neutral-400">
        {loading
          ? '正在读取书里的计划…'
          : '还没有计划。Agent 会先 read_book，再写一份计划请你批准；批准前不会动书里的文件。'}
      </p>
    )
  }
  const done = plan.tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length
  return (
    <div>
      <div className="rounded border border-neutral-200 bg-white px-2.5 py-2">
        <div className="flex items-baseline gap-1.5">
          <span className="truncate text-[12px] font-medium text-neutral-800">{plan.title}</span>
          <span className="ml-auto shrink-0 text-[10px] text-neutral-500">
            {done}/{plan.tasks.length}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] text-neutral-500">
          {PLAN_STATUS_LABEL[plan.status]}
          {plan.status === 'awaiting_approval' ? ' · 等你批准' : ''}
        </p>
        {plan.feedback !== null && (
          <p className="mt-1 rounded bg-rose-50 px-1.5 py-1 text-[10px] leading-4 text-rose-700">
            打回：{plan.feedback}
          </p>
        )}
      </div>

      <ol className="mt-2 space-y-0.5">
        {plan.tasks.map((t, i) => (
          <li key={t.id}>
            <details className="rounded px-1.5 py-1 hover:bg-neutral-100/70">
              <summary className="cursor-pointer list-none">
                <div className="flex items-center gap-1.5 text-[12px]">
                  <span className="w-3 shrink-0 text-[10px] text-neutral-400">{i + 1}</span>
                  <span
                    title={t.title}
                    className={`truncate ${
                      t.status === 'done' || t.status === 'skipped'
                        ? 'text-neutral-400 line-through'
                        : 'text-neutral-800'
                    }`}
                  >
                    {t.title}
                  </span>
                  <span
                    className={`ml-auto shrink-0 whitespace-nowrap text-[10px] ${TASK_TONE[t.status]}`}
                  >
                    {TASK_STATUS_LABEL[t.status]}
                  </span>
                </div>
                <div className="ml-[18px] text-[10px] text-neutral-400">
                  {SKILL_LABEL[t.skill]} · {t.review === 'required' ? '需审阅' : '自动'}
                </div>
              </summary>
              <div className="ml-[18px] mt-1 space-y-1 pb-1">
                <p className="text-[10px] leading-4 text-neutral-500">{t.brief || '（无细项）'}</p>
                {t.artifacts.length > 0 && (
                  <p className="break-all text-[10px] text-neutral-400">
                    产物：{t.artifacts.join('、')}
                  </p>
                )}
                {t.feedback !== null && (
                  <p className="rounded bg-rose-50 px-1.5 py-1 text-[10px] leading-4 text-rose-700">
                    打回：{t.feedback}
                  </p>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>
    </div>
  )
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
  /** 书里的当前计划（磁盘）：run 被回收后靠它继续显示与恢复 */
  const [diskPlan, setDiskPlan] = useState<AgentPlan | null>(null)
  const [diskPlanLoaded, setDiskPlanLoaded] = useState(false)
  const [runExpired, setRunExpired] = useState(false)
  const lastSeq = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const setModule = useSessionStore((s) => s.setModule)

  const appendEvents = (events: AgentEvent[]): void => {
    const fresh = events.filter((e) => e.seq > lastSeq.current).sort((a, b) => a.seq - b.seq)
    if (fresh.length === 0) return
    lastSeq.current = fresh[fresh.length - 1]?.seq ?? lastSeq.current
    for (const e of fresh) if (e.type === 'plan.updated') setDiskPlan(e.plan)
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
        // 不静默清空：告诉作者「记录过期了，但计划还在书里」
        setRunExpired(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 计划从磁盘读：run 被回收/服务重启后，计划与恢复入口仍然可见
  useEffect(() => {
    let cancelled = false
    void api<{ plan: AgentPlan | null }>('/agent/plan')
      .then(({ plan: saved }) => {
        if (!cancelled) setDiskPlan(saved)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDiskPlanLoaded(true)
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
      if (
        ev.type === 'gate.waiting' ||
        ev.type === 'gate.resolved' ||
        ev.type === 'plan.updated' ||
        ev.type === 'run.finished' ||
        ev.type === 'run.paused' ||
        ev.type === 'run.failed' ||
        ev.type === 'run.stopped'
      ) {
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

  const startWith = async (mode: 'new' | 'resume' | 'replan', text?: string): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      const { run: started } = await post<{ run: AgentRun }>('/agent/runs', {
        goal: text ?? goal.trim(),
        mode,
      })
      localStorage.setItem(RUN_KEY, started.id)
      setRunExpired(false)
      // 新计划/重新规划会作废旧计划，左栏不能再显示它
      if (mode !== 'resume') setDiskPlan(null)
      adoptRun(started, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    if (
      diskPlan !== null &&
      !window.confirm('开始新计划会把书里现有的计划标记为中止并重新规划，继续？')
    )
      return
    await startWith('new')
  }

  const sendText = async (text: string): Promise<void> => {
    if (run === null || text.trim().length === 0) return
    setError(null)
    setBusy(true)
    try {
      const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/messages`, {
        text: text.trim(),
      })
      setDraft('')
      adoptRun(next, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const send = async (): Promise<void> => {
    await sendText(draft)
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

  const resume = async (): Promise<void> => {
    // 没有内存 run（刷新/被回收）时：让服务端按 resume 模式接上磁盘里的计划
    if (run === null) {
      await startWith('resume', '继续执行计划里没做完的任务')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const { run: next } = await post<{ run: AgentRun }>(`/agent/runs/${run.id}/resume`)
      adoptRun(next, false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const replan = async (): Promise<void> => {
    await startWith('replan')
  }

  const review = async (decision: 'approve' | 'revise' | 'skip'): Promise<void> => {
    if (run === null) return
    if (decision === 'skip' && !window.confirm('跳过这个任务？它会记为已跳过，计划继续往下走。'))
      return
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
    setRunExpired(false)
    setGoal(DEFAULT_GOAL)
  }

  const live = run?.status === 'running' || run?.status === 'waiting_review'
  const plan = latestPlan(blocks) ?? diskPlan
  const hint = currentHint(run, plan)
  const canSend = run !== null && run.status !== 'failed' && run.status !== 'paused'
  const ended =
    run !== null &&
    (run.status === 'done' ||
      run.status === 'stopped' ||
      run.status === 'failed' ||
      run.status === 'paused')
  const openTaskCount =
    plan?.tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped').length ?? 0
  // 没有内存 run 也算可恢复：run 被回收后计划还在磁盘上
  // ★ paused 一律给出口：任务全做完时步数/跑圈保护也会暂停，此时 openTaskCount 为 0。
  const canResume = (run === null || ended) && (openTaskCount > 0 || run?.status === 'paused')
  const canReplan = (run === null || ended) && plan?.status === 'aborted'
  const placeholder =
    run === null
      ? ''
      : run.status === 'waiting_review'
        ? '发消息 = 打回并说明要改什么；想放行请点门禁卡上的按钮'
        : run.status === 'running'
          ? 'Agent 正在工作：你的消息会在当前步骤之后送达'
          : run.status === 'failed'
            ? '本轮失败：点「继续执行」或开新会话'
            : '继续聊，比如：第 2 章的钩子再狠一点'

  return (
    <div className="flex h-full min-h-0 w-full bg-white">
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50/60">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h1 className="text-sm font-semibold text-neutral-900">共创</h1>
          <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">
            像和编辑对话一样推进；Agent 先给计划，你批准后它按任务做。
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          <p className="mb-2 px-1 text-[10px] font-medium tracking-wide text-neutral-500">计划</p>
          <Plancard plan={plan} loading={!diskPlanLoaded} />

          <div className="mt-4 rounded border border-neutral-200 bg-white px-2.5 py-2">
            <p className="text-[10px] font-medium text-neutral-500">现在</p>
            <p className="mt-1 text-[11px] leading-5 text-neutral-700">{hint}</p>
          </div>
        </div>

        {/* 恢复入口常驻在左栏底部：任务多时滚动区把按钮顶到折叠线下，作者找不到 */}
        {(canResume || canReplan) && (
          <div className="shrink-0 space-y-1 border-t border-neutral-200 bg-neutral-50 px-3 py-2">
            {canResume && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void resume()}
                className="w-full rounded bg-neutral-900 px-2 py-1.5 text-[11px] text-white hover:bg-neutral-800 disabled:opacity-40"
              >
                继续执行没做完的任务
              </button>
            )}
            {canReplan && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void replan()}
                className="w-full rounded border border-neutral-200 bg-white px-2 py-1.5 text-[11px] text-neutral-500 hover:bg-neutral-50 disabled:opacity-40"
              >
                重新规划（放弃这份计划）
              </button>
            )}
          </div>
        )}

        <div className="border-t border-neutral-200 px-3 py-2 text-[10px] leading-4 text-neutral-500">
          {run !== null ? (
            <>
              <p>
                步数 {run.budget.steps}/{run.budget.maxSteps} · 章节 {run.budget.chapterCalls} · 图{' '}
                {run.budget.portraitCalls}
              </p>
              <p className="mt-0.5">{run.tokens.toLocaleString()} tokens</p>
            </>
          ) : (
            <p>步数按任务数放宽（≥80 步） · 章节与形象图不设上限</p>
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
          <div className="mx-auto w-full max-w-3xl px-5 pt-5 pb-16">
            {run === null && runExpired && (
              <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                上一轮对话记录已过期（服务重启或已回收）。计划仍在书里：可以用左栏的「继续执行」或「重新规划」。
              </div>
            )}
            {run === null && (
              <div className="rounded border border-dashed border-neutral-200 p-5">
                <p className="text-[13px] font-medium text-neutral-800">开始一段共创</p>
                <p className="mt-1 text-[11px] leading-5 text-neutral-500">
                  {diskPlan !== null
                    ? '书里已有一份计划（见左栏）。「开始共创」会作废它并重新规划。'
                    : '说清楚这本书要什么。Agent 会先读全书、写一份带任务的计划；你批准后它逐项执行，需要你拍板的地方停下来。计划与任务在左边实时更新。'}
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
                    步数按任务数放宽（≥80 步） · 章节与形象图不设上限
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
                            : b.status === 'stopped'
                              ? '已停止'
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
                // 计划快照不进对话流：左侧栏是它的主视图，避免同一份内容出现两次
                if (b.kind === 'plan') return null

                const g = b.gate
                return (
                  <div key={b.id} className="rounded border border-indigo-200 bg-indigo-50/40 p-4">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-800">
                        {g.kind === 'plan' ? `计划待批准 · ${g.title}` : `任务待审阅 · ${g.title}`}
                      </span>
                      {b.resolved !== null && (
                        <span className="text-[10px] text-neutral-500">
                          {b.resolved === 'approve'
                            ? '已通过'
                            : b.resolved === 'skip'
                              ? '已跳过'
                              : '已打回'}
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
                            placeholder="要改什么？写具体一点，Agent 会按这条意见重做"
                            className="mb-2 w-full resize-none rounded border border-neutral-300 px-2 py-1.5 text-[12px] focus:border-neutral-500 focus:outline-none"
                          />
                        )}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void review('approve')}
                            className="rounded bg-neutral-900 px-3 py-1.5 text-[11px] text-white disabled:opacity-40"
                          >
                            {g.kind === 'plan' ? '批准计划' : '通过任务'}
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
                          {g.kind === 'task' && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void review('skip')}
                              className="rounded border border-neutral-300 px-3 py-1.5 text-[11px] text-neutral-500 hover:bg-neutral-100 disabled:opacity-40"
                            >
                              跳过
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
