import { InkloomError } from '@inkloom/shared'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const SEG_ID_LEN = 4
const MAX_ATTEMPTS = 1000

export type RandomSource = () => number

/**
 * 生成段 ID（spec §2.7 一）：4 位 base36，全书唯一且永不复用。
 *
 * 4 位 = 36^4 = 1,679,616 个值。3 位只有 46,656，300 章的书（≈12,000 段）
 * 改稿三次就会耗尽。
 *
 * 随机源注入是为了让测试确定性 —— 生产环境传 Math.random。
 */
export function newSegId(rand: RandomSource, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let id = ''
    for (let i = 0; i < SEG_ID_LEN; i++) {
      const index = Math.floor(rand() * ALPHABET.length)
      id += ALPHABET[Math.min(index, ALPHABET.length - 1)]
    }
    if (!taken.has(id)) return id
  }
  throw new InkloomError('CONFLICT', '段 ID 空间接近耗尽，请检查是否重复使用了同一随机源')
}

/** 汇总一批场景文件里已占用的段 ID */
export function collectSegIds(files: { segments: { segId: string }[] }[]): Set<string> {
  const set = new Set<string>()
  for (const f of files) for (const s of f.segments) set.add(s.segId)
  return set
}
