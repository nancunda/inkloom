import { useAssets, useRelations } from '../api/hooks'

/**
 * 素材（spec §2.1 ⑥）：人物形象图廊。
 *
 * ★ 图从 /api/assets/file 取（后端只允许 assets/ 下路径），
 *   不在前端拼绝对路径——书目录换位置也不会断。
 * ★ 没图时给生成命令，而不是一句「暂无数据」。
 */
export function AssetsPage() {
  const { data, isLoading } = useAssets()
  const { data: rel } = useRelations(null)
  const nameOf = new Map((rel?.nodes ?? []).map((n) => [n.id, n.name]))
  const items = data?.characters ?? []

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-6 py-2">
        <h1 className="text-sm font-semibold text-neutral-900">素材</h1>
        <p className="mt-0.5 text-[11px] text-neutral-500">
          人物形象由外观锚点生成，落盘后连 prompt / provider / model 一起记进 Asset，可复现。
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <p className="text-sm text-neutral-500">读取素材…</p>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center">
            <p className="text-sm text-neutral-600">还没有人物形象</p>
            <p className="mt-2 text-[11px] text-neutral-400">在项目目录运行：</p>
            <pre className="mx-auto mt-1 w-fit rounded bg-neutral-100 px-3 py-1.5 text-[11px] text-neutral-600">
              pnpm cli portrait ./my-novel --character c1
            </pre>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-4">
            {items.map((it) => (
              <figure
                key={it.filePath}
                className="overflow-hidden rounded-lg border border-neutral-200 bg-white"
              >
                <img
                  src={`/api/assets/file?path=${encodeURIComponent(it.filePath)}`}
                  alt={nameOf.get(it.ownerId) ?? it.ownerId}
                  className="aspect-[3/4] w-full object-cover"
                />
                <figcaption className="flex items-baseline justify-between px-3 py-2">
                  <span className="text-[13px] text-neutral-800">
                    {nameOf.get(it.ownerId) ?? it.ownerId}
                  </span>
                  <span className="text-[10px] text-neutral-400">{it.ownerId}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
