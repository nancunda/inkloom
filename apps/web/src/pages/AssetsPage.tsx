import { useState } from 'react'
import { useAssets, useCharacters, useGeneratePortrait, useRelations } from '../api/hooks'

/**
 * 素材（spec §2.1 ⑥）：人物形象图廊 + 生成入口。
 *
 * ★ 生图不再是 CLI 专属：选角色 → 生成 → 落盘 → 图廊立即出现。
 *   服务端调的还是 generatePortrait（和 CLI 同一条链路），不是另写一套。
 * ★ 图片地址带 cache-bust 参数：同一个角色重新生成后文件名不变，
 *   不带参数浏览器会一直显示旧图——这个坑在验证时踩过。
 */
export function AssetsPage() {
  const { data, isLoading } = useAssets()
  const { data: cast } = useCharacters()
  const { data: rel } = useRelations(null)
  const gen = useGeneratePortrait()

  const nameOf = new Map((rel?.nodes ?? []).map((n) => [n.id, n.name]))
  const items = data?.characters ?? []
  const missing = (cast ?? []).filter(
    (c) =>
      !items.some((it) => it.ownerId === c.id) && (c.visualAnchor ?? c.appearance ?? '') !== '',
  )

  const [charId, setCharId] = useState('')
  const [style, setStyle] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const run = (id: string): void => {
    if (id === '') {
      setMsg('先选一个角色')
      return
    }
    setMsg(null)
    gen.mutate(
      { characterId: id, ...(style.trim() === '' ? {} : { style: style.trim() }) },
      {
        onSuccess: (r) => {
          setTick((t) => t + 1)
          setMsg(`已生成「${r.name}」→ ${r.filePath}`)
        },
        onError: (e) => setMsg(e.message),
      },
    )
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-6 py-2">
        <h1 className="text-sm font-semibold text-neutral-900">素材</h1>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          人物形象由外观锚点生成，落盘后连 prompt / provider / model 一起记进 Asset，可复现。
        </p>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-100 bg-white px-6 py-2">
        <select
          aria-label="选择角色"
          value={charId}
          onChange={(e) => setCharId(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 text-[12px]"
        >
          <option value="">选择角色…</option>
          {(cast ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.id}）{(c.visualAnchor ?? '') === '' ? ' · 无锚点' : ''}
            </option>
          ))}
        </select>
        <input
          aria-label="风格后缀"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="风格（可选，默认国风插画·半身像）"
          className="w-64 rounded border border-neutral-300 px-2 py-1 text-[12px]"
        />
        <button
          type="button"
          onClick={() => run(charId)}
          disabled={gen.isPending}
          className="rounded bg-neutral-900 px-3 py-1 text-[11px] text-white disabled:opacity-40"
        >
          {gen.isPending ? '生成中…（约 10–20 秒）' : '生成形象'}
        </button>
        {missing.length > 0 && (
          <button
            type="button"
            onClick={() => setCharId(missing[0]?.id ?? '')}
            className="text-[11px] text-neutral-400 underline-offset-2 hover:underline"
          >
            {missing.length} 个角色还没有图
          </button>
        )}
        {msg !== null && <span className="text-[11px] text-neutral-600">{msg}</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <p className="text-sm text-neutral-500">读取素材…</p>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center">
            <p className="text-sm text-neutral-600">还没有人物形象</p>
            <p className="mt-1 text-[11px] text-neutral-400">
              上面选一个角色点「生成形象」；没有 key 时先去「设置」填硅基流动 Key。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-4">
            {items.map((it) => (
              <figure
                key={it.filePath}
                className="overflow-hidden rounded-lg border border-neutral-200 bg-white"
              >
                <img
                  src={`/api/assets/file?path=${encodeURIComponent(it.filePath)}&t=${tick}`}
                  alt={nameOf.get(it.ownerId) ?? it.ownerId}
                  className="aspect-[3/4] w-full object-cover"
                />
                <figcaption className="flex items-center gap-2 px-3 py-2">
                  <span className="text-[13px] text-neutral-800">
                    {nameOf.get(it.ownerId) ?? it.ownerId}
                  </span>
                  <span className="text-[10px] text-neutral-400">{it.ownerId}</span>
                  <button
                    type="button"
                    onClick={() => run(it.ownerId)}
                    disabled={gen.isPending}
                    className="ml-auto text-[10px] text-neutral-400 underline-offset-2 hover:text-neutral-700 hover:underline disabled:opacity-30"
                  >
                    重新生成
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
