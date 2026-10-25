import { InkloomError } from '@inkloom/shared'

export interface SceneSegment {
  segId: string
  text: string
}

export interface SceneFile {
  sceneNo: number
  version: number
  segments: SceneSegment[]
}

export interface ChapterScene {
  sceneNo: number
  text: string
}

export interface ChapterFile {
  title: string
  scenes: ChapterScene[]
}

const SCENE_HEADER_RE = /^<!--\s*scene:(\d+)\s+v:(\d+)\s*-->\s*$/
const SEG_MARKER_RE = /^<!--\s*seg:([0-9a-z]{4})\s*-->\s*$/
const CHAPTER_SCENE_RE = /^<!--\s*scene:(\d+)\s*-->\s*$/
const CHAPTER_TITLE_RE = /^#\s+(.+?)\s*$/

/** 按空行切分段落，丢弃空段（§2.7 六：段内容边界以空行为界） */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/**
 * 解析候选稿场景文件（§2.7 一）。
 * 格式：首行场景头，随后若干 (段标记 + 段文本) 组。
 * 违规一律抛 INVALID_INPUT —— 宁可拒绝，也不要静默产出错段。
 */
export function parseSceneFile(raw: string): SceneFile {
  const lines = raw.split(/\r?\n/)
  const firstLine = lines[0] ?? ''
  const header = SCENE_HEADER_RE.exec(firstLine)
  if (!header) {
    throw new InkloomError('INVALID_INPUT', `场景文件缺少合法场景头: ${firstLine.slice(0, 60)}`)
  }
  const sceneNo = Number(header[1])
  const version = Number(header[2])

  const segments: SceneSegment[] = []
  const seen = new Set<string>()
  let currentId: string | null = null
  let buffer: string[] = []

  const flush = (): void => {
    if (currentId === null) return
    const text = buffer.join('\n').trim()
    if (text.length > 0) segments.push({ segId: currentId, text })
    buffer = []
  }

  for (const line of lines.slice(1)) {
    const m = SEG_MARKER_RE.exec(line)
    if (m) {
      flush()
      const segId = m[1] as string
      if (seen.has(segId)) {
        throw new InkloomError('INVALID_INPUT', `段 ID 重复: ${segId}`)
      }
      seen.add(segId)
      currentId = segId
      continue
    }
    if (currentId !== null) buffer.push(line)
  }
  flush()

  return { sceneNo, version, segments }
}

/** 序列化候选稿场景文件（§2.7 一），与 parseSceneFile 严格互逆 */
export function serializeSceneFile(scene: SceneFile): string {
  const header = `<!-- scene:${scene.sceneNo} v:${scene.version} -->`
  const blocks = scene.segments.map((s) => `<!-- seg:${s.segId} -->\n${s.text.trim()}`)
  return blocks.length === 0 ? `${header}\n` : `${header}\n${blocks.join('\n\n')}\n`
}

/** 解析定稿章文件（§2.7 二）：一级标题 + 若干 (场景边界 + 正文) */
export function parseChapterFile(raw: string): ChapterFile {
  const lines = raw.split(/\r?\n/)
  let title: string | null = null
  const scenes: ChapterScene[] = []
  let currentScene: number | null = null
  let buffer: string[] = []

  const flush = (): void => {
    if (currentScene === null) return
    scenes.push({ sceneNo: currentScene, text: buffer.join('\n').trim() })
    buffer = []
  }

  for (const line of lines) {
    if (title === null) {
      const t = CHAPTER_TITLE_RE.exec(line)
      if (t) {
        title = (t[1] as string).trim()
        continue
      }
      if (line.trim().length > 0) {
        throw new InkloomError('INVALID_INPUT', '定稿文件首个非空行必须是一级标题')
      }
      continue
    }
    const m = CHAPTER_SCENE_RE.exec(line)
    if (m) {
      flush()
      currentScene = Number(m[1])
      continue
    }
    if (currentScene !== null) buffer.push(line)
  }
  flush()

  if (title === null) {
    throw new InkloomError('INVALID_INPUT', '定稿文件缺少一级标题')
  }
  return { title, scenes }
}

/** 序列化定稿章文件（§2.7 二） */
export function serializeChapterFile(chapter: ChapterFile): string {
  const lines: string[] = [`# ${chapter.title}`]
  for (const s of chapter.scenes) {
    lines.push('', `<!-- scene:${s.sceneNo} -->`, s.text.trim())
  }
  return `${lines.join('\n')}\n`
}
