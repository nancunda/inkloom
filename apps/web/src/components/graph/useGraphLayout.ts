import { useCallback, useMemo } from 'react'

type Positions = Record<string, { x: number; y: number }>

function keyOf(bookId: string, signature: string): string {
  return `inkloom:graph-layout:${bookId}:${signature}`
}

function parse(raw: string | null): Positions | undefined {
  if (raw === null) return undefined
  try {
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
    const out: Positions = {}
    for (const [id, pos] of Object.entries(v as Record<string, unknown>)) {
      if (typeof pos !== 'object' || pos === null) continue
      const p = pos as { x?: unknown; y?: unknown }
      if (typeof p.x === 'number' && typeof p.y === 'number') out[id] = { x: p.x, y: p.y }
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * 拖拽位置存 localStorage，key 带 content signature：
 * 书改了（signature 变）就丢弃旧坐标，避免节点全挤在旧位置。
 */
export function useGraphLayout(bookId: string, signature: string) {
  const preset = useMemo(() => {
    if (typeof window === 'undefined') return undefined
    try {
      return parse(window.localStorage.getItem(keyOf(bookId, signature)))
    } catch {
      return undefined
    }
  }, [bookId, signature])

  const save = useCallback(
    (positions: Positions) => {
      const key = keyOf(bookId, signature)
      try {
        // ★ 画布只上报可见节点；合并旧值，否则筛选状态下拖一下就会抹掉其余节点的坐标
        const prev = parse(window.localStorage.getItem(key)) ?? {}
        window.localStorage.setItem(key, JSON.stringify({ ...prev, ...positions }))
      } catch {
        // 隐私模式/配额满：布局只是便利，失败不打扰作者
      }
    },
    [bookId, signature],
  )

  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(keyOf(bookId, signature))
    } catch {
      // 同上
    }
  }, [bookId, signature])

  return { preset, save, clear }
}
