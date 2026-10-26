import { InkloomError } from '@inkloom/shared'
import { Hono } from 'hono'
import { getContext } from '../services/context.js'
import {
  type Checkpoint,
  createCheckpoint,
  readCheckpoints,
  rollbackToCheckpoint,
} from '../storage/checkpoints.js'
import { reindex } from '../storage/reindex.js'

/**
 * 时间机器（spec §2.7 五 / §4.13 回退入口）。
 *
 * ★ 回退不是「撤销」：文件回到目标点、要素历史截断到同一点，然后**再追加**
 *   一条「回退到…」的检查点——回退本身也留痕，不会被当成没发生过。
 * ★ 回退后必须 reindex：SQLite 是派生层，文件才是真相。跳过重建的话，
 *   界面会继续显示回退前的人物状态与章节列表。
 */
export const checkpoints = new Hono()

function toRow(ck: Checkpoint): Record<string, unknown> {
  return {
    id: ck.id,
    label: ck.label,
    createdAt: ck.createdAt,
    gitRef: ck.gitRef,
    shortRef: ck.gitRef === null ? null : ck.gitRef.slice(0, 7),
    revisions: Object.keys(ck.revisionsOffsets).length,
  }
}

checkpoints.get('/checkpoints', async (c) => {
  const { root } = getContext()
  const all = await readCheckpoints(root)
  // 新的在前：时间机器是「往回走」的，最近的时间点应该先看到
  return c.json({ checkpoints: all.slice().reverse().map(toRow) })
})

checkpoints.post('/checkpoints', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { label?: unknown } | null
  const label = typeof body?.label === 'string' ? body.label.trim() : ''
  if (label === '') throw new InkloomError('INVALID_INPUT', '给这个检查点起个名字（label 必填）')
  const { root } = getContext()
  const ck = await createCheckpoint(root, label)
  return c.json({ ok: true, checkpoint: toRow(ck) })
})

checkpoints.post('/checkpoints/:id/rollback', async (c) => {
  const id = c.req.param('id')
  const { root, db } = getContext()
  const r = await rollbackToCheckpoint(root, id)
  const report = await reindex(root, db)
  return c.json({
    ok: true,
    ...r,
    reindex: {
      characters: report.characters,
      chapters: report.chapters,
      warnings: report.warnings,
    },
  })
})
