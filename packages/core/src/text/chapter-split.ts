export interface ImportedChapter {
  /** 标题行原文（已去掉 markdown 的 # 前缀） */
  title: string
  /** 去掉标题行之后的正文 */
  body: string
}

export interface SplitChaptersResult {
  chapters: ImportedChapter[]
  warnings: string[]
}

/**
 * 章节标题：第X章 / 第X回 / 第X节 / Chapter N，允许 markdown 井号前缀。
 *
 * ★ X 同时接受中文数字与阿拉伯数字：真实稿件里「第一章」和「第1章」
 *   经常混用，只认一种会让半本书切不出来。
 */
const HEADING_RE =
  /^#{0,6}\s*(?:第[零〇一二三四五六七八九十百千两0-9]+[章回节][^\n]*|chapter\s+\d+[^\n]*)$/i

/**
 * 把整本 txt/md 切成章节。
 *
 * 章节号一律按**出现顺序**重排，不沿用原文章号：
 * 原稿可能从第 50 章开始、可能跳号、可能重复，沿用会让后续章节号冲突。
 *
 * 三种降级都在 warnings 里说清楚，不静默丢内容：
 * - 第一个标题之前有内容 → 作为「前言」保留为第 1 章
 * - 一个标题都没识别到 → 整本作为一章
 * - 只有标题没有正文 → 保留空章并告警（用户可自行处理）
 */
export function splitChapters(raw: string): SplitChaptersResult {
  const warnings: string[] = []
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text.length === 0) return { chapters: [], warnings: ['源文件为空'] }

  const chapters: ImportedChapter[] = []
  const preface: string[] = []
  let sawHeading = false
  let title: string | null = null
  let bodyLines: string[] = []

  const flush = (): void => {
    if (title !== null) chapters.push({ title, body: bodyLines.join('\n').trim() })
    title = null
    bodyLines = []
  }

  for (const line of text.split('\n')) {
    if (HEADING_RE.test(line.trim())) {
      sawHeading = true
      flush()
      title = line.trim().replace(/^#+\s*/, '')
    } else if (title === null) {
      preface.push(line)
    } else {
      bodyLines.push(line)
    }
  }
  flush()

  // 一个标题都没识别到：整本作为一章，不再拿「前言」去套
  if (!sawHeading) {
    warnings.push('没有识别到章节标题（第X章 / Chapter N），整本作为一章导入')
    return { chapters: [{ title: '第 1 章', body: text }], warnings }
  }

  const prefaceText = preface.join('\n').trim()
  if (prefaceText.length > 0) {
    warnings.push('第一个章节标题之前有内容，已作为「前言」保留为第 1 章')
    chapters.unshift({ title: '前言', body: prefaceText })
  }

  const empty = chapters.filter((c) => c.body.length === 0).length
  if (empty > 0) warnings.push(`有 ${empty} 章只有标题没有正文`)
  return { chapters, warnings }
}
