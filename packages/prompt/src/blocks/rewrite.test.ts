import { describe, expect, it } from 'vitest'
import { buildRewriteMessages } from './rewrite.js'

const base = {
  chapterNo: 4,
  sceneNo: 1,
  sceneGoal: '走到碑前',
  conflict: '裴无咎阻拦',
  hook: '碑上的名字是她自己',
  prevText: '雾从山坳里漫上来。',
  nextText: '碑面冰凉。',
  original: '剑气贴着面颊削过去。',
  guidance: null,
}

describe('buildRewriteMessages', () => {
  it('★ system 明确禁止写场景头 / 段标记 / 解释', () => {
    const [sys] = buildRewriteMessages(base)
    expect(sys?.role).toBe('system')
    expect(sys?.content).toContain('只输出这一段')
    expect(sys?.content).toContain('不要输出场景标题')
    expect(sys?.content).toContain('不要输出任何解释')
  })

  it('★ 上下文齐全：前后段与蓝图三要素都进 user', () => {
    const [, user] = buildRewriteMessages(base)
    expect(user?.content).toContain('雾从山坳里漫上来。')
    expect(user?.content).toContain('碑面冰凉。')
    expect(user?.content).toContain('走到碑前')
    expect(user?.content).toContain('裴无咎阻拦')
    expect(user?.content).toContain('碑上的名字是她自己')
  })

  it('★ 原文用定界符包住，避免和前后段混成一片', () => {
    const [, user] = buildRewriteMessages(base)
    expect(user?.content).toMatch(/<<<原文[\s\S]*剑气贴着面颊削过去。[\s\S]*原文>>>/)
  })

  it('有指令时单独一行；没有指令时不出现「用户要求」', () => {
    const withGuidance = buildRewriteMessages({ ...base, guidance: '让林岚少说话' })[1]
    expect(withGuidance?.content).toContain('让林岚少说话')

    const without = buildRewriteMessages(base)[1]
    expect(without?.content).not.toContain('用户要求')
  })

  it('只有一段（无前后段）时不漏出 undefined / null 字样', () => {
    const [, user] = buildRewriteMessages({ ...base, prevText: null, nextText: null })
    expect(user?.content).not.toContain('undefined')
    expect(user?.content).not.toContain('null')
  })

  it('空白指令等同没有指令', () => {
    const [, user] = buildRewriteMessages({ ...base, guidance: '   ' })
    expect(user?.content).not.toContain('用户要求')
  })
})
