export type SplitStrategy = 'marker' | 'heuristic' | 'whole'

export interface SplitResult {
  scenes: string[]
  strategy: SplitStrategy
  warnings: string[]
}

/** 每个场景的目标字数（启发式切分用；达到此值就断开） */
const TARGET_SCENE_CHARS = 400

/** 容忍 `===场景1===` / `=== 场景 1 ===` / 全角数字 */
const MARKER_RE = /^[ \t]*={2,}[ \t]*场景[ \t]*([0-9０-９]+)[ \t]*={2,}[ \t]*$/gm
const FENCE_RE = /^```[a-z]*\s*$/gm

/**
 * 场景切分（spec §4.6）。
 *
 * 降级链：标记切 → 空行+长度启发式 → 整章单场景。
 * 每一级降级都记 warning，事后能看出「模型没听话」。
 *
 * ★ 为什么不用 JSON 解析：中文长文本经 JSON 转义后语感显著下降，
 *   而且模型会在字符串里塞 \n 转义，下游还得反转义。
 */
export function splitScenes(raw: string): SplitResult {
  const warnings: string[] = []
  // 去掉模型可能加的代码块围栏
  const text = raw.replace(FENCE_RE, '').trim()

  if (text.length === 0) {
    return { scenes: [], strategy: 'whole', warnings: ['模型输出为空'] }
  }

  const markers = [...text.matchAll(MARKER_RE)]
  if (markers.length > 0) {
    const scenes: string[] = []
    for (let i = 0; i < markers.length; i++) {
      const start = (markers[i]?.index ?? 0) + (markers[i]?.[0].length ?? 0)
      const end = i + 1 < markers.length ? (markers[i + 1]?.index ?? text.length) : text.length
      const body = text.slice(start, end).trim()
      if (body.length > 0) scenes.push(body)
    }
    if (scenes.length > 0) return { scenes, strategy: 'marker', warnings }
    warnings.push('检测到场景标记但场景内容全为空')
  }

  // 降级 1：空行切分 + 长度合并
  const paragraphs = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  if (paragraphs.length === 0) {
    return { scenes: [], strategy: 'whole', warnings: [...warnings, '模型输出只有空白'] }
  }

  // 极短文本不硬切
  if (text.length < TARGET_SCENE_CHARS) {
    warnings.push(`未找到场景标记，且正文仅 ${text.length} 字，整章作为单场景处理`)
    return { scenes: [text], strategy: 'whole', warnings }
  }

  const scenes: string[] = []
  let buffer: string[] = []
  let bufferChars = 0
  for (const p of paragraphs) {
    buffer.push(p)
    bufferChars += p.length
    if (bufferChars >= TARGET_SCENE_CHARS) {
      scenes.push(buffer.join('\n\n'))
      buffer = []
      bufferChars = 0
    }
  }
  if (buffer.length > 0) {
    if (scenes.length === 0) scenes.push(buffer.join('\n\n'))
    else scenes[scenes.length - 1] = `${scenes[scenes.length - 1]}\n\n${buffer.join('\n\n')}`
  }

  warnings.push(`未找到 ===场景N=== 标记，按空行+长度启发式切分为 ${scenes.length} 个场景`)
  return { scenes, strategy: 'heuristic', warnings }
}

/** 单场景正文 → 段数组（按空行切，与 markers.ts 的 splitParagraphs 同语义） */
export function toSegments(sceneText: string): string[] {
  return sceneText
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}
