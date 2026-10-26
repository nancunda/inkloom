import { create } from 'zustand'

/** 八个主模块（spec §2.1 + 共创 Agent） */
export const MODULES = [
  'overview',
  'agent',
  'world',
  'cast',
  'story',
  'write',
  'assets',
  'settings',
] as const
export type ModuleId = (typeof MODULES)[number]

const MODULE_KEY = 'inkloom.module'

/** 刷新后保持上次所在模块：停在共创时按 F5 不该被踢回概览 */
function initialModule(): ModuleId {
  const saved = window.localStorage.getItem(MODULE_KEY)
  return saved !== null && (MODULES as readonly string[]).includes(saved)
    ? (saved as ModuleId)
    : 'overview'
}

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
  module: initialModule(),
  focus: false,
  palette: false,
  setChapter: (n) => set({ chapterNo: n, selectedScene: null, module: 'write' }),
  selectScene: (s) => set({ selectedScene: s }),
  setModule: (m) => {
    window.localStorage.setItem(MODULE_KEY, m)
    set({ module: m })
  },
  setFocus: (on) => set({ focus: on }),
  setPalette: (on) => set({ palette: on }),
}))
