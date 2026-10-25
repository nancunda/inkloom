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
const SEG_ID_RE = /^[0-9a-z]{4}$/
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
 *
 * 严格策略：格式不合契约一律抛 INVALID_INPUT，绝不静默丢数据。
 * 特别是「首段标记之前的正文」——静默丢弃等于用户加一句场景备注就丢内容，
 * 而 P0-17 明确鼓励用户直接打开 .md 编辑。
 *
 * ★ 空文本段会被保留（`text: ''`）而不是丢弃：
 *   丢弃会让该 segId 从活文件里消失，进而被 newSegId 重新分配，
 *   单段回退时就会把"另一段"的历史文本回退进来。删除段必须是显式操作。
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
    segments.push({ segId: currentId, text: buffer.join('\n').trim() })
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
    if (currentId === null) {
      // 场景头之后、首个段标记之前的非空内容：拒绝，不静默丢
      if (line.trim().length > 0) {
        throw new InkloomError(
          'INVALID_INPUT',
          `场景头与首个段标记之间存在游离正文（第 ${sceneNo} 场）：${line.trim().slice(0, 40)}`,
        )
      }
      continue
    }
    buffer.push(line)
  }
  flush()

  return { sceneNo, version, segments }
}

/**
 * 序列化候选稿场景文件（§2.7 一），与 parseSceneFile 严格互逆。
 *
 * ★ 写入前必须校验：解析端严格、写入端放任，会造成"写出去的文件读不回来"，
 *   而文件是唯一事实源 —— 这是静默数据损坏。
 *   两类必须拦下的输入：
 *     1) 非法 segId（非 4 位小写 base36）→ 写出的标记不被识别，两段被合并
 *     2) 段文本里含段标记行 → 读取时被当成真标记，一段裂成两段并伪造 segId
 */
export function serializeSceneFile(scene: SceneFile): string {
  for (const seg of scene.segments) {
    if (!SEG_ID_RE.test(seg.segId)) {
      throw new InkloomError('INVALID_INPUT', `非法段 ID（须 4 位小写 base36）: ${seg.segId}`)
    }
    if (seg.text.split(/\r?\n/).some((line) => SEG_MARKER_RE.test(line))) {
      throw new InkloomError('INVALID_INPUT', `段 ${seg.segId} 的正文含段标记行，会破坏文件结构`)
    }
  }

  const header = `<!-- scene:${scene.sceneNo} v:${scene.version} -->`
  const blocks = scene.segments.map((s) => `<!-- seg:${s.segId} -->\n${s.text.trim()}`)
  return blocks.length === 0 ? `${header}\n` : `${header}\n${blocks.join('\n\n')}\n`
}

/**
 * 解析定稿章文件（§2.7 二）：一级标题 + 若干 (场景边界 + 正文)。
 *
 * 严格策略：
 *   - 缺一级标题 → 抛错
 *   - 场景号重复 → 抛错（反解时两个场景会写到同一路径，后者覆盖前者 = 正文丢失）
 *   - 出现段标记 → 抛错（定稿文件不该有，出现说明格式被污染）
 */
export function parseChapterFile(raw: string): ChapterFile {
  const lines = raw.split(/\r?\n/)
  let title: string | null = null
  const scenes: ChapterScene[] = []
  const seenSceneNos = new Set<number>()
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

    if (SEG_MARKER_RE.test(line)) {
      throw new InkloomError('INVALID_INPUT', '定稿文件不应包含段标记（<!-- seg:… -->）')
    }

    const m = CHAPTER_SCENE_RE.exec(line)
    if (m) {
      flush()
      const sceneNo = Number(m[1])
      if (seenSceneNos.has(sceneNo)) {
        throw new InkloomError('INVALID_INPUT', `定稿文件中场景号重复: ${sceneNo}`)
      }
      seenSceneNos.add(sceneNo)
      currentScene = sceneNo
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

/** 序列化定稿章文件（§2.7 二）：只保留场景边界，不写段标记 */
export function serializeChapterFile(chapter: ChapterFile): string {
  const lines: string[] = [`# ${chapter.title}`]
  for (const s of chapter.scenes) {
    lines.push('', `<!-- scene:${s.sceneNo} -->`, s.text.trim())
  }
  return `${lines.join('\n')}\n`
}
