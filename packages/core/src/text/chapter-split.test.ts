import { describe, expect, it } from 'vitest'
import { splitChapters } from './chapter-split.js'

describe('splitChapters', () => {
  it('★ 两个「第X章」切成两章，正文不含标题行', () => {
    const r = splitChapters('第一章 入山\n他上山了。\n\n第二章 守碑\n碑在雾里。')
    expect(r.chapters).toEqual([
      { title: '第一章 入山', body: '他上山了。' },
      { title: '第二章 守碑', body: '碑在雾里。' },
    ])
    expect(r.warnings).toEqual([])
  })

  it('★ 中文数字与阿拉伯数字混用都能切', () => {
    const r = splitChapters('第1章 甲\n正文一\n\n第三章 乙\n正文二')
    expect(r.chapters).toHaveLength(2)
    expect(r.chapters[1]?.title).toBe('第三章 乙')
  })

  it('markdown 井号前缀与 Chapter N 也认', () => {
    const r = splitChapters('# 第1章 甲\n正文\n\n## 第2章 乙\n正文二\n\nChapter 3\nok')
    expect(r.chapters.map((c) => c.title)).toEqual(['第1章 甲', '第2章 乙', 'Chapter 3'])
  })

  it('★ 首个标题之前的内容保留为「前言」并告警（不静默丢字）', () => {
    const r = splitChapters('楔子：风起。\n\n第一章 入山\n他上山了。')
    expect(r.chapters[0]).toEqual({ title: '前言', body: '楔子：风起。' })
    expect(r.chapters[1]?.title).toBe('第一章 入山')
    expect(r.warnings.some((w) => w.includes('前言'))).toBe(true)
  })

  it('★ 一个标题都没有 → 整本一章 + 告警', () => {
    const r = splitChapters('只有正文，没有章节标题。')
    expect(r.chapters).toHaveLength(1)
    expect(r.chapters[0]?.body).toBe('只有正文，没有章节标题。')
    expect(r.warnings.some((w) => w.includes('没有识别到章节标题'))).toBe(true)
  })

  it('CRLF 换行照常处理', () => {
    const r = splitChapters('第一章 甲\r\n正文一\r\n\r\n第二章 乙\r\n正文二')
    expect(r.chapters.map((c) => c.body)).toEqual(['正文一', '正文二'])
  })

  it('空文件 → 0 章 + 告警', () => {
    const r = splitChapters('   \n\n  ')
    expect(r.chapters).toEqual([])
    expect(r.warnings).toContain('源文件为空')
  })

  it('只有标题没有正文的章会被保留并告警', () => {
    const r = splitChapters('第一章 甲\n\n第二章 乙\n正文二')
    expect(r.chapters).toHaveLength(2)
    expect(r.warnings.some((w) => w.includes('只有标题没有正文'))).toBe(true)
  })
})
