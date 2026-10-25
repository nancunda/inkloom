import { InkloomError } from '@inkloom/shared'
import type { SceneFile } from '../text/markers.js'

export interface SegmentRollbackResult {
  scene: SceneFile
  previousText: string
  restoredText: string
}

/**
 * 单段回退（spec §2.7 四）。
 *
 * 语义：从历史版本里取出 segId 对应段的内容，替换当前版本里同名段的内容。
 * 其余段、段顺序、段 ID 一律不动。
 *
 * ★ 纯函数，不产生新版本号。调用方负责：
 *   1. 用返回的 scene 序列化，写成 v{latest+1}.md（**不覆盖旧版本**）
 *   2. 更新索引里的 contentHash
 *   3. 记一条 changeSource='rollback'（若回退的是要素）或 git commit（若回退的是正文）
 *
 * 边界：目标段在任一侧不存在 → SEG_NOT_FOUND。
 * 不支持的场景（YAGNI）：恢复已删除的段（这是插入，不是回退）。
 */
export function rollbackSegment(
  current: SceneFile,
  history: SceneFile,
  segId: string,
): SegmentRollbackResult {
  const currentSeg = current.segments.find((s) => s.segId === segId)
  const historySeg = history.segments.find((s) => s.segId === segId)

  if (currentSeg === undefined) {
    throw new InkloomError('SEG_NOT_FOUND', `当前版本（v${current.version}）中不存在段 ${segId}`)
  }
  if (historySeg === undefined) {
    throw new InkloomError('SEG_NOT_FOUND', `历史版本（v${history.version}）中不存在段 ${segId}`)
  }

  return {
    scene: {
      sceneNo: current.sceneNo,
      version: current.version,
      segments: current.segments.map((s) =>
        s.segId === segId ? { ...s, text: historySeg.text } : s,
      ),
    },
    previousText: currentSeg.text,
    restoredText: historySeg.text,
  }
}
