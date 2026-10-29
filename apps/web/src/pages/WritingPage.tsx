import { useEffect, useState } from 'react'
import {
  useAcceptScene,
  useBlueprints,
  useBook,
  useChapter,
  useChapterText,
  useDiff,
  useRejectScene,
  useRewriteScene,
  useRewriteSceneFull,
  useScene,
} from '../api/hooks'
import type { SceneRow } from '../api/types'
import { ChapterList } from '../components/ChapterList'
import { ChapterPanel } from '../components/ChapterPanel'
import { DiffView } from '../components/DiffView'
import { FocusMode } from '../components/FocusMode'
import { SceneCard } from '../components/SceneCard'
import { STATUS_LABEL } from '../lib/status'
import { useSessionStore } from '../stores/session'

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
  // 写作模块：内部分两列（章节列表 + 正文/场景），右栏是本章信息。
  // 地图/关系/线索/世界已拆到「故事」「角色」「世界」三个模块里。
  return <WriteView />
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
  const rewriteFull = useRewriteSceneFull(chapterNo)

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

  // ★ spec §4.13 键盘流：J/K 切场景、Enter 接受、Esc 取消选中
  //   输入框里不劫持按键——写作时经常在指导框里打字，
  //   如果 J/K 在这里被拦住，用户会以为键盘流坏了。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const s = useSessionStore.getState()
      const cur = s.selectedScene

      if (e.key === 'j' || e.key === 'k') {
        if (sceneNos.length === 0) return
        e.preventDefault()
        const idx = cur === null ? -1 : sceneNos.indexOf(cur)
        const nextIdx =
          e.key === 'j' ? Math.min(idx + 1, sceneNos.length - 1) : Math.max(idx - 1, 0)
        const next = sceneNos[nextIdx]
        if (next !== undefined) s.selectScene(next)
        return
      }

      if (e.key === 'Escape') {
        s.selectScene(null)
        return
      }

      if (e.key === 'r' && cur !== null && grouped.get(cur)?.[0]?.status !== 'accepted') {
        e.preventDefault()
        void rewriteFull
          .mutateAsync({ sceneNo: cur })
          .then((r) => setViewVersion((m) => ({ ...m, [cur]: r.scene.version })))
        return
      }

      if (e.key === 'Enter' && cur !== null) {
        const versions = grouped.get(cur) ?? []
        const row = versions[0]
        if (row === undefined || row.status !== 'candidate') return
        e.preventDefault()
        void accept.mutateAsync({ chapterNo, sceneNo: cur, version: row.version })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sceneNos, grouped, chapterNo, accept, rewriteFull])

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
          <span className="ml-auto text-[10px] text-neutral-300">
            J/K 切换场景 · Enter 接受 · R 重写整场 · Esc 取消
          </span>
        </div>

        <ChapterBlueprintHead chapterNo={chapterNo} />

        <ChapterTextBlock chapterNo={chapterNo} />

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
                onRewriteFull={
                  chapter?.status === 'finalized'
                    ? undefined
                    : () =>
                        void rewriteFull
                          .mutateAsync({ sceneNo })
                          .then((r) =>
                            setViewVersion((m) => ({ ...m, [sceneNo]: r.scene.version })),
                          )
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

      <ChapterPanel chapter={chapter} />
      {focus && <FocusMode />}
    </div>
  )
}

/** 中栏顶部的蓝图头：目标 / 冲突 / 张力，写之前先知道这章要干什么 */
function ChapterBlueprintHead({ chapterNo }: { chapterNo: number }) {
  const { data } = useBlueprints()
  const b = data?.chapters.find((c) => c.chapterNo === chapterNo)
  if (b === undefined) return null
  return (
    <div className="mb-3 rounded-lg border border-neutral-200 bg-white px-4 py-2.5">
      <div className="flex items-center gap-2 text-[11px] text-neutral-400">
        <span>本章蓝图</span>
        <span className="text-neutral-700" role="img" aria-label={`张力 ${b.tensionLevel} / 5`}>
          {'●'.repeat(b.tensionLevel)}
          {'○'.repeat(Math.max(0, 5 - b.tensionLevel))}
        </span>
        <span>张力 {b.tensionLevel}/5</span>
      </div>
      <p className="mt-1 text-[13px] text-neutral-800">目标：{b.goal}</p>
      <p className="mt-0.5 text-[12px] text-neutral-500">
        冲突：{b.conflict}
        <span className="mx-1.5 text-neutral-300">|</span>
        钩子：{b.hook}
      </p>
    </div>
  )
}

/** 本章正文：已接受场景拼成连续文本（定稿章就是最终稿） */
function ChapterTextBlock({ chapterNo }: { chapterNo: number }) {
  const { data } = useChapterText(chapterNo)
  const [open, setOpen] = useState(true)
  if (data === undefined || data.text.length === 0) return null
  return (
    <section className="mb-4 rounded-lg border border-neutral-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left"
      >
        <span className="text-[12px] font-medium text-neutral-700">本章正文</span>
        <span className="text-[11px] text-neutral-400">
          {data.wordCount} 字 · {data.finalized ? '已定稿（只读）' : '拼自已接受场景'}
        </span>
        <span className="ml-auto text-[11px] text-neutral-400">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="max-h-[420px] overflow-y-auto border-t border-neutral-100 px-5 py-4 text-[14px] leading-7 text-neutral-800">
          {data.text.split(/\n{2,}/).map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 正文段落不重排；用文本做键会撞上重复的短句
            <p key={`p${i}`} className="mb-3 last:mb-0">
              {p}
            </p>
          ))}
        </div>
      )}
    </section>
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
