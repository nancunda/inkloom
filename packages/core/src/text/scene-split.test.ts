import { describe, expect, it } from 'vitest'
import { splitScenes, toSegments } from './scene-split.js'

describe('splitScenes — 标记切', () => {
  const raw = `===场景1===
林岚踏上山道。

风从袖口灌进来。

===场景2===
剑冢在雾中显现。`

  it('按 ===场景N=== 切分', () => {
    const r = splitScenes(raw)
    expect(r.strategy).toBe('marker')
    expect(r.scenes).toHaveLength(2)
    expect(r.scenes[0]).toContain('林岚踏上山道')
    expect(r.scenes[1]).toContain('剑冢在雾中显现')
  })

  it('★ 标记行本身不出现在正文里', () => {
    const r = splitScenes(raw)
    for (const s of r.scenes) expect(s).not.toContain('===场景')
  })

  it('容忍标记两侧空格与全角数字', () => {
    const r = splitScenes('=== 场景 1 ===\n甲\n\n===场景２===\n乙')
    expect(r.strategy).toBe('marker')
    expect(r.scenes).toHaveLength(2)
  })

  it('模型加了 Markdown 包裹也能切', () => {
    const r = splitScenes('```\n===场景1===\n甲\n```')
    expect(r.strategy).toBe('marker')
    expect(r.scenes[0]).toContain('甲')
  })
})

describe('splitScenes — 降级链', () => {
  it('★ 无标记时按空行+长度启发式切，并记 warning', () => {
    const long = `${'甲'.repeat(400)}\n\n${'乙'.repeat(400)}\n\n${'丙'.repeat(400)}`
    const r = splitScenes(long)
    expect(r.strategy).toBe('heuristic')
    expect(r.scenes.length).toBeGreaterThan(1)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('★ 极短文本整体作为一个场景（不硬切）', () => {
    const r = splitScenes('只有一句话。')
    expect(r.strategy).toBe('whole')
    expect(r.scenes).toHaveLength(1)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('空输入返回空数组 + warning', () => {
    const r = splitScenes('   ')
    expect(r.scenes).toHaveLength(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

describe('splitScenes — 边界', () => {
  it('单场景标记也能处理', () => {
    const r = splitScenes('===场景1===\n甲')
    expect(r.scenes).toHaveLength(1)
  })

  it('标记顺序乱序时不重排（保持模型给的顺序）', () => {
    const r = splitScenes('===场景3===\n甲\n\n===场景1===\n乙')
    expect(r.scenes[0]).toContain('甲')
    expect(r.scenes[1]).toContain('乙')
  })

  it('★ 标记中间有空场景时跳过空块', () => {
    const r = splitScenes('===场景1===\n甲\n\n===场景2===\n\n===场景3===\n乙')
    expect(r.scenes).toHaveLength(2)
    expect(r.scenes[0]).toContain('甲')
    expect(r.scenes[1]).toContain('乙')
  })
})

describe('toSegments', () => {
  it('按空行切段并去空白', () => {
    expect(toSegments('甲\n\n乙\n\n\n丙')).toEqual(['甲', '乙', '丙'])
  })

  it('单行不切', () => {
    expect(toSegments('甲\n乙')).toEqual(['甲\n乙'])
  })

  it('全空白返回空数组', () => {
    expect(toSegments('\n\n  \n')).toEqual([])
  })
})
