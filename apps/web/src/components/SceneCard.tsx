import type { SceneRow } from '../api/types'

const BADGE: Record<SceneRow['status'], { label: string; cls: string }> = {
  candidate: { label: '待确认', cls: 'bg-neutral-100 text-neutral-600' },
  accepted: { label: '已接受', cls: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: '已拒绝', cls: 'bg-rose-50 text-rose-700' },
}

interface Props {
  /** 该场景的全部版本（version 降序） */
  versions: SceneRow[]
  /** 当前正在查看/操作的版本 */
  row: SceneRow
  /** 本场景里比 row 更早、且**实际存在**的最高版本号；null = 没有可对比的 */
  prevVersion: number | null
  selected: boolean
  busy: boolean
  onViewVersion: (version: number) => void
  onToggleSelect: () => void
  onAccept: () => void
  onReject: () => void
  onDiff: () => void
  /** 整场重写：产生新版本（与段级「重写这段」不同） */
  onRewriteFull?: (() => void) | undefined
}

/**
 * 场景卡片。
 *
 * ★ 卡片操作的是「当前查看的版本」，不是「最新版本」：
 *   用户经常需要回到 v1 去比较、去接受。只允许操作最新版会逼人反复 regenerate。
 * ★ 每个按钮的可用性都由状态推出，且 disabled 时用 title 说明原因：
 *   用户不应该猜「为什么这个按钮点不了」。
 * ★ diff 的「上一版」必须取自真实存在的版本号，不能用 version - 1：
 *   版本号会跳号（v1 被清理后只剩 v2 / v3），减一算出来的版本根本不存在。
 */
export function SceneCard({
  versions,
  row,
  prevVersion,
  selected,
  busy,
  onViewVersion,
  onToggleSelect,
  onAccept,
  onReject,
  onDiff,
  onRewriteFull,
}: Props) {
  const badge = BADGE[row.status]
  const isAccepted = row.status === 'accepted'
  const isNewest = row.version === versions[0]?.version
  const canDiff = prevVersion !== null

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        selected ? 'border-neutral-900 bg-white' : 'border-neutral-200 bg-white'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToggleSelect}
          className="text-sm font-medium text-neutral-900 hover:underline"
        >
          场景 {row.sceneNo}
        </button>
        {/* 版本切换：一眼看出这个场景总共有几版、当前在看哪版 */}
        {versions.length > 1 ? (
          <span className="flex items-center gap-1">
            {versions.map((v) => (
              <button
                key={v.version}
                type="button"
                onClick={() => onViewVersion(v.version)}
                title={`查看 v${v.version}（${BADGE[v.status].label}）`}
                className={`rounded px-1.5 py-0.5 text-xs ${
                  v.version === row.version
                    ? 'bg-neutral-900 text-white'
                    : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                }`}
              >
                v{v.version}
              </button>
            ))}
          </span>
        ) : (
          <span className="text-xs text-neutral-400">v{row.version}</span>
        )}
        <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.label}</span>
        {!isNewest && <span className="text-xs text-neutral-400">（非最新）</span>}
        <span className="ml-auto text-xs text-neutral-400">
          {row.wordCount} 字 / {row.segCount} 段
        </span>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy || isAccepted}
          onClick={onAccept}
          title={isAccepted ? '已经是当前接受的版本' : '接受这一版（同场景其他版本会自动拒绝）'}
          className="rounded bg-emerald-600 px-2.5 py-1 text-xs text-white disabled:cursor-not-allowed disabled:bg-neutral-200 disabled:text-neutral-400"
        >
          接受 v{row.version}
        </button>
        <button
          type="button"
          disabled={busy || row.status === 'rejected'}
          onClick={onReject}
          title={row.status === 'rejected' ? '已经是拒绝状态' : '拒绝（文件保留，可再接受）'}
          className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-300"
        >
          拒绝
        </button>
        <button
          type="button"
          disabled={busy || isAccepted || onRewriteFull === undefined}
          onClick={onRewriteFull}
          title={
            isAccepted
              ? '已经是接受的版本；要重写先换一版或撤销接受'
              : '整场重写：生成新版本（R 键）'
          }
          className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-300"
        >
          ↻ 重写整场
        </button>
        <button
          type="button"
          disabled={!canDiff}
          onClick={onDiff}
          title={canDiff ? `与 v${prevVersion} 对比` : '只有这一版，没有可对比的对象'}
          className="rounded border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 disabled:cursor-not-allowed disabled:border-neutral-200 disabled:text-neutral-300"
        >
          看 diff
        </button>
      </div>
    </div>
  )
}
