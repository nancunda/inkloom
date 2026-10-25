import { create } from 'zustand'

interface SessionState {
  chapterNo: number
  selectedScene: number | null
  /** 主区在写作页还是叙事地图 */
  view: 'write' | 'map'
  /** 纯编辑模式（全屏无干扰） */
  focus: boolean
  setChapter: (n: number) => void
  selectScene: (s: number | null) => void
  setView: (v: 'write' | 'map') => void
  setFocus: (on: boolean) => void
}

/**
 * 只放「界面当前在看什么」。
 *
 * ★ 服务端数据一律走 TanStack Query，不要塞进 Zustand：
 *   两份真相会导致「操作后界面不更新」这种最难查的 bug。
 */
export const useSessionStore = create<SessionState>((set) => ({
  // 从第 1 章开始；书的第一章不是 1 时，WritingPage 会在拿到列表后校正
  chapterNo: 1,
  selectedScene: null,
  view: 'write',
  focus: false,
  setChapter: (n) => set({ chapterNo: n, selectedScene: null }),
  selectScene: (s) => set({ selectedScene: s }),
  setView: (v) => set({ view: v }),
  setFocus: (on) => set({ focus: on }),
}))
