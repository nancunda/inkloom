import { create } from 'zustand'

/** 八个主模块（spec §2.1 + 共创 Agent） */
export type ModuleId =
  | 'overview'
  | 'agent'
  | 'world'
  | 'cast'
  | 'story'
  | 'write'
  | 'assets'
  | 'settings'

interface SessionState {
  chapterNo: number
  selectedScene: number | null
  /** 当前主模块 */
  module: ModuleId
  /** 纯编辑模式（全屏无干扰） */
  focus: boolean
  /** 命令面板是否打开 */
  palette: boolean
  setChapter: (n: number) => void
  selectScene: (s: number | null) => void
  setModule: (m: ModuleId) => void
  setFocus: (on: boolean) => void
  setPalette: (on: boolean) => void
}

/**
 * 只放「界面当前在看什么」。
 *
 * ★ 服务端数据一律走 TanStack Query，不要塞进 Zustand：
 *   两份真相会导致「操作后界面不更新」这种最难查的 bug。
 */
export const useSessionStore = create<SessionState>((set) => ({
  // 从第 1 章开始；书的第一章不是 1 时，页面会在拿到列表后校正
  chapterNo: 1,
  selectedScene: null,
  // 首屏落在概览：先看「这本书现在怎么样」，再点进写作
  module: 'overview',
  focus: false,
  palette: false,
  setChapter: (n) => set({ chapterNo: n, selectedScene: null, module: 'write' }),
  selectScene: (s) => set({ selectedScene: s }),
  setModule: (m) => set({ module: m }),
  setFocus: (on) => set({ focus: on }),
  setPalette: (on) => set({ palette: on }),
}))
