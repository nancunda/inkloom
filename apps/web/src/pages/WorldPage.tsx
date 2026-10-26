import { useState } from 'react'
import { useLocations, usePowerSystem, useRoutes, useRules, useSaveElement } from '../api/hooks'
import type { LocationRow, PowerSystem, RouteRow, WorldRuleRow } from '../api/types'
import { WorldMap } from '../components/WorldMap'

const LOCATION_TYPES: { value: string; label: string }[] = [
  { value: 'city', label: '城镇' },
  { value: 'mountain', label: '山' },
  { value: 'sect', label: '宗门' },
  { value: 'secret_realm', label: '秘境' },
  { value: 'ruin', label: '遗址' },
  { value: 'plain', label: '原野' },
]

const ROUTE_MODES: { value: string; label: string }[] = [
  { value: 'walk', label: '步行' },
  { value: 'ride', label: '骑行' },
  { value: 'fly', label: '飞行' },
  { value: 'teleport', label: '传送' },
  { value: 'boat', label: '水路' },
  { value: 'caravan', label: '商队' },
]

/**
 * 世界（spec §2.1 ②）：力量体系 / 世界规则 / 地点路线。
 *
 * ★ 规则分 hard / soft 两级：hard 是「写了会崩设定」的硬约束，
 *   提示词里全量注入；soft 只作参考，可降级。编辑界面必须让这个区别一眼可见。
 */
export function WorldPage() {
  const [tab, setTab] = useState<'rules' | 'places' | 'map'>('rules')

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-200 bg-white px-6 py-2">
        <h1 className="text-sm font-semibold text-neutral-900">世界</h1>
        <div className="flex gap-1">
          {(['rules', 'places', 'map'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                tab === t ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600'
              }`}
            >
              {t === 'rules' ? '规则与力量体系' : t === 'places' ? '地点与路线' : '地图'}
            </button>
          ))}
        </div>
      </header>

      {tab === 'map' ? (
        <div className="min-h-0 flex-1">
          <WorldMap />
        </div>
      ) : tab === 'places' ? (
        <PlacesEditor />
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

/**
 * 地点与路线编辑。
 *
 * ★ 路线天数由系统算（spec P0-13）：写作时引用「走了三天」必须与这里的值一致，
 *   所以 days 只能在这里填写，AI 不得改。
 * ★ 校验交给后端：/api/elements 用 shared 的 locationSchema / routeSchema
 *   解析整个数组，前端只做「别提交空名字」这种即时提示。
 */
function PlacesEditor() {
  const { data: locations } = useLocations()
  const { data: routes } = useRoutes()
  const save = useSaveElement()
  const [locDraft, setLocDraft] = useState<LocationRow[] | null>(null)
  const [routeDraft, setRouteDraft] = useState<RouteRow[] | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const locs = locDraft ?? locations ?? []
  const rts = routeDraft ?? routes ?? []

  const nextId = (rows: { id: string }[], prefix: string): string => {
    const max = rows.reduce((n, r) => {
      const m = new RegExp(`^${prefix}(\\d+)$`).exec(r.id)
      return m === null ? n : Math.max(n, Number(m[1]))
    }, 0)
    return `${prefix}${max + 1}`
  }

  const saveLocations = (): void => {
    if (locDraft === null) return
    if (locDraft.some((l) => l.name.trim() === '')) {
      setMsg('地点名称不能为空')
      return
    }
    save.mutate(
      {
        relPath: 'world/locations.json',
        entityType: 'location',
        entityId: 'locations',
        payload: locDraft,
        reason: '界面编辑地点',
      },
      {
        onSuccess: (r) => {
          setMsg(`地点已保存 · v${r.version}`)
          setLocDraft(null)
        },
        onError: (e) => setMsg(e.message),
      },
    )
  }

  const saveRoutes = (): void => {
    if (routeDraft === null) return
    const bad = routeDraft.find(
      (r) => r.fromId === r.toId || !Number.isInteger(r.days) || r.days <= 0,
    )
    if (bad !== undefined) {
      setMsg('路线：起点与终点不能相同，天数必须是正整数')
      return
    }
    save.mutate(
      {
        relPath: 'world/routes.json',
        entityType: 'route',
        entityId: 'routes',
        payload: routeDraft,
        reason: '界面编辑路线',
      },
      {
        onSuccess: (r) => {
          setMsg(`路线已保存 · v${r.version}`)
          setRouteDraft(null)
        },
        onError: (e) => setMsg(e.message),
      },
    )
  }

  const nameOf = new Map(locs.map((l) => [l.id, l.name]))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        {msg !== null && (
          <p className="rounded border border-neutral-200 bg-white px-3 py-2 text-[11px] text-neutral-600">
            {msg}
          </p>
        )}

        <section className="rounded-lg border border-neutral-200 bg-white">
          <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-2">
            <h2 className="text-sm font-medium text-neutral-800">地点</h2>
            <span className="text-[11px] text-neutral-400">{locs.length} 处</span>
            <button
              type="button"
              onClick={() =>
                setLocDraft([
                  ...locs,
                  {
                    id: nextId(locs, 'l'),
                    name: '',
                    type: 'city',
                    region: '',
                    description: '',
                    x: null,
                    y: null,
                  },
                ])
              }
              className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600"
            >
              ＋ 添加
            </button>
            <button
              type="button"
              onClick={saveLocations}
              disabled={locDraft === null || save.isPending}
              className="ml-auto rounded bg-neutral-900 px-2.5 py-1 text-[11px] text-white disabled:opacity-30"
            >
              保存地点
            </button>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-[10px] text-neutral-400">
                <th className="w-14 px-3 py-1.5">id</th>
                <th className="w-40 px-2 py-1.5">名称</th>
                <th className="w-28 px-2 py-1.5">类型</th>
                <th className="w-28 px-2 py-1.5">地域</th>
                <th className="px-2 py-1.5">说明</th>
              </tr>
            </thead>
            <tbody>
              {locs.map((l, i) => (
                <tr key={l.id} className="border-b border-neutral-50 last:border-0">
                  <td className="px-3 py-1 font-mono text-[10px] text-neutral-400">{l.id}</td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`地点 ${l.id} 名称`}
                      value={l.name}
                      onChange={(e) => {
                        const next = locs.slice()
                        next[i] = { ...l, name: e.target.value }
                        setLocDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1.5 py-0.5"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <select
                      aria-label={`地点 ${l.id} 类型`}
                      value={l.type}
                      onChange={(e) => {
                        const next = locs.slice()
                        next[i] = { ...l, type: e.target.value }
                        setLocDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1 py-0.5"
                    >
                      {LOCATION_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`地点 ${l.id} 地域`}
                      value={l.region ?? ''}
                      onChange={(e) => {
                        const next = locs.slice()
                        next[i] = { ...l, region: e.target.value }
                        setLocDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1.5 py-0.5"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`地点 ${l.id} 说明`}
                      value={l.description ?? ''}
                      onChange={(e) => {
                        const next = locs.slice()
                        next[i] = { ...l, description: e.target.value }
                        setLocDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1.5 py-0.5"
                    />
                  </td>
                </tr>
              ))}
              {locs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-neutral-400">
                    还没有地点
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <section className="rounded-lg border border-neutral-200 bg-white">
          <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-2">
            <h2 className="text-sm font-medium text-neutral-800">路线</h2>
            <span className="text-[11px] text-neutral-400">天数由这里定，写作用它</span>
            <button
              type="button"
              onClick={() => {
                const first = locs[0]?.id ?? 'l1'
                const second = locs[1]?.id ?? first
                setRouteDraft([
                  ...rts,
                  {
                    id: nextId(rts, 'r'),
                    fromId: first,
                    toId: second,
                    mode: 'walk',
                    days: 1,
                    condition: '',
                    bidirectional: true,
                  },
                ])
              }}
              className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-600"
            >
              ＋ 添加
            </button>
            <button
              type="button"
              onClick={saveRoutes}
              disabled={routeDraft === null || save.isPending}
              className="ml-auto rounded bg-neutral-900 px-2.5 py-1 text-[11px] text-white disabled:opacity-30"
            >
              保存路线
            </button>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-[10px] text-neutral-400">
                <th className="w-14 px-3 py-1.5">id</th>
                <th className="w-36 px-2 py-1.5">起点</th>
                <th className="w-36 px-2 py-1.5">终点</th>
                <th className="w-24 px-2 py-1.5">方式</th>
                <th className="w-20 px-2 py-1.5">天数</th>
                <th className="w-20 px-2 py-1.5">双向</th>
                <th className="px-2 py-1.5">通行条件</th>
              </tr>
            </thead>
            <tbody>
              {rts.map((r, i) => (
                <tr key={r.id} className="border-b border-neutral-50 last:border-0">
                  <td className="px-3 py-1 font-mono text-[10px] text-neutral-400">{r.id}</td>
                  <td className="px-2 py-1">
                    <select
                      aria-label={`路线 ${r.id} 起点`}
                      value={r.fromId}
                      onChange={(e) => {
                        const next = rts.slice()
                        next[i] = { ...r, fromId: e.target.value }
                        setRouteDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1 py-0.5"
                    >
                      {locs.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name === '' ? l.id : l.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      aria-label={`路线 ${r.id} 终点`}
                      value={r.toId}
                      onChange={(e) => {
                        const next = rts.slice()
                        next[i] = { ...r, toId: e.target.value }
                        setRouteDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1 py-0.5"
                    >
                      {locs.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name === '' ? l.id : l.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      aria-label={`路线 ${r.id} 方式`}
                      value={r.mode}
                      onChange={(e) => {
                        const next = rts.slice()
                        next[i] = { ...r, mode: e.target.value }
                        setRouteDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1 py-0.5"
                    >
                      {ROUTE_MODES.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`路线 ${r.id} 天数`}
                      type="number"
                      min={1}
                      value={r.days}
                      onChange={(e) => {
                        const next = rts.slice()
                        next[i] = { ...r, days: Number(e.target.value) }
                        setRouteDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1.5 py-0.5"
                    />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input
                      aria-label={`路线 ${r.id} 双向`}
                      type="checkbox"
                      checked={r.bidirectional}
                      onChange={(e) => {
                        const next = rts.slice()
                        next[i] = { ...r, bidirectional: e.target.checked }
                        setRouteDraft(next)
                      }}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      aria-label={`路线 ${r.id} 通行条件`}
                      value={r.condition ?? ''}
                      onChange={(e) => {
                        const next = rts.slice()
                        next[i] = { ...r, condition: e.target.value }
                        setRouteDraft(next)
                      }}
                      className="w-full rounded border border-neutral-300 px-1.5 py-0.5"
                    />
                  </td>
                </tr>
              ))}
              {rts.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-xs text-neutral-400">
                    还没有路线
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="px-4 py-2 text-[10px] text-neutral-400">
            当前：{rts.length} 条路线 · 最长{' '}
            {rts.length === 0 ? 0 : Math.max(...rts.map((r) => r.days))} 天
          </p>
        </section>

        <p className="text-[11px] text-neutral-400">
          保存后写入 world/locations.json 与 world/routes.json；校验由 shared 的 Zod schema 执行
          （方式枚举、天数正整数、id 必填）。
        </p>
      </div>
    </div>
  )
}
