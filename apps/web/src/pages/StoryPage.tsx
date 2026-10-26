import { useEffect, useState } from 'react'
import { useBlueprints, useBook, useCreateBlueprint } from '../api/hooks'
import { StoryMap } from '../components/StoryMap'
import { ThreadTimeline } from '../components/ThreadTimeline'
import { STATUS_LABEL, STATUS_MARK } from '../lib/status'
import { useSessionStore } from '../stores/session'

const BEATS = ['setup', 'rising', 'climax', 'twist', 'falling', 'resolution'] as const
const BEAT_LABEL: Record<string, string> = {
  setup: '铺垫',
  rising: '上升',
  climax: '高潮',
  twist: '转折',
  falling: '回落',
  resolution: '收束',
}

/**
 * 故事（spec §2.1 ④）：章节蓝图 / 叙事地图 / 剧情线索。
 *
 * ★ 蓝图放第一位：它是「接下来要发生什么」的入口，也是生成的前提。
 * ★ 新建蓝图不需要离开页面——写完目标/冲突/钩子，切到写作就能生成。
 */
export function StoryPage() {
  const [tab, setTab] = useState<'blueprint' | 'map' | 'threads'>('blueprint')
  const setChapter = useSessionStore((s) => s.setChapter)

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-6 py-2">
        <h1 className="text-sm font-semibold text-neutral-900">故事</h1>
        <div className="flex gap-1">
          {(['blueprint', 'map', 'threads'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                tab === t ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600'
              }`}
            >
              {t === 'blueprint' ? '章节蓝图' : t === 'map' ? '叙事地图' : '线索轨迹'}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-neutral-400">
          {tab === 'blueprint' ? '目标是必填：没有目标的章生成不出东西' : ''}
        </span>
      </header>

      <div className="min-h-0 flex-1">
        {tab === 'blueprint' ? (
          <BlueprintTab onOpen={(n) => setChapter(n)} />
        ) : tab === 'map' ? (
          <StoryMap onPick={(n) => setChapter(n)} />
        ) : (
          <ThreadTimeline />
        )}
      </div>
    </div>
  )
}

function BlueprintTab({ onOpen }: { onOpen: (chapterNo: number) => void }) {
  const { data: bp } = useBlueprints()
  const { data: book } = useBook()
  const create = useCreateBlueprint()
  const rows = bp?.chapters ?? []

  const maxNo = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.chapterNo))
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [form, setForm] = useState({
    chapterNo: maxNo + 1,
    title: '',
    goal: '',
    conflict: '',
    hook: '',
    beatType: 'rising' as string,
    tensionLevel: 3,
  })

  // 蓝图数量变了，下一次新建的默认章号也跟着变
  useEffect(() => {
    setForm((f) => ({ ...f, chapterNo: maxNo + 1 }))
  }, [maxNo])

  const submit = (): void => {
    if (form.goal.trim() === '' || form.conflict.trim() === '' || form.hook.trim() === '') {
      setMsg('目标 / 冲突 / 钩子 是必填项')
      return
    }
    create.mutate(
      {
        chapterNo: form.chapterNo,
        ...(form.title.trim() === '' ? {} : { title: form.title.trim() }),
        goal: form.goal.trim(),
        conflict: form.conflict.trim(),
        hook: form.hook.trim(),
        beatType: form.beatType,
        tensionLevel: form.tensionLevel,
      },
      {
        onSuccess: (r) => {
          setMsg(`已创建第 ${r.chapterNo} 章蓝图 · v${r.version}`)
          setOpen(false)
          setForm((f) => ({ ...f, title: '', goal: '', conflict: '', hook: '' }))
        },
        onError: (e) => setMsg(e.message),
      },
    )
  }

  const statusOf = (chapterNo: number): string =>
    book?.chapters.find((c) => c.chapterNo === chapterNo)?.status ?? 'planned'
  const wordsOf = (chapterNo: number): number =>
    book?.chapters.find((c) => c.chapterNo === chapterNo)?.wordCount ?? 0

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        <div className="flex items-center gap-3">
          <p className="text-xs text-neutral-500">
            {rows.length} 章蓝图 · 第 {maxNo} 章之后可继续新建
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(!open)
              setMsg(null)
            }}
            className="ml-auto rounded bg-neutral-900 px-3 py-1 text-[11px] text-white"
          >
            {open ? '取消' : `＋ 新建第 ${maxNo + 1} 章`}
          </button>
        </div>

        {msg !== null && (
          <p className="rounded border border-neutral-200 bg-white px-3 py-2 text-[11px] text-neutral-600">
            {msg}
          </p>
        )}

        {open && (
          <section className="rounded-lg border border-neutral-300 bg-white p-4">
            <div className="grid grid-cols-6 gap-3">
              <label className="col-span-1 block">
                <span className="text-[11px] text-neutral-400">章号</span>
                <input
                  type="number"
                  min={1}
                  value={form.chapterNo}
                  onChange={(e) => setForm({ ...form, chapterNo: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                />
              </label>
              <label className="col-span-2 block">
                <span className="text-[11px] text-neutral-400">标题（可选）</span>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                />
              </label>
              <label className="col-span-1 block">
                <span className="text-[11px] text-neutral-400">节拍</span>
                <select
                  value={form.beatType}
                  onChange={(e) => setForm({ ...form, beatType: e.target.value })}
                  className="mt-0.5 w-full rounded border border-neutral-300 px-1 py-1 text-[12px]"
                >
                  {BEATS.map((b) => (
                    <option key={b} value={b}>
                      {BEAT_LABEL[b]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-1 block">
                <span className="text-[11px] text-neutral-400">张力 1–5</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={form.tensionLevel}
                  onChange={(e) => setForm({ ...form, tensionLevel: Number(e.target.value) })}
                  className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                />
              </label>
              <div className="col-span-6 grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-[11px] text-neutral-400">目标（必填）</span>
                  <textarea
                    value={form.goal}
                    onChange={(e) => setForm({ ...form, goal: e.target.value })}
                    rows={2}
                    className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-neutral-400">冲突（必填）</span>
                  <textarea
                    value={form.conflict}
                    onChange={(e) => setForm({ ...form, conflict: e.target.value })}
                    rows={2}
                    className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-neutral-400">章末钩子（必填）</span>
                  <textarea
                    value={form.hook}
                    onChange={(e) => setForm({ ...form, hook: e.target.value })}
                    rows={2}
                    className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                  />
                </label>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={create.isPending}
                className="rounded bg-neutral-900 px-3 py-1 text-[11px] text-white disabled:opacity-40"
              >
                {create.isPending ? '创建中…' : '创建蓝图'}
              </button>
              <span className="text-[10px] text-neutral-400">
                创建后写入 story/blueprints/，并自动 commit
              </span>
            </div>
          </section>
        )}

        <section className="rounded-lg border border-neutral-200 bg-white">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-[10px] text-neutral-400">
                <th className="w-14 px-3 py-2">章</th>
                <th className="w-36 px-2 py-2">标题</th>
                <th className="px-2 py-2">目标</th>
                <th className="px-2 py-2">冲突</th>
                <th className="px-2 py-2">钩子</th>
                <th className="w-14 px-2 py-2">节拍</th>
                <th className="w-12 px-2 py-2">张力</th>
                <th className="w-24 px-2 py-2">状态</th>
                <th className="w-16 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.chapterNo} className="border-b border-neutral-50 last:border-0">
                  <td className="px-3 py-2 text-neutral-400">{r.chapterNo}</td>
                  <td className="px-2 py-2 text-neutral-800">{r.title ?? '—'}</td>
                  <td className="px-2 py-2 text-neutral-600">{r.goal}</td>
                  <td className="px-2 py-2 text-neutral-600">{r.conflict}</td>
                  <td className="px-2 py-2 text-neutral-500">{r.hook}</td>
                  <td className="px-2 py-2 text-neutral-500">
                    {BEAT_LABEL[r.beatType] ?? r.beatType}
                  </td>
                  <td className="px-2 py-2 text-neutral-500">{r.tensionLevel}</td>
                  <td className="px-2 py-2 text-[11px] text-neutral-500">
                    {STATUS_MARK[statusOf(r.chapterNo)] ?? '○'}{' '}
                    {STATUS_LABEL[statusOf(r.chapterNo)] ?? statusOf(r.chapterNo)}
                    {wordsOf(r.chapterNo) > 0 ? ` · ${wordsOf(r.chapterNo)} 字` : ''}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onOpen(r.chapterNo)}
                      className="text-[11px] text-neutral-500 underline-offset-2 hover:underline"
                    >
                      去写
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-xs text-neutral-400">
                    还没有蓝图。点右上角「新建第 1 章」开始。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
