/**
 * 阅读位置：按书记住「读到哪一章、第几屏」。
 *
 * ★ 只存整数屏号，不存像素或滚动比例——窗口和字号随时会变，
 *   屏号可以在重排时按比例换算（见 paginate.spreadAfterReflow）。
 * ★ 存储随时可能炸（隐私模式 / 配额满）：读写都吞掉异常，
 *   读不了书的错误是错误，记不住位置的错误不是。
 */

export interface ReadingPosition {
  chapterNo: number
  spread: number
}

/** 只依赖这两个方法，测试可以塞一个 Map 当 storage */
export interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const VERSION = 1

export function readingPositionKey(bookId: string): string {
  return `inkloom.read.${bookId}`
}

export function loadReadingPosition(storage: StorageLike, bookId: string): ReadingPosition | null {
  try {
    const raw = storage.getItem(readingPositionKey(bookId))
    if (raw === null) return null
    const parsed = JSON.parse(raw) as { v?: unknown; chapterNo?: unknown; spread?: unknown }
    if (parsed.v !== VERSION) return null
    const { chapterNo, spread } = parsed
    if (typeof chapterNo !== 'number' || typeof spread !== 'number') return null
    if (!Number.isInteger(chapterNo) || !Number.isInteger(spread)) return null
    if (chapterNo < 1 || spread < 0) return null
    return { chapterNo, spread }
  } catch {
    return null
  }
}

export function saveReadingPosition(
  storage: StorageLike,
  bookId: string,
  position: ReadingPosition,
): void {
  try {
    storage.setItem(readingPositionKey(bookId), JSON.stringify({ v: VERSION, ...position }))
  } catch {
    // 位置记不住不影响阅读
  }
}
