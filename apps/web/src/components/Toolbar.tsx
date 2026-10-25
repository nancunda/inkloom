import { useState } from 'react'
import {
  useApplyProposals,
  useFinalize,
  useGenerate,
  usePropose,
  useUnfinalize,
} from '../api/hooks'
import type { ChapterDetail, ProposeResult } from '../api/types'

interface Props {
  chapter: ChapterDetail | undefined
}

/**
 * 操作栏：生成 / 定稿 / 提案。
 *
 * ★ 每个按钮的 disabled 都由「数据能否支持这个动作」推出，并附 title 说明原因。
 *   例如定稿要求「本章没有 candidate」——这个规则是后端定的，前端只是把它显示出来。
 */
export function Toolbar({ chapter }: Props) {
  const chapterNo = chapter?.chapterNo ?? 0
  const generate = useGenerate()
  const finalize = useFinalize()
  const unfinalize = useUnfinalize()
  const propose = usePropose()
  const apply = useApplyProposals()

  const [guidance, setGuidance] = useState('')
  const [proposals, setProposals] = useState<ProposeResult | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const scenes = chapter?.scenes ?? []
  const hasCandidate = scenes.some((s) => s.status === 'candidate')
  const hasAccepted = scenes.some((s) => s.status === 'accepted')
  const isFinalized = chapter?.status === 'finalized'

  const busy =
    generate.isPending ||
    finalize.isPending ||
    unfinalize.isPending ||
    propose.isPending ||
    apply.isPending

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <aside className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 bg-neutral-50">
      <div className="space-y-4 p-4">
        <section>
          <label
            htmlFor="guidance"
            className="mb-1 block text-xs font-medium tracking-wide text-neutral-500"
          >
            本章额外指导（可选）
          </label>
          <textarea
            id="guidance"
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            rows={2}
            placeholder="例如：让林岚少说话"
            className="w-full resize-none rounded border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy || chapterNo === 0}
            onClick={() =>
              void run(() =>
                generate.mutateAsync({
                  chapterNo,
                  ...(guidance.trim().length === 0 ? {} : { guidance: guidance.trim() }),
                }),
              )
            }
            className="mt-2 w-full rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {generate.isPending ? '生成中…（40–90 秒）' : '生成本章'}
          </button>
          {generate.isPending && (
            <p className="mt-1 text-xs text-neutral-500">
              模型在思考，这个请求会一直等到返回。不要刷新页面。
            </p>
          )}
        </section>

        <section className="border-t border-neutral-200 pt-4">
          <div className="mb-2 text-xs font-medium tracking-wide text-neutral-500">定稿</div>
          <button
            type="button"
            disabled={busy || hasCandidate || !hasAccepted || isFinalized}
            onClick={() => void run(() => finalize.mutateAsync({ chapterNo }))}
            title={
              isFinalized
                ? '本章已定稿'
                : hasCandidate
                  ? '还有待确认的场景，全部处理完才能定稿'
                  : !hasAccepted
                    ? '还没有接受的场景'
                    : '合并已接受的场景为正文'
            }
            className="w-full rounded bg-emerald-600 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            定稿
          </button>
          {isFinalized && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => unfinalize.mutateAsync({ chapterNo }))}
              className="mt-2 w-full rounded border border-neutral-300 px-3 py-2 text-sm text-neutral-700"
            >
              撤销定稿
            </button>
          )}
          {chapter !== undefined && chapter.summary !== null && (
            <p className="mt-2 text-xs leading-5 text-neutral-500">{chapter.summary}</p>
          )}
        </section>

        <section className="border-t border-neutral-200 pt-4">
          <div className="mb-2 text-xs font-medium tracking-wide text-neutral-500">状态提案</div>
          <button
            type="button"
            disabled={busy || !isFinalized}
            onClick={() =>
              void run(async () => {
                const r = await propose.mutateAsync({ chapterNo })
                setProposals(r)
                setPicked(new Set(r.proposals.filter((p) => p.evidenceVerified).map((p) => p.id)))
              })
            }
            title={isFinalized ? '读本章正文，提取角色状态变化' : '先定稿才能做状态提案'}
            className="w-full rounded border border-neutral-300 px-3 py-2 text-sm text-neutral-700 disabled:cursor-not-allowed disabled:text-neutral-300"
          >
            {propose.isPending ? '提取中…' : '提取状态变化'}
          </button>

          {proposals !== null && (
            <div className="mt-3 space-y-2">
              {proposals.proposals.length === 0 && (
                <p className="text-xs text-neutral-500">本章没有检测到状态变化。</p>
              )}
              {proposals.proposals.map((p) => (
                <label
                  key={p.id}
                  className={`block rounded border p-2 text-xs ${
                    p.evidenceVerified
                      ? 'border-neutral-200 bg-white'
                      : 'border-amber-300 bg-amber-50'
                  }`}
                >
                  <span className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={picked.has(p.id)}
                      onChange={(e) => {
                        const next = new Set(picked)
                        if (e.target.checked) next.add(p.id)
                        else next.delete(p.id)
                        setPicked(next)
                      }}
                      className="mt-0.5"
                    />
                    <span className="flex-1">
                      <span className="font-medium text-neutral-800">
                        {p.characterName} · {p.field}
                      </span>
                      <span className="block text-neutral-600">
                        → {p.newValue}（第 {p.stateChapter} 章起）
                      </span>
                      <span className="mt-1 block text-neutral-500">
                        {p.evidenceVerified ? '✓' : '⚠'} 「{p.evidenceQuote}」
                      </span>
                      {!p.evidenceVerified && (
                        <span className="mt-1 block text-amber-700">
                          这句在正文里找不到，确认前请自己查一遍
                        </span>
                      )}
                    </span>
                  </span>
                </label>
              ))}
              {proposals.proposals.length > 0 && (
                <button
                  type="button"
                  disabled={busy || picked.size === 0}
                  onClick={() =>
                    void run(async () => {
                      await apply.mutateAsync({ chapterNo, acceptIds: [...picked] })
                      setProposals(null)
                      setPicked(new Set())
                    })
                  }
                  className="w-full rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-neutral-300"
                >
                  应用 {picked.size} 条
                </button>
              )}
            </div>
          )}
        </section>

        {error !== null && (
          <p className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            {error}
          </p>
        )}
      </div>
    </aside>
  )
}
