/** 章节状态的显示字典。改一处，三处（列表 / 地图 / 章节头）同时生效 */

export const STATUS_LABEL: Record<string, string> = {
  finalized: '已定稿',
  review: '审阅中',
  drafting: '草稿',
  planned: '计划中',
}

/** 列表左侧的状态符号：一眼扫出哪几章定稿了 */
export const STATUS_MARK: Record<string, string> = {
  finalized: '✓',
  review: '◐',
  drafting: '◑',
  planned: '○',
}
