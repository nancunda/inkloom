import { describe, expect, it } from 'vitest'
import { sanitizeRewrittenSegment } from './rewrite.js'

/** 26 字：比例校验的基准 */
const LONG = '剑气贴着面颊削过去。林岚左臂裂开一道口子，血顺着指缝滴落。'
/** 7 字：清洗类用例的基准（清洗本身不该被比例校验挡掉） */
const SHORT = '剑气贴着面颊。'

describe('sanitizeRewrittenSegment', () => {
  it('★ 去掉模型爱包的整段中文引号', () => {
    expect(sanitizeRewrittenSegment('“剑气擦过面颊。”', SHORT)).toEqual({
      ok: true,
      text: '剑气擦过面颊。',
    })
  })

  it('★ 去掉 ``` 代码围栏', () => {
    expect(sanitizeRewrittenSegment('```\n剑气擦过面颊。\n```', SHORT)).toEqual({
      ok: true,
      text: '剑气擦过面颊。',
    })
  })

  it('★ 套了两层引号也能剥干净', () => {
    expect(sanitizeRewrittenSegment('「“剑气擦过面颊。”」', SHORT)).toEqual({
      ok: true,
      text: '剑气擦过面颊。',
    })
  })

  it('空串与纯空白 → empty', () => {
    expect(sanitizeRewrittenSegment('   \n\n', SHORT)).toEqual({ ok: false, reason: 'empty' })
  })

  it('★ 只剩标点 → empty（按 countWords 口径）', () => {
    expect(sanitizeRewrittenSegment('——！？……', SHORT)).toEqual({ ok: false, reason: 'empty' })
  })

  it('★ 短于原文 40% → too_short', () => {
    // 原文 26 字，40% = 10.4；这里 8 字
    expect(sanitizeRewrittenSegment('剑气掠过。林岚倒地。', LONG)).toEqual({
      ok: false,
      reason: 'too_short',
    })
  })

  it('★ 长于原文 300% → too_long', () => {
    const long = '剑气贴着面颊削过去，'.repeat(12)
    expect(sanitizeRewrittenSegment(long, LONG)).toEqual({ ok: false, reason: 'too_long' })
  })

  it('比例边界内（正好 40%）算通过', () => {
    // 原文 10 字，40% = 4；这里 4 字
    expect(sanitizeRewrittenSegment('剑气掠过。', '剑气贴着面颊削过去。')).toEqual({
      ok: true,
      text: '剑气掠过。',
    })
  })

  it('原文为空时不做比例校验，只查空与标记', () => {
    expect(sanitizeRewrittenSegment('新的句子。', '')).toEqual({ ok: true, text: '新的句子。' })
  })

  it('★ 残留 seg 标记 → has_marker（不悄悄删掉）', () => {
    expect(sanitizeRewrittenSegment('句子<!-- seg:zzzz -->接上', SHORT)).toEqual({
      ok: false,
      reason: 'has_marker',
    })
  })
})
