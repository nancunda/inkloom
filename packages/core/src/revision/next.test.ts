import { InkloomError } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import { nextRevision } from './next.js'
import type { RevisionRecord } from './types.js'

const base = {
  entityType: 'character' as const,
  entityId: 'c1',
  id: 'r1',
  payload: { name: '林岚' },
  changeSource: 'human' as const,
  now: '2026-10-25T10:00:00.000Z',
}

describe('nextRevision', () => {
  it('无前序版本时 version=1，parent=null', () => {
    const r = nextRevision({ ...base, prev: null })
    expect(r.version).toBe(1)
    expect(r.parentRevisionId).toBeNull()
  })

  it('有前序版本时 version 递增，parent 指向它', () => {
    const prev: RevisionRecord = nextRevision({ ...base, prev: null })
    const r = nextRevision({ ...base, id: 'r2', prev })
    expect(r.version).toBe(2)
    expect(r.parentRevisionId).toBe('r1')
  })

  it('payload 被序列化为 JSON 字符串', () => {
    const r = nextRevision({ ...base, prev: null })
    expect(JSON.parse(r.payload)).toEqual({ name: '林岚' })
  })

  it('changeReason 未传时为 null（不是 undefined）', () => {
    expect(nextRevision({ ...base, prev: null }).changeReason).toBeNull()
  })

  it('generationRunId 未传时为 null', () => {
    expect(nextRevision({ ...base, prev: null }).generationRunId).toBeNull()
  })

  it('连续三次递增得到 1,2,3', () => {
    const r1 = nextRevision({ ...base, id: 'a', prev: null })
    const r2 = nextRevision({ ...base, id: 'b', prev: r1 })
    const r3 = nextRevision({ ...base, id: 'c', prev: r2 })
    expect([r1.version, r2.version, r3.version]).toEqual([1, 2, 3])
    expect(r3.parentRevisionId).toBe('b')
  })

  it('★ prev 属于别的实体 → 拒绝（不静默串链）', () => {
    const prev = nextRevision({ ...base, prev: null })
    expect(() => nextRevision({ ...base, entityId: 'c2', prev })).toThrowError(InkloomError)
  })

  it('★ prev 的 entityType 不同 → 拒绝', () => {
    const prev = nextRevision({ ...base, prev: null })
    expect(() => nextRevision({ ...base, entityType: 'blueprint', prev })).toThrowError(
      InkloomError,
    )
  })

  it('★ payload 为 undefined → 拒绝（JSON.stringify 会返回 undefined）', () => {
    expect(() => nextRevision({ ...base, prev: null, payload: undefined })).toThrowError(
      InkloomError,
    )
  })
})
