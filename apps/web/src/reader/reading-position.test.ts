import { describe, expect, it } from 'vitest'
import {
  loadReadingPosition,
  type ReadingPosition,
  readingPositionKey,
  type StorageLike,
  saveReadingPosition,
} from './reading-position'

function fakeStorage(initial: Record<string, string> = {}): StorageLike & {
  data: Map<string, string>
} {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
  }
}

describe('readingPositionKey', () => {
  it('按书隔离', () => {
    expect(readingPositionKey('qixia')).toBe('inkloom.read.qixia')
    expect(readingPositionKey('chaogu')).not.toBe(readingPositionKey('qixia'))
  })
})

describe('loadReadingPosition', () => {
  it('存进去能原样读回来', () => {
    const storage = fakeStorage()
    saveReadingPosition(storage, 'qixia', { chapterNo: 3, spread: 2 })
    expect(loadReadingPosition(storage, 'qixia')).toEqual({ chapterNo: 3, spread: 2 })
  })

  it('没存过返回 null', () => {
    expect(loadReadingPosition(fakeStorage(), 'qixia')).toBeNull()
  })

  it('坏 JSON / 版本不符 / 字段缺失都返回 null', () => {
    const key = readingPositionKey('qixia')
    expect(loadReadingPosition(fakeStorage({ [key]: 'not json' }), 'qixia')).toBeNull()
    expect(
      loadReadingPosition(
        fakeStorage({ [key]: JSON.stringify({ v: 2, chapterNo: 1, spread: 0 }) }),
        'qixia',
      ),
    ).toBeNull()
    expect(
      loadReadingPosition(fakeStorage({ [key]: JSON.stringify({ v: 1 }) }), 'qixia'),
    ).toBeNull()
  })

  it('非法值返回 null（章号 < 1、屏号为负、不是整数、NaN）', () => {
    const key = readingPositionKey('qixia')
    const put = (value: unknown) => fakeStorage({ [key]: JSON.stringify(value) })
    expect(loadReadingPosition(put({ v: 1, chapterNo: 0, spread: 0 }), 'qixia')).toBeNull()
    expect(loadReadingPosition(put({ v: 1, chapterNo: 1, spread: -1 }), 'qixia')).toBeNull()
    expect(loadReadingPosition(put({ v: 1, chapterNo: 1.5, spread: 0 }), 'qixia')).toBeNull()
    expect(loadReadingPosition(put({ v: 1, chapterNo: 1, spread: 2.5 }), 'qixia')).toBeNull()
  })

  it('存储读取出错时不抛（隐私模式下 getItem 可能直接炸）', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => undefined,
    }
    expect(loadReadingPosition(storage, 'qixia')).toBeNull()
  })
})

describe('saveReadingPosition', () => {
  it('写入失败静默——读不了书也不能因为存位置失败而报错', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const pos: ReadingPosition = { chapterNo: 1, spread: 0 }
    expect(() => saveReadingPosition(storage, 'qixia', pos)).not.toThrow()
  })
})
