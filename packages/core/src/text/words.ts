const MARKER_RE = /<!--[\s\S]*?-->/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
const LATIN_RE = /[A-Za-z]/g
const DIGIT_RE = /[0-9]/g

/**
 * 字数口径（spec §2.7 六）：
 *   汉字 + 英文**字母** + 数字，各计 1；忽略标记、空白、标点。
 *
 * 说明：英文按字母而非单词计，是 spec 的字面约定。
 * 若将来发现英文占比高的书统计偏大，改口径必须同步修改 spec §2.7 六，
 * 不允许只改代码。
 */
export function countWords(text: string): number {
  const stripped = text.replace(MARKER_RE, '')
  const cjk = stripped.match(CJK_RE)?.length ?? 0
  const latin = stripped.match(LATIN_RE)?.length ?? 0
  const digits = stripped.match(DIGIT_RE)?.length ?? 0
  return cjk + latin + digits
}
