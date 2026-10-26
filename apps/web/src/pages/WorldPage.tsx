import { useState } from 'react'
import { usePowerSystem, useRules, useSaveElement } from '../api/hooks'
import type { PowerSystem, WorldRuleRow } from '../api/types'
import { WorldMap } from '../components/WorldMap'

/**
 * 世界（spec §2.1 ②）：力量体系 / 世界规则 / 地点路线。
 *
 * ★ 规则分 hard / soft 两级：hard 是「写了会崩设定」的硬约束，
 *   提示词里全量注入；soft 只作参考，可降级。编辑界面必须让这个区别一眼可见。
 */
export function WorldPage() {
  const [tab, setTab] = useState<'rules' | 'map'>('rules')

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-6 py-2">
        <h1 className="text-sm font-semibold text-neutral-900">世界</h1>
        <div className="flex gap-1">
          {(['rules', 'map'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                tab === t ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600'
              }`}
            >
              {t === 'rules' ? '规则与力量体系' : '地点与路线'}
            </button>
          ))}
        </div>
      </header>

      {tab === 'map' ? (
        <div className="min-h-0 flex-1">
          <WorldMap />
        </div>
      ) : (
        <RulesEditor />
      )}
    </div>
  )
}

function RulesEditor() {
  const { data: rules, isLoading: rl } = useRules()
  const { data: ps, isLoading: pl } = usePowerSystem()
  const save = useSaveElement()
  const [ruleDraft, setRuleDraft] = useState<WorldRuleRow[] | null>(null)
  const [psDraft, setPsDraft] = useState<PowerSystem | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  if (rl || pl) return <p className="p-6 text-sm text-neutral-500">读取世界设定…</p>

  const ruleRows = ruleDraft ?? rules ?? []
  const sys = psDraft ?? ps ?? null

  const saveRules = (): void => {
    if (ruleDraft === null) return
    save.mutate(
      {
        relPath: 'world/rules.json',
        entityType: 'world_rule',
        entityId: 'rules',
        payload: ruleDraft,
        reason: '界面编辑世界规则',
      },
      {
        onSuccess: (r) => setMsg(`规则已保存 · v${r.version}`),
        onError: (e) => setMsg(e.message),
      },
    )
  }

  const savePower = (): void => {
    if (psDraft === null || psDraft === undefined) return
    save.mutate(
      {
        relPath: 'world/power-system.json',
        entityType: 'power_system',
        entityId: psDraft.id,
        payload: psDraft,
        reason: '界面编辑力量体系',
      },
      {
        onSuccess: (r) => setMsg(`力量体系已保存 · v${r.version}`),
        onError: (e) => setMsg(e.message),
      },
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        {msg !== null && (
          <p className="rounded border border-neutral-200 bg-white px-3 py-2 text-[11px] text-neutral-600">
            {msg}
          </p>
        )}

        {/* 力量体系 */}
        <section className="rounded-lg border border-neutral-200 bg-white">
          <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-2">
            <h2 className="text-sm font-medium text-neutral-800">力量体系</h2>
            <span className="text-[11px] text-neutral-400">境界由低到高；角色卡引用 tier id</span>
            <button
              type="button"
              onClick={savePower}
              disabled={psDraft === null || save.isPending}
              className="ml-auto rounded bg-neutral-900 px-2.5 py-1 text-[11px] text-white disabled:opacity-30"
            >
              保存
            </button>
          </div>
          {sys === null ? (
            <p className="px-4 py-4 text-xs text-neutral-400">还没有力量体系</p>
          ) : (
            <div className="space-y-3 p-4">
              <div className="flex gap-3">
                <label className="flex-1">
                  <span className="text-[11px] text-neutral-400">体系名称</span>
                  <input
                    value={sys.name}
                    onChange={(e) => setPsDraft({ ...sys, name: e.target.value })}
                    className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                  />
                </label>
                <label className="flex-[2]">
                  <span className="text-[11px] text-neutral-400">一句话说明</span>
                  <input
                    value={sys.description ?? ''}
                    onChange={(e) => setPsDraft({ ...sys, description: e.target.value })}
                    className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-[12px]"
                  />
                </label>
              </div>
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] text-neutral-400">
                    <th className="w-16 py-1">id</th>
                    <th className="w-24 py-1">层级</th>
                    <th className="py-1">名称</th>
                  </tr>
                </thead>
                <tbody>
                  {sys.tiers.map((t, i) => (
                    <tr key={t.id}>
                      <td className="py-0.5 font-mono text-[10px] text-neutral-400">{t.id}</td>
                      <td className="py-0.5">
                        <input
                          type="number"
                          value={t.level}
                          onChange={(e) => {
                            const tiers = sys.tiers.slice()
                            tiers[i] = { ...t, level: Number(e.target.value) }
                            setPsDraft({ ...sys, tiers })
                          }}
                          className="w-16 rounded border border-neutral-300 px-1.5 py-0.5"
                        />
                      </td>
                      <td className="py-0.5">
                        <input
                          value={t.name}
                          onChange={(e) => {
                            const tiers = sys.tiers.slice()
                            tiers[i] = { ...t, name: e.target.value }
                            setPsDraft({ ...sys, tiers })
                          }}
                          className="w-full rounded border border-neutral-300 px-1.5 py-0.5"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 世界规则 */}
        <section className="rounded-lg border border-neutral-200 bg-white">
          <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-2">
            <h2 className="text-sm font-medium text-neutral-800">世界规则</h2>
            <span className="text-[11px] text-neutral-400">
              hard = 必注入提示词；soft = 参考，可降级
            </span>
            <button
              type="button"
              onClick={saveRules}
              disabled={ruleDraft === null || save.isPending}
              className="ml-auto rounded bg-neutral-900 px-2.5 py-1 text-[11px] text-white disabled:opacity-30"
            >
              保存
            </button>
          </div>
          <div className="divide-y divide-neutral-50">
            {ruleRows.map((r, i) => (
              <div key={r.id} className="flex items-start gap-2 px-4 py-2">
                <span className="mt-1.5 w-10 shrink-0 font-mono text-[10px] text-neutral-400">
                  {r.id}
                </span>
                <select
                  value={r.priority}
                  onChange={(e) => {
                    const next = ruleRows.slice()
                    next[i] = { ...r, priority: e.target.value as 'hard' | 'soft' }
                    setRuleDraft(next)
                  }}
                  className={`mt-1 h-6 shrink-0 rounded border px-1 text-[10px] ${
                    r.priority === 'hard'
                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                      : 'border-neutral-200 text-neutral-500'
                  }`}
                >
                  <option value="hard">hard</option>
                  <option value="soft">soft</option>
                </select>
                <input
                  value={r.name}
                  onChange={(e) => {
                    const next = ruleRows.slice()
                    next[i] = { ...r, name: e.target.value }
                    setRuleDraft(next)
                  }}
                  className="mt-0.5 w-32 shrink-0 rounded border border-neutral-300 px-2 py-1 text-[12px]"
                />
                <textarea
                  value={r.content}
                  rows={2}
                  onChange={(e) => {
                    const next = ruleRows.slice()
                    next[i] = { ...r, content: e.target.value }
                    setRuleDraft(next)
                  }}
                  className="mt-0.5 min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-[12px]"
                />
              </div>
            ))}
            {ruleRows.length === 0 && (
              <p className="px-4 py-4 text-xs text-neutral-400">还没有规则</p>
            )}
          </div>
        </section>

        <p className="text-[11px] text-neutral-400">
          改动保存后写入 world/rules.json 与 world/power-system.json，下一次生成立即生效。
        </p>
      </div>
    </div>
  )
}
