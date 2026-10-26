import { useState } from 'react'
import { useCharacters, useRelations, useSaveElement } from '../api/hooks'
import type { CharacterRow } from '../api/types'
import { RelationGraph } from '../components/RelationGraph'

const EDIT_FIELDS: { key: keyof CharacterRow; label: string; area?: boolean }[] = [
  { key: 'name', label: '名字' },
  { key: 'role', label: '定位' },
  { key: 'gender', label: '性别' },
  { key: 'age', label: '年龄' },
  { key: 'curTierId', label: '当前境界' },
  { key: 'curPhysical', label: '当前状态' },
  { key: 'personality', label: '性格', area: true },
  { key: 'background', label: '来历', area: true },
  { key: 'motivation', label: '目标', area: true },
  { key: 'arc', label: '变化弧线', area: true },
  { key: 'appearance', label: '外貌', area: true },
  { key: 'visualAnchor', label: '外观锚点（生图用）', area: true },
]

/**
 * 角色（spec §2.1 ③）：卡片 + 编辑 + 关系网络。
 *
 * ★ 保存走 /api/elements → upsertElement：和 CLI 是同一个写入器，
 *   所以 revision / 索引 / git commit 一样都不会漏。
 * ★ 编辑时以「旧对象 + 改动」合并，不重建对象——避免把 stateChapter
 *   这类前端不展示的字段写丢。
 */
export function CastPage() {
  const [tab, setTab] = useState<'cards' | 'graph'>('cards')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<CharacterRow>>({})
  const [msg, setMsg] = useState<string | null>(null)

  const { data: cast, isLoading } = useCharacters()
  const { data: rel } = useRelations(null)
  const save = useSaveElement()
  const rows = cast ?? []
  const edges = rel?.edges ?? []

  const startEdit = (c: CharacterRow): void => {
    setEditing(c.id)
    setDraft({ ...c })
    setMsg(null)
  }

  const submit = (): void => {
    if (cast === undefined || editing === null) return
    const idx = cast.findIndex((c) => c.id === editing)
    if (idx < 0) return
    const next = cast.slice()
    const merged = { ...cast[idx], ...draft } as CharacterRow
    next[idx] = merged
    save.mutate(
      {
        relPath: 'characters/index.json',
        entityType: 'character',
        entityId: editing,
        payload: next,
        reason: '界面编辑角色卡',
      },
      {
        onSuccess: (r) => {
          setMsg(`已保存 · 版本 v${r.version}`)
          setEditing(null)
        },
        onError: (e) => setMsg(e.message),
      },
    )
  }

  const editingRow = rows.find((c) => c.id === editing)

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-6 py-2">
        <h1 className="text-sm font-semibold text-neutral-900">角色</h1>
        <div className="flex gap-1">
          {(['cards', 'graph'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                tab === t ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600'
              }`}
            >
              {t === 'cards' ? '角色卡' : '关系网络'}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-neutral-400">
          {rows.length} 个角色 · {edges.length} 条关系
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          {tab === 'graph' ? (
            <RelationGraph />
          ) : isLoading ? (
            <p className="text-sm text-neutral-500">读取角色…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-neutral-500">还没有角色。</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {rows.map((c) => {
                const mine = edges.filter((e) => e.fromId === c.id || e.toId === c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => startEdit(c)}
                    className={`rounded-lg border bg-white p-4 text-left ${
                      editing === c.id ? 'border-neutral-900' : 'border-neutral-200'
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-neutral-900">{c.name}</span>
                      <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                        {c.role}
                      </span>
                      {c.curTierId !== undefined && (
                        <span className="text-[10px] text-neutral-400">{c.curTierId}</span>
                      )}
                    </div>
                    <p className="mt-2 line-clamp-2 text-[11px] text-neutral-500">
                      {c.personality ?? c.background ?? '—'}
                    </p>
                    <p className="mt-1 text-[10px] text-neutral-400">{mine.length} 条关系</p>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {editingRow !== undefined && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-neutral-200 bg-white">
            <div className="flex items-center gap-2 border-b border-neutral-100 px-4 py-2">
              <span className="text-sm font-medium text-neutral-800">{editingRow.name}</span>
              <span className="text-[10px] text-neutral-400">{editingRow.id}</span>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="ml-auto text-[11px] text-neutral-400 hover:text-neutral-600"
              >
                关闭
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
              {EDIT_FIELDS.map((f) => (
                <div key={String(f.key)}>
                  <span className="text-[11px] text-neutral-400">{f.label}</span>
                  {f.area === true ? (
                    <textarea
                      aria-label={f.label}
                      value={String(draft[f.key] ?? '')}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      rows={2}
                      className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                    />
                  ) : (
                    <input
                      aria-label={f.label}
                      value={String(draft[f.key] ?? '')}
                      onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="border-t border-neutral-100 p-3">
              {msg !== null && <p className="mb-2 text-[11px] text-neutral-500">{msg}</p>}
              <button
                type="button"
                onClick={submit}
                disabled={save.isPending}
                className="w-full rounded bg-neutral-900 py-1.5 text-xs text-white disabled:opacity-40"
              >
                {save.isPending ? '保存中…' : '保存'}
              </button>
              <p className="mt-2 text-[10px] text-neutral-400">
                保存会写入 characters/index.json，并自动生成 revision 与 git commit。
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
