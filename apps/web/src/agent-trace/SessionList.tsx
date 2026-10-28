import type { TraceRecord } from '@evilmartians/agent-prism-types'
import type { ReactElement } from 'react'
import { TraceList } from '../components/agent-prism/TraceList/TraceList'

/**
 * 会话列表：把 AgentPrism 的 TraceList 收窄成「会话」语义。
 *
 * 面板在共创页是常驻展开的，所以不传 onExpandStateChange——上游那个折叠按钮
 * 只在传了回调时才可见，否则它会成为一个点了没反应的死按钮。
 */
export function SessionList(props: {
  traces: TraceRecord[]
  selected?: TraceRecord | undefined
  onSelect: (trace: TraceRecord) => void
  onRename: (trace: TraceRecord) => void
  onDelete: (trace: TraceRecord) => void
}): ReactElement {
  return (
    <TraceList
      expanded
      onDelete={props.onDelete}
      onRename={props.onRename}
      onTraceSelect={props.onSelect}
      {...(props.selected === undefined ? {} : { selectedTrace: props.selected })}
      traces={props.traces}
    />
  )
}
