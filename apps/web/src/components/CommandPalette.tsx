import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  /** 右侧灰字提示（快捷键 / 状态 / 章节字数） */
  hint?: string
  run: () => void
}

/**
 * 命令面板（spec §4.18 借鉴 Cursor 的 Ctrl+K）。
 *
 * ★ 只放**导航与视图**命令，不放生成/定稿这类昂贵且不可逆的操作：
 *   命令面板最容易误触，一个回车就把一章重写了不合适。
 * ★ 键盘优先：↑↓ 选择、Enter 执行、Esc 关闭，鼠标只是备选。
 */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean
  commands: Command[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim()
    if (q.length === 0) return commands
    return commands.filter((c) => c.label.includes(q) || (c.hint ?? '').includes(q))
  }, [commands, query])

  // 打开时重置并自动聚焦
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // 等一帧，确保 input 已挂载
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = filtered[active]
        if (cmd !== undefined) {
          cmd.run()
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, filtered, active, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/20 pt-[18vh]">
      {/* 遮罩层用 button：点空白处关闭，同时保持键盘可访问（div + onClick 读屏器不认） */}
      <button
        type="button"
        aria-label="关闭命令面板"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div className="relative w-[520px] overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          placeholder="输入命令或章名…"
          className="w-full border-b border-neutral-200 px-4 py-3 text-sm focus:outline-none"
        />
        <div className="max-h-[46vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-3 text-xs text-neutral-400">没有匹配的命令</p>
          )}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                c.run()
                onClose()
              }}
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                i === active ? 'bg-neutral-100' : ''
              }`}
            >
              <span className="text-neutral-800">{c.label}</span>
              {c.hint !== undefined && (
                <span className="ml-3 shrink-0 text-[11px] text-neutral-400">{c.hint}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t border-neutral-200 px-4 py-1.5 text-[10px] text-neutral-400">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
