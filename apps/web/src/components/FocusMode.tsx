import { useState } from 'react'
import { useChapter, useEditScene, useScene } from '../api/hooks'
import type { SceneRow } from '../api/types'
import { useSessionStore } from '../stores/session'

/**
 * 纯编辑模式（spec §4.18：无侧栏、无 AI、无提示的全屏写作）。
 *
 * ★ 只针对「当前选中的场景」：正文的真相是场景文件，全屏编辑器直接改
 *   定稿会绕过审稿流程。这里改的仍是段，保存走 editSceneSeg，
 *   和写作页里的人工编辑是同一条路径。
 * ★ 没有选中场景时如实说明，而不是显示一个空白的全屏让人以为卡住了。
 */
export function FocusMode() {
  const chapterNo = useSessionStore((s) => s.chapterNo)
  const selectedScene = useSessionStore((s) => s.selectedScene)
  const setFocus = useSessionStore((s) => s.setFocus)
  const { data: chapter } = useChapter(chapterNo)

  const versions = (chapter?.scenes ?? [])
    .filter((s) => s.sceneNo === selectedScene)
    .sort((a, b) => b.version - a.version)
  const row: SceneRow | undefined = versions[0]
  const { data: scene } = useScene(chapterNo, selectedScene ?? 0, row?.version ?? 0)
  const edit = useEditScene()

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const save = async (segId: string): Promise<void> => {
    if (row === undefined) return
    setErr(null)
    try {
      await edit.mutateAsync({
        chapterNo,
        sceneNo: row.sceneNo,
        version: row.version,
        segId,
        newText: draft,
      })
      setEditing(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#faf8f5]">
      <div className="mx-auto max-w-2xl px-6 py-14">
        <div className="mb-10 flex items-baseline justify-between text-xs text-neutral-400">
          <span>
            {chapter?.title ?? `第 ${chapterNo} 章`}
            {row !== undefined ? ` · 场景 ${row.sceneNo} v${row.version}` : ''}
          </span>
          <button
            type="button"
            onClick={() => setFocus(false)}
            className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-100"
          >
            退出 Esc
          </button>
        </div>

        {selectedScene === null ? (
          <p className="text-center text-sm text-neutral-500">
            先在写作页里点一个场景，再进入专注模式
          </p>
        ) : row === undefined ? (
          <p className="text-center text-sm text-neutral-500">这个场景还没有候选稿</p>
        ) : (
          <div className="space-y-5 font-serif text-[17px] leading-9 text-neutral-800">
            {(scene?.segments ?? []).map((seg) =>
              editing === seg.segId ? (
                <div key={seg.segId} className="rounded border border-neutral-300 bg-white p-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={Math.max(3, Math.ceil(draft.length / 40))}
                    className="w-full resize-none rounded border border-neutral-200 px-2 py-1.5 font-serif text-[16px] leading-8 focus:border-neutral-400 focus:outline-none"
                  />
                  <div className="mt-1.5 flex items-center gap-2 font-sans text-xs">
                    <button
                      type="button"
                      disabled={edit.isPending || draft.trim().length === 0}
                      onClick={() => void save(seg.segId)}
                      className="rounded bg-neutral-900 px-2.5 py-1 text-white disabled:bg-neutral-300"
                    >
                      {edit.isPending ? '保存中…' : '保存为新版本'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="text-neutral-500"
                    >
                      取消
                    </button>
                    {err !== null && <span className="text-rose-600">{err}</span>}
                  </div>
                </div>
              ) : (
                // ★ 用 button 而不是 p + onClick：键盘也能聚焦与触发，
                //   biome 的 a11y 规则不是形式主义——纯 div 点击读屏器根本不认
                <button
                  key={seg.segId}
                  type="button"
                  onClick={() => {
                    setEditing(seg.segId)
                    setDraft(seg.text)
                    setErr(null)
                  }}
                  className="-mx-1 block w-full cursor-text whitespace-pre-wrap rounded px-1 text-left hover:bg-neutral-100/70"
                  title="点一下改这一段（保存为新版本，旧版自动拒绝）"
                >
                  {seg.text}
                </button>
              ),
            )}
          </div>
        )}

        <p className="mt-14 text-center font-sans text-[11px] text-neutral-300">
          点任意一段可改写，保存后生成新版本 · Ctrl+Shift+E 返回
        </p>
      </div>
    </div>
  )
}
