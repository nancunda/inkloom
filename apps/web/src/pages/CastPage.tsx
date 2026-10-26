import { useState } from 'react'
import { useRelations } from '../api/hooks'
import { RelationGraph } from '../components/RelationGraph'

/**
 * 角色（spec §2.1 ③）：角色卡 + 关系网络。
 *
 * ★ 关系图是「图即操作」的地方（拖线建关系），角色卡是查阅入口；
 *   两者放同一模块的两个 tab，别让用户在两个页面之间来回跳。
 */
export function CastPage() {
  const [tab, setTab] = useState<'cards' | 'graph'>('cards')
  const [selected, setSelected] = useState<string | null>(null)
  const { data } = useRelations(null)
  const nodes = data?.nodes ?? []
  const edges = data?.edges ?? []
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]))

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
          {nodes.length} 个角色 · {edges.length} 条关系
        </span>
      </header>

      <div className="min-h-0 flex-1">
        {tab === 'graph' ? (
          <RelationGraph />
        ) : (
          <div className="h-full overflow-y-auto p-6">
            {nodes.length === 0 ? (
              <p className="text-sm text-neutral-500">
                还没有角色。用 CLI 写入：
                <code className="rounded bg-neutral-100 px-1">
                  inkloom element set … --type character
                </code>
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {nodes.map((n) => {
                  const mine = edges.filter((e) => e.fromId === n.id || e.toId === n.id)
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => setSelected(selected === n.id ? null : n.id)}
                      className={`rounded-lg border bg-white p-4 text-left ${
                        selected === n.id ? 'border-neutral-900' : 'border-neutral-200'
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium text-neutral-900">{n.name}</span>
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                          {n.role}
                        </span>
                      </div>
                      <p className="mt-2 text-[11px] text-neutral-400">
                        {mine.length} 条关系 · {n.id}
                      </p>
                      {selected === n.id && (
                        <ul className="mt-2 space-y-1 border-t border-neutral-100 pt-2">
                          {mine.length === 0 && (
                            <li className="text-[11px] text-neutral-400">
                              还没有关系，去「关系网络」拖线建一条
                            </li>
                          )}
                          {mine.map((e) => (
                            <li key={e.id} className="text-[11px] text-neutral-600">
                              {e.fromId === n.id ? '→' : '←'}{' '}
                              {nameOf.get(e.fromId === n.id ? e.toId : e.fromId) ?? '?'}
                              <span className="ml-1 text-neutral-400">
                                {e.kind} · 强度 {e.strength}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            <p className="mt-4 text-[11px] text-neutral-400">
              动态状态、签名、外观锚点等详细字段在{' '}
              <code className="rounded bg-neutral-100 px-1">characters/index.json</code>，
              下一轮在此页面提供编辑。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
