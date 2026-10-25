import { createHash } from 'node:crypto'
import type { Blueprint } from '@inkloom/shared'
import { getContext } from '../services/context.js'

/**
 * 从蓝图四要素拼装 C3 层摘要（Ruling 37）。
 *
 * ★ 为什么不用 LLM 概括：spec §4.4 的核心决策是「用结构化数据替代文本摘要」。
 *   LLM 概括会漏要点、会编情节，而蓝图是作者自己写的，逐字可靠。
 * ★ 代价：摘要只有 50–80 字而不是 200 字。但 U4 块的作用是「提醒前面发生了什么」，
 *   蓝图要点比 LLM 概括更准。
 */
export function buildSummaryFromBlueprint(bp: Blueprint): string {
  const parts: string[] = [bp.goal, `冲突：${bp.conflict}`]
  if (bp.turn !== undefined && bp.turn.length > 0) parts.push(`转折：${bp.turn}`)
  parts.push(`钩子：${bp.hook}`)
  return parts.join('；')
}

/**
 * 写 Chapter.summary。
 *
 * summaryHash 用于判断「正文改了但摘要没更新」——定稿时重算，两者总是同步，
 * 但人可能手改正文文件，那时 hash 会不匹配，`summaryStale` 由后续校验置位。
 */
export async function upsertChapterSummary(chapterNo: number, summary: string): Promise<void> {
  const { db, project } = getContext()
  const summaryHash = createHash('sha256').update(summary).digest('hex').slice(0, 16)
  await db.chapter.upsert({
    where: { projectId_chapterNo: { projectId: project.id, chapterNo } },
    create: {
      id: `ch_${project.id}_${chapterNo}`,
      projectId: project.id,
      chapterNo,
      status: 'drafting',
      summary,
      summaryHash,
      summaryStale: false,
    },
    update: { summary, summaryHash, summaryStale: false },
  })
}
