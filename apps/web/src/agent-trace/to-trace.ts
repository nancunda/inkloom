import type { TraceRecord, TraceSpan } from '@evilmartians/agent-prism-types'
import type { AgentEvent, AgentPlanTask, AgentSessionMeta, AgentSessionStatus } from '../api/types'

/**
 * 把会话索引 + 事件流摊平成一棵 TraceSpan 树。
 *
 * 为什么不是「一个 run 一棵树」：一个会话会跨多次 run（作者接着说一句就续一次），
 * 作者想看到的是一条连续的时间线，所以第二个及以后的 run.started 落成「继续对话」事件。
 */

const ROLE_LABEL: Record<string, string> = {
  researcher: '研究员',
  worldbuilder: '世界建筑师',
  critic: '一致性检查员',
  stylist: '文风顾问',
}

const TOOL_LABEL: Record<string, string> = {
  read_book: '读取全书',
  read_element: '读取要素',
  web_search: '联网搜索',
  read_url: '读网页',
  read_lore: '读资料卡',
  query_graph: '查图谱',
  find_path: '查路径',
  explain_fact: '解释关系',
  write_element: '写入要素',
  write_blueprint: '写入蓝图',
  write_plan: '写计划',
  update_plan: '改计划',
  update_task: '更新任务',
  request_review: '请求审阅',
  generate_chapter: '生成章节',
  generate_portrait: '生成形象图',
  delegate: '派子智能体',
}

const ROOT_STATUS: Record<AgentSessionStatus, TraceSpan['status']> = {
  running: 'pending',
  waiting_review: 'pending',
  paused: 'warning',
  stopped: 'warning',
  failed: 'error',
  done: 'success',
  legacy: 'success',
}

const TASK_STATUS: Record<AgentPlanTask['status'], TraceSpan['status']> = {
  todo: 'pending',
  doing: 'pending',
  done: 'success',
  skipped: 'warning',
  blocked: 'error',
}

function spanOf(
  id: string,
  title: string,
  type: TraceSpan['type'],
  start: string,
  end: string,
  status: TraceSpan['status'] = 'success',
): TraceSpan {
  return {
    id,
    title,
    type,
    status,
    startTime: new Date(start),
    endTime: new Date(end),
    raw: [],
  }
}

export function toTraceData(
  meta: AgentSessionMeta,
  events: AgentEvent[],
): { traceRecord: TraceRecord; spans: TraceSpan[] } {
  const starts = events.filter((e) => e.type === 'run.started')
  const first = starts[0]
  const last = events.at(-1)
  const startedAt = first?.at ?? meta.createdAt
  const endedAt = last?.at ?? meta.updatedAt
  const started = new Date(startedAt).getTime()
  const ended = new Date(endedAt).getTime()

  const traceRecord: TraceRecord = {
    id: meta.id,
    name: meta.title,
    spansCount: events.length,
    durationMs: Math.max(0, ended - started),
    agentDescription: `${meta.status} · ${meta.steps} 步 · ${meta.subagentCalls} 次子智能体`,
    startTime: started,
    totalTokens: meta.tokens,
  }

  const root = spanOf(
    'root',
    `主笔 · ${meta.goal.slice(0, 20)}`,
    'agent_invocation',
    startedAt,
    endedAt,
    ROOT_STATUS[meta.status],
  )
  root.output = meta.title
  root.tokenUsage = { total: { tokens: meta.tokens } }
  const children: TraceSpan[] = []
  root.children = children

  // 同一 toolCallId 的 started/ended 配对；子体按 id 归并
  const openTools = new Map<string, TraceSpan>()
  const openSubagents = new Map<string, TraceSpan>()
  let runCount = 0
  // 流式增量先攒在一个 llm span 上，遇到下一条「新动作」就换新的
  let llm: TraceSpan | null = null

  for (const e of events) {
    const at = e.at
    switch (e.type) {
      case 'run.started': {
        runCount += 1
        if (runCount > 1) {
          const cont = spanOf(`cont:${e.runId}`, '继续对话', 'event', at, at)
          cont.output = e.goal
          cont.raw = [JSON.stringify(e)]
          children.push(cont)
        }
        break
      }
      case 'user.message': {
        const s = spanOf(`u:${e.runId}:${e.seq}`, '作者', 'chain_operation', at, at)
        s.output = e.text
        s.raw = [JSON.stringify(e)]
        children.push(s)
        llm = null
        break
      }
      case 'thinking.delta':
      case 'text.delta': {
        if (llm === null) {
          llm = spanOf(`llm:${e.runId}:${e.seq}`, '模型', 'llm_call', at, at)
          llm.reasoning = { content: '' }
          llm.output = ''
          children.push(llm)
        }
        llm.endTime = new Date(at)
        if (e.type === 'thinking.delta') {
          llm.reasoning = { content: `${llm.reasoning?.content ?? ''}${e.text}` }
        } else {
          llm.output = `${llm.output ?? ''}${e.text}`
        }
        break
      }
      case 'assistant.message': {
        // 一次性到达的完整回复（没有流式增量时才会有这条）
        const s = spanOf(`am:${e.runId}:${e.seq}`, '模型', 'llm_call', at, at)
        s.output = e.text
        if (e.thinking.length > 0) s.reasoning = { content: e.thinking }
        s.raw = [JSON.stringify(e)]
        children.push(s)
        llm = null
        break
      }
      case 'tool.started': {
        const s = spanOf(
          `t:${e.toolCallId}`,
          TOOL_LABEL[e.toolName] ?? e.toolName,
          'tool_execution',
          at,
          at,
          'pending',
        )
        s.input = JSON.stringify(e.args)
        s.raw = [JSON.stringify(e)]
        children.push(s)
        openTools.set(e.toolCallId, s)
        llm = null
        break
      }
      case 'tool.ended': {
        const s = openTools.get(e.toolCallId)
        if (s !== undefined) {
          s.status = e.isError ? 'error' : 'success'
          s.output = e.summary
          s.endTime = new Date(at)
          openTools.delete(e.toolCallId)
        }
        break
      }
      case 'subagent.started': {
        const s = spanOf(
          `sa:${e.id}`,
          ROLE_LABEL[e.role] ?? e.role,
          'agent_invocation',
          at,
          at,
          'pending',
        )
        s.input = e.task
        s.raw = [JSON.stringify(e)]
        s.children = []
        children.push(s)
        openSubagents.set(e.id, s)
        llm = null
        break
      }
      case 'subagent.tool': {
        const parent = openSubagents.get(e.id)
        if (parent !== undefined) {
          const s = spanOf(
            `sat:${e.id}:${e.toolCallId}`,
            TOOL_LABEL[e.toolName] ?? e.toolName,
            'tool_execution',
            at,
            at,
            e.ok ? 'success' : 'error',
          )
          s.output = e.summary
          parent.children?.push(s)
          parent.endTime = new Date(at)
        }
        break
      }
      case 'subagent.ended': {
        const s = openSubagents.get(e.id)
        if (s !== undefined) {
          s.status = !e.ok ? 'error' : e.partial ? 'warning' : 'success'
          // partial 时 text 仍是可用结论，比 summary 更有价值
          s.output = e.text.length > 0 ? e.text : e.summary
          if (e.error !== null && e.error.length > 0)
            s.attributes = [{ key: 'error', value: { stringValue: e.error } }]
          s.endTime = new Date(at)
          s.tokenUsage = { total: { tokens: e.tokens } }
          openSubagents.delete(e.id)
        }
        break
      }
      case 'plan.updated': {
        const s = spanOf(
          `plan:${e.plan.id}:${e.plan.updatedAt}`,
          `计划《${e.plan.title}》`,
          'chain_operation',
          at,
          at,
        )
        s.output = `${e.plan.tasks.filter((t) => t.status === 'done').length}/${e.plan.tasks.length} 完成`
        s.children = e.plan.tasks.map((t) => {
          const task = spanOf(`task:${t.id}`, t.title, 'span', at, at, TASK_STATUS[t.status])
          task.output = t.summary ?? t.brief
          if (t.artifacts.length > 0) task.input = t.artifacts.join('\n')
          return task
        })
        s.raw = [JSON.stringify(e)]
        llm = null
        children.push(s)
        break
      }
      case 'gate.waiting': {
        const s = spanOf(
          `gate:${e.runId}:${e.seq}`,
          e.gate.kind === 'plan' ? '等待批准计划' : '等待审阅任务',
          'event',
          at,
          at,
          'warning',
        )
        s.output = e.gate.title
        s.raw = [JSON.stringify(e)]
        children.push(s)
        break
      }
      case 'gate.resolved': {
        const label =
          e.decision === 'approve' ? '已批准' : e.decision === 'revise' ? '已打回' : '已跳过'
        const s = spanOf(`gate-done:${e.runId}:${e.seq}`, label, 'event', at, at)
        s.output = e.feedback ?? ''
        s.raw = [JSON.stringify(e)]
        children.push(s)
        break
      }
      case 'run.finished':
      case 'run.paused':
      case 'run.failed':
      case 'run.stopped': {
        const label =
          e.type === 'run.finished'
            ? '本轮结束'
            : e.type === 'run.paused'
              ? '本轮暂停'
              : e.type === 'run.failed'
                ? '本轮失败'
                : '本轮被停止'
        const status =
          e.type === 'run.failed' ? 'error' : e.type === 'run.finished' ? 'success' : 'warning'
        const s = spanOf(`end:${e.runId}:${e.seq}`, label, 'event', at, at, status)
        if (e.type === 'run.paused') s.output = e.reason
        if (e.type === 'run.failed') s.output = e.error
        s.raw = [JSON.stringify(e)]
        children.push(s)
        llm = null
        break
      }
      case 'ping': {
        // 心跳不是内容，不建 span（否则时间线会被噪声撑满）
        break
      }
      default: {
        // 服务端先上线了新事件类型、前端还没跟上：留一个能看的 span，别丢信息。
        // 走到这里时 `e` 被降为 never，所以要重新捞回公共字段。
        const unknown = e as unknown as { runId: string; seq: number; type: string }
        const s = spanOf(`ev:${unknown.runId}:${unknown.seq}`, unknown.type, 'span', at, at)
        s.raw = [JSON.stringify(e)]
        children.push(s)
      }
    }
  }

  return { traceRecord, spans: [root] }
}
