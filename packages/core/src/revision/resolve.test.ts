import { describe, expect, it } from 'vitest'
import { resolveCharacterState, resolveLatest } from './resolve.js'
import type { RevisionRecord } from './types.js'

function rev(
  id: string,
  version: number,
  stateChapter: number | null,
  state: Record<string, unknown>,
): RevisionRecord {
  return {
    id,
    entityType: 'character',
    entityId: 'c1',
    version,
    parentRevisionId: null,
    payload: JSON.stringify({ ...state, ...(stateChapter === null ? {} : { stateChapter }) }),
    changeSource: 'human',
    changeReason: null,
    generationRunId: null,
    createdAt: '2026-10-25T00:00:00.000Z',
  }
}

describe('resolveCharacterState', () => {
  // ★ 关键场景（ADR-13）：人回头看写第 3 章，最新 version 对应的是第 3 章状态，
  //   不能用于第 10 章。必须按 stateChapter 排序。
  const revisions: RevisionRecord[] = [
    rev('r1', 1, 1, { curPhysical: '健康' }),
    rev('r2', 2, 5, { curPhysical: '左臂受伤' }),
    rev('r3', 3, 3, { curPhysical: '中毒' }),
  ]

  it('取 stateChapter <= 目标章中最大的那条（不是 version 最大）', () => {
    const s = resolveCharacterState(revisions, 'c1', 10)
    expect(s?.stateChapter).toBe(5)
    expect(s?.state.curPhysical).toBe('左臂受伤')
    expect(s?.revisionId).toBe('r2')
  })

  it('第 3 章时取第 3 章的版本', () => {
    const s = resolveCharacterState(revisions, 'c1', 3)
    expect(s?.stateChapter).toBe(3)
    expect(s?.state.curPhysical).toBe('中毒')
  })

  it('第 1 章时取第 1 章状态', () => {
    expect(resolveCharacterState(revisions, 'c1', 1)?.stateChapter).toBe(1)
  })

  it('角色尚未入场（所有 stateChapter 都 > 目标章）返回 null', () => {
    const late = [rev('r9', 1, 8, { curPhysical: '健康' })]
    expect(resolveCharacterState(late, 'c1', 3)).toBeNull()
  })

  it('忽略没有 stateChapter 的 revision（静态设定版本）', () => {
    const mixed = [rev('s1', 1, null, { name: '林岚' }), rev('r1', 2, 2, { curPhysical: '受伤' })]
    expect(resolveCharacterState(mixed, 'c1', 5)?.revisionId).toBe('r1')
  })

  it('只看目标角色的 revision', () => {
    const other: RevisionRecord = { ...rev('x1', 4, 9, { curPhysical: '别人' }), entityId: 'c2' }
    const s = resolveCharacterState([...revisions, other], 'c1', 10)
    expect(s?.revisionId).toBe('r2')
  })

  it('stale 透传 payload.stateStale', () => {
    const stale = [rev('r1', 1, 2, { curPhysical: '受伤', stateStale: true })]
    expect(resolveCharacterState(stale, 'c1', 5)?.stale).toBe(true)
  })

  it('stateChapter 相同时取 version 更大的', () => {
    const tie = [rev('a', 1, 2, { curPhysical: 'A' }), rev('b', 2, 2, { curPhysical: 'B' })]
    expect(resolveCharacterState(tie, 'c1', 5)?.revisionId).toBe('b')
  })

  it('空历史返回 null', () => {
    expect(resolveCharacterState([], 'c1', 1)).toBeNull()
  })

  it('payload 是坏 JSON 时跳过该条而不崩', () => {
    const broken: RevisionRecord = { ...rev('bad', 1, 2, {}), payload: '{oops' }
    const good = rev('ok', 2, 1, { curPhysical: '好' })
    expect(resolveCharacterState([broken, good], 'c1', 5)?.revisionId).toBe('ok')
  })
})

describe('resolveLatest', () => {
  it('取该实体 version 最大的一条', () => {
    const rs: RevisionRecord[] = [
      { ...rev('a', 1, 1, { v: 'A' }), entityType: 'blueprint', entityId: 'b1' },
      { ...rev('b', 3, 1, { v: 'C' }), entityType: 'blueprint', entityId: 'b1' },
      { ...rev('c', 2, 1, { v: 'B' }), entityType: 'blueprint', entityId: 'b1' },
    ]
    expect(resolveLatest<{ v: string }>(rs, 'blueprint', 'b1')?.v).toBe('C')
  })

  it('无匹配返回 null', () => {
    expect(resolveLatest([], 'blueprint', 'b1')).toBeNull()
  })
})
