import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useBook, useOverview } from '../api/hooks'
import { type Command, CommandPalette } from '../components/CommandPalette'
import { TimeMachine } from '../components/TimeMachine'
import { STATUS_LABEL, STATUS_MARK } from '../lib/status'
import { AssetsPage } from '../pages/AssetsPage'
import { CastPage } from '../pages/CastPage'
import { LibraryDialog } from '../pages/LibraryDialog'
import { OntologyPage } from '../pages/OntologyPage'
import { OverviewPage } from '../pages/OverviewPage'
import { SettingsPage } from '../pages/SettingsPage'
import { StoryPage } from '../pages/StoryPage'
import { WorldPage } from '../pages/WorldPage'
import { WritingPage } from '../pages/WritingPage'
import { type ModuleId, useSessionStore } from '../stores/session'

/**
 * 共创页懒加载：它拖着整套 AgentPrism（radix×2 + resizable-panels + json-pretty），
 * 而主 chunk 已经装着 cytoscape/xyflow/dagre。不切开就是首屏多背一个面板。
 */
const CocreatePage = lazy(async () => {
  const mod = await import('../pages/CocreatePage')
  return { default: mod.CocreatePage }
})

const MODULES: { id: ModuleId; label: string; icon: string }[] = [
  { id: 'overview', label: '概览', icon: '◎' },
  { id: 'agent', label: '共创', icon: '✳' },
  { id: 'world', label: '世界', icon: '◈' },
  { id: 'cast', label: '角色', icon: '◆' },
  { id: 'story', label: '故事', icon: '❖' },
  { id: 'ontology', label: '图谱', icon: '⊞' },
  { id: 'write', label: '写作', icon: '✎' },
  { id: 'assets', label: '素材', icon: '▧' },
  { id: 'settings', label: '设置', icon: '⚙' },
]

/**
 * 应用骨架：顶栏 + 左栏（七个模块）+ 主工作区 + 底栏（spec §2.1 / §4.13）。
 *
 * ★ 写作模块自带第二列（章节列表）与右栏（本章蓝图/角色/未兑现），
 *   其余模块占满主工作区——不为了对齐而把不同密度的界面塞进同一套栅格。
 */
export function AppShell() {
  const { data: book } = useBook()
  // 书还没取到时不要请求 /overview：空库/切书瞬间它只会以 404 刷屏
  const { data: overview } = useOverview(book !== undefined)
  const module = useSessionStore((s) => s.module)
  const setModule = useSessionStore((s) => s.setModule)
  const palette = useSessionStore((s) => s.palette)
  const setPalette = useSessionStore((s) => s.setPalette)
  const setChapter = useSessionStore((s) => s.setChapter)
  const setFocus = useSessionStore((s) => s.setFocus)
  const [tmOpen, setTmOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)

  // Ctrl+K 命令面板 / Ctrl+Shift+E 专注模式（全局）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const s = useSessionStore.getState()
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        s.setPalette(!s.palette)
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        s.setFocus(!s.focus)
      } else if (e.key === 'Escape') {
        s.setFocus(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const commands: Command[] = useMemo(() => {
    const chapters = (book?.chapters ?? []).map((c) => ({
      id: `ch-${c.chapterNo}`,
      label: c.title !== null ? c.title : `第 ${c.chapterNo} 章`,
      hint: `${STATUS_LABEL[c.status] ?? c.status}${c.wordCount > 0 ? ` · ${c.wordCount} 字` : ''}`,
      run: () => setChapter(c.chapterNo),
    }))
    const mods = MODULES.map((m) => ({
      id: `mod-${m.id}`,
      label: `打开「${m.label}」`,
      run: () => setModule(m.id),
    }))
    return [
      ...chapters,
      ...mods,
      {
        id: 'focus',
        label: '进入专注模式（纯编辑）',
        hint: 'Ctrl+Shift+E',
        run: () => setFocus(true),
      },
    ]
  }, [book, setChapter, setModule, setFocus])

  const words = overview?.stats.words ?? 0
  const chapterNo = useSessionStore((s) => s.chapterNo)
  const current = book?.chapters.find((c) => c.chapterNo === chapterNo)

  return (
    <div className="flex h-screen flex-col bg-neutral-50">
      {/* 顶栏 */}
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-neutral-200 bg-white px-5">
        <span className="text-[15px] font-semibold tracking-tight text-neutral-900">inkloom</span>
        <span className="h-4 w-px bg-neutral-200" />
        <button
          type="button"
          onClick={() => setLibraryOpen(true)}
          title="切换书（书库）"
          className="group flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-neutral-100"
        >
          <span className="text-sm font-medium text-neutral-800">{book?.name ?? '—'}</span>
          <span className="text-xs text-neutral-400">{book?.genre ?? ''}</span>
          <span className="text-[10px] text-neutral-400 opacity-0 group-hover:opacity-100">
            切换
          </span>
        </button>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
          v0.0.1
        </span>
        <span className="ml-2 text-xs text-neutral-400">
          {overview?.stats.finalized ?? 0}/{overview?.stats.total ?? 0} 章定稿
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="rounded border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100"
            title="命令面板"
          >
            🔍 Ctrl+K
          </button>
          <span className="rounded border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-500">
            任务 {overview?.runs.total ?? 0}
          </span>
          <button
            type="button"
            onClick={() => setModule('settings')}
            className={`rounded px-2.5 py-1 text-[11px] ${
              module === 'settings'
                ? 'bg-neutral-900 text-white'
                : 'text-neutral-500 hover:bg-neutral-100'
            }`}
          >
            设置
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：七个模块 */}
        <nav className="flex w-[168px] shrink-0 flex-col border-r border-neutral-200 bg-white">
          <div className="flex-1 space-y-0.5 p-2">
            {MODULES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModule(m.id)}
                className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[13px] ${
                  module === m.id
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                <span className="w-4 text-center text-[11px] opacity-70">{m.icon}</span>
                {m.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setTmOpen(true)}
            className="w-full border-t border-neutral-200 px-2.5 py-2 text-left text-[12px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            title="检查点与回退（时间机器）"
          >
            ⏱ 时间机器
            <span className="ml-1 text-[10px] text-neutral-400">检查点 / 回退</span>
          </button>
        </nav>

        {/* 主工作区 */}
        <main className="flex min-w-0 flex-1">
          {module === 'overview' && <OverviewPage />}
          {module === 'agent' && (
            <Suspense
              fallback={<p className="p-6 text-[12px] text-neutral-500">正在载入共创面板…</p>}
            >
              <CocreatePage />
            </Suspense>
          )}
          {module === 'world' && <WorldPage />}
          {module === 'cast' && <CastPage />}
          {module === 'story' && <StoryPage />}
          {module === 'ontology' && <OntologyPage />}
          {module === 'write' && <WritingPage />}
          {module === 'assets' && <AssetsPage />}
          {module === 'settings' && <SettingsPage />}
        </main>
      </div>

      {/* 底栏 */}
      <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-neutral-200 bg-white px-5 text-[11px] text-neutral-500">
        <span>{words.toLocaleString()} 字</span>
        <span className="text-neutral-300">|</span>
        <span>
          {current?.title ?? '—'} · {STATUS_MARK[current?.status ?? 'planned'] ?? '○'}{' '}
          {STATUS_LABEL[current?.status ?? 'planned'] ?? '计划中'}
        </span>
        <span className="text-neutral-300">|</span>
        <span>deepseek-flash</span>
        <span className="ml-auto text-neutral-400">
          自动保存 · 文件即真相（每次接受/定稿自动 commit）
        </span>
      </footer>

      <CommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} />
      {tmOpen && <TimeMachine onClose={() => setTmOpen(false)} />}
      <LibraryDialog open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </div>
  )
}
