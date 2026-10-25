import type { InkloomError } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import type { SceneFile } from '../text/markers.js'
import { rollbackSegment } from './segment.js'

const current: SceneFile = {
  sceneNo: 1,
  version: 5,
  segments: [
    { segId: 'aaaa', text: '改过的第一段' },
    { segId: 'bbbb', text: '改过的第二段' },
    { segId: 'cccc', text: '第三段' },
  ],
}

const history: SceneFile = {
  sceneNo: 1,
  version: 2,
  segments: [
    { segId: 'aaaa', text: '原始第一段' },
    { segId: 'bbbb', text: '原始第二段' },
  ],
}

describe('rollbackSegment', () => {
  it('只替换目标段，其余段原样保留', () => {
    const r = rollbackSegment(current, history, 'aaaa')
    expect(r.scene.segments.map((s) => s.text)).toEqual(['原始第一段', '改过的第二段', '第三段'])
  })

  it('返回替换前后的文本，供 UI 展示 diff', () => {
    const r = rollbackSegment(current, history, 'aaaa')
    expect(r.previousText).toBe('改过的第一段')
    expect(r.restoredText).toBe('原始第一段')
  })

  it('段顺序与 segId 不变（身份稳定）', () => {
    const r = rollbackSegment(current, history, 'aaaa')
    expect(r.scene.segments.map((s) => s.segId)).toEqual(['aaaa', 'bbbb', 'cccc'])
  })

  it('历史版本里没有该段 → SEG_NOT_FOUND', () => {
    try {
      rollbackSegment(current, history, 'cccc')
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('SEG_NOT_FOUND')
    }
  })

  it('当前版本里没有该段 → SEG_NOT_FOUND', () => {
    try {
      rollbackSegment(current, history, 'zzzz')
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('SEG_NOT_FOUND')
    }
  })

  it('不修改入参（纯函数）', () => {
    const snapshot = JSON.stringify(current)
    rollbackSegment(current, history, 'aaaa')
    expect(JSON.stringify(current)).toBe(snapshot)
  })

  it('回退到更早的历史版本也成立', () => {
    const older: SceneFile = {
      sceneNo: 1,
      version: 1,
      segments: [{ segId: 'aaaa', text: '最原始' }],
    }
    expect(rollbackSegment(current, older, 'aaaa').restoredText).toBe('最原始')
  })
})
