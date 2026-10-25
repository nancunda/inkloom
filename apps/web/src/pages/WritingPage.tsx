import { lazy, Suspense, useEffect, useState } from 'react'
import {
  useAcceptScene,
  useBook,
  useChapter,
  useDiff,
  useRejectScene,
  useRewriteScene,
  useScene,
} from '../api/hooks'
import type { SceneRow } from '../api/types'
import { ChapterList } from '../components/ChapterList'
import { DiffView } from '../components/DiffView'
import { FocusMode } from '../components/FocusMode'
import { SceneCard } from '../components/SceneCard'
import { Toolbar } from '../components/Toolbar'
import { STATUS_LABEL } from '../lib/status'
import { useSessionStore } from '../stores/session'

/**
 * ★ 地图按需加载：React Flow 单独就有 ~260 kB，
 *   不切分的话每次打开写作页都要白等它下载完。
 */
const StoryMap = lazy(() => import('../components/StoryMap').then((m) => ({ default: m.StoryMap })))
const RelationGraph = lazy(() =>
  import('../components/RelationGraph').then((m) => ({ default: m.RelationGraph })),
)
const ThreadTimeline = lazy(() =>
  import('../components/ThreadTimeline').then((m) => ({ default: m.ThreadTimeline })),
)
const WorldMap = lazy(() => import('../components/WorldMap').then((m) => ({ default: m.WorldMap })))

/** 把同一场景的多个版本按 sceneNo 分组，最新版在前 */
function groupByScene(rows: SceneRow[]): Map<number, SceneRow[]> {
  const m = new Map<number, SceneRow[]>()
  for (const r of rows) {
    const list = m.get(r.sceneNo) ?? []
    list.push(r)
    m.set(r.sceneNo, list)
  }
  for (const list of m.values()) list.sort((a, b) => b.version - a.version)
  return m
}

/**
 * 找比 version 更早、且**真实存在**的最高版本号。
 *
 * ★ 不能用 version - 1：版本号会跳号（v1 被清理后只剩 v2/v3），
 *   减一算出来的版本文件根本不存在，diff 会 404。
 */
function prevExistingVersion(versions: SceneRow[], version: number): number | null {
  const older = versions.filter((v) => v.version < version)
  if (older.length === 0) return null
  return Math.max(...older.map((v) => v.version))
}

export function WritingPage() {
  const view = useSessionStore((s) => s.view)
  // ★ 两分支拆成独立组件：在这里写 if/return 会让下面的 hook 变成条件调用
  return view === 'map' ? <MapView /> : <WriteView />
}

function MapView() {
  const setChapter = useSessionStore((s) => s.setChapter)
  const setView = useSessionStore((s) => s.setView)
  const [sub, setSub] = useState<'chapters' | 'relations' | 'threads' | 'world'>('chapters')

  const tabCls = (active: boolean): string =>
    `rounded px-2.5 py-1 text-xs ${
      active ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
    }`

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-2">
        <button
          type="button"
          onClick={() => setSub('chapters')}
          className={tabCls(sub === 'chapters')}
        >
          章节结构
        </button>
        <button
          type="button"
          onClick={() => setSub('relations')}
          className={tabCls(sub === 'relations')}
        >
          关系网络
        </button>
        <button
          type="button"
          onClick={() => setSub('threads')}
          className={tabCls(sub === 'threads')}
        >
          线索轨迹
        </button>
        <button type="button" onClick={() => setSub('world')} className={tabCls(sub === 'world')}>
          世界地图
        </button>
      </div>
      {/* ★ 给图一个确定高度：React Flow 要在父容器量到宽高（#004），
          flex-1 的百分比高度在 Suspense 层里量不到。 */}
      <div className="min-h-0" style={{ height: 'calc(100vh - 140px)' }}>
        <Suspense fallback={<p className="p-8 text-sm text-neutral-500">加载地图…</p>}>
          {sub === 'chapters' ? (
            <StoryMap
              onPick={(n) => {
                setChapter(n)
                setView('write')
              }}
            />
          ) : sub === 'relations' ? (
            <RelationGraph />
          ) : sub === 'threads' ? (
            <ThreadTimeline />
          ) : (
            <WorldMap />
          )}
        </Suspense>
      </div>
    </div>
  )
}

function WriteView() {
  const chapterNo = useSessionStore((s) => s.chapterNo)
  const selectedScene = useSessionStore((s) => s.selectedScene)
  const selectScene = useSessionStore((s) => s.selectScene)
  const setChapter = useSessionStore((s) => s.setChapter)
  const focus = useSessionStore((s) => s.focus)

  const { data: chapter, isLoading } = useChapter(chapterNo)
  const accept = useAcceptScene()
  const reject = useRejectScene()

  // ★ 当前章不存在时跳到第一章：默认章号是 1，而这本导入的书可能
  //   从别的章号开始（或用户在看一本空书），不校正会停在空页面上。
  const { data: book } = useBook()
  useEffect(() => {
    const list = book?.chapters ?? []
    if (list.length === 0) return
    if (!list.some((c) => c.chapterNo === chapterNo)) {
      const first = list[0]
      if (first !== undefined) setChapter(first.chapterNo)
    }
  }, [book, chapterNo, setChapter])

  const scenes = chapter?.scenes ?? []
  const grouped = groupByScene(scenes)
  const sceneNos = [...grouped.keys()].sort((a, b) => a - b)

  // 每个场景当前「在看哪一版」；默认最新版。切章时自然重置（key 用 chapterNo 包一层）
  const [viewVersion, setViewVersion] = useState<Record<number, number>>({})
  const versionOf = (sceneNo: number, versions: SceneRow[]): SceneRow => {
    const wanted = viewVersion[sceneNo]
    return versions.find((v) => v.version === wanted) ?? versions[0] ?? ({} as SceneRow)
  }

  const [diffPair, setDiffPair] = useState<{ sceneNo: number; from: number; to: number } | null>(
    null,
  )

  const busy = accept.isPending || reject.isPending

  // ★ Ctrl+Shift+E 切专注模式：spec §4.18「写得烦了再切回来」
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        const s = useSessionStore.getState()
        s.setFocus(!s.focus)
      } else if (e.key === 'Escape') {
        useSessionStore.getState().setFocus(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex min-h-0 flex-1">
      <ChapterList />

      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <div className="mb-4 flex items-baseline gap-3">
          <h1 className="text-base font-semibold text-neutral-900">
            {chapter?.title ?? `第 ${chapterNo} 章`}
          </h1>
          <span className="text-xs text-neutral-400">
            {chapter === undefined ? '' : (STATUS_LABEL[chapter.status] ?? chapter.status)}
            {chapter !== undefined && chapter.wordCount > 0 ? ` · ${chapter.wordCount} 字` : ''}
          </span>
        </div>

        {isLoading && <p className="text-sm text-neutral-500">加载中…</p>}

        {!isLoading && sceneNos.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center">
            <p className="text-sm text-neutral-600">本章还没有候选场景</p>
            <p className="mt-1 text-xs text-neutral-400">点右侧「生成本章」开始</p>
          </div>
        )}

        <div className="space-y-3">
          {sceneNos.map((sceneNo) => {
            const versions = grouped.get(sceneNo) ?? []
            const row = versionOf(sceneNo, versions)
            if (row.sceneNo === undefined) return null
            const prev = prevExistingVersion(versions, row.version)
            return (
              <SceneCard
                key={sceneNo}
                versions={versions}
                row={row}
                prevVersion={prev}
                selected={selectedScene === sceneNo}
                busy={busy}
                onViewVersion={(v) => {
                  setViewVersion((m) => ({ ...m, [sceneNo]: v }))
                  setDiffPair(null)
                }}
                onToggleSelect={() => selectScene(selectedScene === sceneNo ? null : sceneNo)}
                onAccept={() =>
                  void accept.mutateAsync({ chapterNo, sceneNo, version: row.version })
                }
                onReject={() =>
                  void reject.mutateAsync({ chapterNo, sceneNo, version: row.version })
                }
                onDiff={() => {
                  if (prev === null) return
                  selectScene(sceneNo)
                  setDiffPair({ sceneNo, from: prev, to: row.version })
                }}
              />
            )
          })}
        </div>

        {diffPair !== null && (
          <DiffPanel
            chapterNo={chapterNo}
            sceneNo={diffPair.sceneNo}
            from={diffPair.from}
            to={diffPair.to}
            onClose={() => setDiffPair(null)}
          />
        )}

        {selectedScene !== null && diffPair === null && (
          <ScenePreview
            chapterNo={chapterNo}
            sceneNo={selectedScene}
            versions={grouped.get(selectedScene) ?? []}
            version={versionOf(selectedScene, grouped.get(selectedScene) ?? []).version ?? 0}
            canRewrite={chapter?.status !== 'finalized'}
            onRewritten={(nv) => setViewVersion((m) => ({ ...m, [selectedScene]: nv }))}
          />
        )}
      </main>

      <Toolbar chapter={chapter} />
      {focus && <FocusMode />}
    </div>
  )
}

/** 场景正文预览；每段可让模型重写（其余段与段 ID 保持不变） */
function ScenePreview({
  chapterNo,
  sceneNo,
  versions,
  version,
  canRewrite,
  onRewritten,
}: {
  chapterNo: number
  sceneNo: number
  versions: SceneRow[]
  version: number
  /** 章节已定稿时为 false：定稿后正文不可再变 */
  canRewrite: boolean
  onRewritten: (newVersion: number) => void
}) {
  const { data, isLoading } = useScene(chapterNo, sceneNo, version)
  const rewrite = useRewriteScene()
  const [openSeg, setOpenSeg] = useState<string | null>(null)
  const [guidance, setGuidance] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const row = versions.find((v) => v.version === version)
  if (row === undefined) return null
  if (isLoading) return <p className="mt-6 text-sm text-neutral-500">读取场景…</p>

  const submit = async (segId: string): Promise<void> => {
    setErr(null)
    try {
      const r = await rewrite.mutateAsync({
        chapterNo,
        sceneNo,
        version,
        segId,
        ...(guidance.trim().length === 0 ? {} : { guidance: guidance.trim() }),
      })
      setOpenSeg(null)
      setGuidance('')
      // 新版本已经产生，把预览切过去，用户能直接看到改写结果
      onRewritten(r.newVersion)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="mt-8 border-t border-neutral-200 pt-6">
      <h2 className="mb-3 text-xs font-medium tracking-wide text-neutral-500">
        场景 {sceneNo} · v{version} 正文（{row.wordCount} 字）
      </h2>
      <div className="space-y-4">
        {(data?.segments ?? []).map((s) => (
          <div key={s.segId} className="group relative">
            <span className="absolute -left-14 top-1 select-none font-mono text-[10px] text-neutral-300 group-hover:text-neutral-500">
              {s.segId}
            </span>
            <div className="flex items-start gap-2">
              <p className="flex-1 whitespace-pre-wrap font-serif text-[15px] leading-8 text-neutral-800">
                {s.text}
              </p>
              <button
                type="button"
                disabled={!canRewrite || rewrite.isPending}
                onClick={() => {
                  setOpenSeg(openSeg === s.segId ? null : s.segId)
                  setErr(null)
                }}
                title={
                  canRewrite
                    ? '让模型改写这一段（其余段与段 ID 不动）'
                    : '本章已定稿，先撤销定稿才能重写'
                }
                className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-300"
              >
                重写这段
              </button>
            </div>
            {openSeg === s.segId && (
              <div className="mt-2 rounded border border-neutral-200 bg-neutral-50 p-2">
                <textarea
                  value={guidance}
                  onChange={(e) => setGuidance(e.target.value)}
                  rows={2}
                  placeholder="可选：告诉模型怎么改（例如：更克制、少用比喻）"
                  className="w-full resize-none rounded border border-neutral-300 px-2 py-1.5 text-xs focus:border-neutral-500 focus:outline-none"
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={rewrite.isPending}
                    onClick={() => void submit(s.segId)}
                    className="rounded bg-neutral-900 px-2.5 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
                  >
                    {rewrite.isPending ? '重写中…' : '确认重写'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpenSeg(null)}
                    className="text-xs text-neutral-500 hover:text-neutral-800"
                  >
                    取消
                  </button>
                  {err !== null && <span className="text-xs text-rose-600">{err}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/** 字符级 diff 面板 */
function DiffPanel({
  chapterNo,
  sceneNo,
  from,
  to,
  onClose,
}: {
  chapterNo: number
  sceneNo: number
  from: number
  to: number
  onClose: () => void
}) {
  const { data, isLoading, error } = useDiff(chapterNo, sceneNo, from, to)

  return (
    <section className="mt-8 border-t border-neutral-200 pt-6">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-xs font-medium tracking-wide text-neutral-500">
          场景 {sceneNo} · v{from} → v{to}
        </h2>
        {data !== undefined && (
          <span className="text-xs text-neutral-400">
            相似度 {(data.similarity * 100).toFixed(1)}% · 新增 {data.addedChars} 字 · 删除{' '}
            {data.removedChars} 字
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-xs text-neutral-500 hover:text-neutral-800"
        >
          关闭
        </button>
      </div>
      {isLoading && <p className="text-sm text-neutral-500">对比中…</p>}
      {error !== null && <p className="text-sm text-rose-700">{error.message}</p>}
      {data !== undefined && <DiffView spans={data.spans} />}
      <p className="mt-4 text-xs text-neutral-400">diff 只用于展示；落库以你接受哪个版本为准。</p>
    </section>
  )
}
