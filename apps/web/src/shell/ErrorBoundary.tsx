import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode; label: string }
type State = { error: Error | null }

/**
 * 模块级错误边界：懒加载的异步 chunk 失败、或者某次渲染抛错时，
 * 只毁掉这一块，不要把整棵 React 树卸载成白屏。
 *
 * 不用 hook 写：React 至今没有 function 形式的 error boundary。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台留下完整堆栈：用户看到的是人话，开发者看到的是原始错误
    console.error(`[${this.props.label}] 渲染失败`, error, info.componentStack)
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <div className="p-6">
        <div className="max-w-lg rounded border border-rose-200 bg-rose-50 p-4">
          <p className="text-[13px] font-medium text-rose-900">{this.props.label} 加载失败</p>
          <p className="mt-1 text-[11px] leading-5 text-rose-800">
            {error.message.length > 0 ? error.message : '未知错误'}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded bg-neutral-900 px-3 py-1.5 text-[11px] text-white hover:bg-neutral-800"
            >
              刷新页面
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-[11px] text-neutral-600 hover:bg-neutral-100"
            >
              重试
            </button>
          </div>
        </div>
      </div>
    )
  }
}
