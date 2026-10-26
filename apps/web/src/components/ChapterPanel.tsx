import { useState } from 'react'
import { useBlueprints, useCharacters, useThreads } from '../api/hooks'
import type { ChapterDetail } from '../api/types'
import { Toolbar } from './Toolbar'

const BEAT_LABEL: Record<string, string> = {
  setup: '铺垫',
  rising: '上升',
  climax: '高潮',
  twist: '转折',
  falling: '回落',
  resolution: '收束',
}

/**
 * 写作页右栏（spec §4.13）：本章蓝图 / 出场角色 / 未兑现 + 折叠的操作区。
 *
 * ★ 顺序不是随意的：写之前先看「这章要干什么」（蓝图），再看「谁在场」
 *   （角色状态），最后看「有没有欠读者的账」（未兑现）。操作按钮收在最后，
 *   因为它们是执行，不是判断依据。
 * ★ 「状态可能过时」来自 character.stateStale：正文已经写到角色状态
 *   发生变化的那一章之后，而角色卡还没更新——不提示的话，作者会拿旧状态写。
 */
export function ChapterPanel({ chapter }: { chapter: ChapterDetail | undefined }) {
  const chapterNo = chapter?.chapterNo ?? 0
  const { data: bp } = useBlueprints()
  const { data: cast } = useCharacters()
  const { data: threads } = useThreads()
  const [tools, setTools] = useState(false)

  const blue = bp?.chapters.find((c) => c.chapterNo === chapterNo)
  const castIds = blue?.castIds ?? []
  const castRows = (cast ?? []).filter((c) => castIds.includes(c.id))
  const active = (threads?.threads ?? []).filter((t) => t.status === 'active')
  const overdue = active.filter((t) => t.overdue)

  return (
    <aside className="flex w-[320px] shrink-0 flex-col overflow-y-auto border-l border-neutral-200 bg-neutral-50">
      <div className="space-y-4 p-4">
        <section>
          <h3 className="mb-2 text-[11px] font-medium tracking-wide text-neutral-400">本章蓝图</h3>
          {blue === undefined ? (
            <p className="text-[12px] text-neutral-400">
              还没有第 {chapterNo} 章蓝图，去「故事」建一个再写。
            </p>
          ) : (
            <div className="space-y-1.5 rounded-lg border border-neutral-200 bg-white p-3 text-[12px]">
              <p className="text-neutral-800">{blue.title ?? `第 ${chapterNo} 章`}</p>
              <Field k="目标" v={blue.goal} />
              <Field k="冲突" v={blue.conflict} />
              <Field k="钩子" v={blue.hook} />
              <div className="flex items-center gap-1.5 pt-1 text-[11px] text-neutral-500">
                <span
                  role="img"
                  className="text-neutral-800"
                  title={`张力 ${blue.tensionLevel}/5`}
                  aria-label={`张力 ${blue.tensionLevel} / 5`}
                >
                  {'●'.repeat(blue.tensionLevel)}
                  {'○'.repeat(Math.max(0, 5 - blue.tensionLevel))}
                </span>
                <span>{BEAT_LABEL[blue.beatType] ?? blue.beatType}</span>
              </div>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-medium tracking-wide text-neutral-400">
            出场角色 {castRows.length > 0 ? `· ${castRows.length}` : ''}
          </h3>
          {castRows.length === 0 ? (
            <p className="text-[12px] text-neutral-400">
              {castIds.length === 0 ? '蓝图里还没填出场角色' : '角色卡里找不到这些 id'}
            </p>
          ) : (
            <ul className="space-y-1">
              {castRows.map((c) => (
                <li
                  key={c.id}
                  className="rounded border border-neutral-200 bg-white px-2.5 py-1.5 text-[12px]"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-neutral-800">{c.name}</span>
                    {c.curTierId !== undefined && (
                      <span className="text-[10px] text-neutral-400">{c.curTierId}</span>
                    )}
                    {c.curPhysical !== undefined && c.curPhysical !== '' && (
                      <span className="text-[10px] text-neutral-500">{c.curPhysical}</span>
                    )}
                  </div>
                  {c.stateStale === true && (
                    <p className="mt-0.5 text-[10px] text-amber-700">
                      ⚠ 状态可能过时，先更新角色卡
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-medium tracking-wide text-neutral-400">
            未兑现 {active.length > 0 ? `· ${active.length}` : ''}
            {overdue.length > 0 ? ` · ${overdue.length} 逾期` : ''}
          </h3>
          {active.length === 0 ? (
            <p className="text-[12px] text-neutral-400">没有悬着的线</p>
          ) : (
            <ul className="space-y-0.5 text-[12px]">
              {active.slice(0, 12).map((t) => (
                <li
                  key={t.id}
                  className={t.overdue ? 'text-rose-700' : 'text-neutral-600'}
                  title={t.payoffHint !== '' ? t.payoffHint : undefined}
                >
                  {t.overdue ? '🔴' : '🟡'} {t.title}
                  {t.payoffWindow !== null && (
                    <span className="ml-1 text-[10px] text-neutral-400">
                      ≤第 {t.payoffWindow} 章
                    </span>
                  )}
                </li>
              ))}
              {active.length > 12 && (
                <li className="text-[10px] text-neutral-400">还有 {active.length - 12} 条…</li>
              )}
            </ul>
          )}
        </section>

        <section className="border-t border-neutral-200 pt-3">
          <button
            type="button"
            onClick={() => setTools(!tools)}
            className="flex w-full items-center justify-between text-[11px] text-neutral-500"
          >
            <span>操作（生成 / 定稿 / 体检）</span>
            <span className="text-neutral-400">{tools ? '收起' : '展开'}</span>
          </button>
          {tools && (
            <div className="mt-2">
              <Toolbar chapter={chapter} plain />
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <p className="text-[11px] leading-5 text-neutral-600">
      <span className="mr-1 text-neutral-400">{k}</span>
      {v}
    </p>
  )
}
