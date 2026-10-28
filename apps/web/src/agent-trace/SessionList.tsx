import type { TraceRecord } from '@evilmartians/agent-prism-types'
import type { ReactElement } from 'react'
import { TraceList } from '../components/agent-prism/TraceList/TraceList'

/**
 * 会话列表：把 AgentPrism 的 TraceList 收窄成「会话」语义。
 *
 * 面板在共创页是常驻展开的（不折叠），所以 onExpandStateChange 是个空操作——
 * 折叠按钮留在上游组件里，但这里不需要它改变状态。
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
      onExpandStateChange={() => undefined}
      onRename={props.onRename}
      onTraceSelect={props.onSelect}
      {...(props.selected === undefined ? {} : { selectedTrace: props.selected })}
      traces={props.traces}
    />
  )
}
