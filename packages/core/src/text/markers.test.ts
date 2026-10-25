import { InkloomError } from '@inkloom/shared'
import { describe, expect, it } from 'vitest'
import {
  parseChapterFile,
  parseSceneFile,
  serializeChapterFile,
  serializeSceneFile,
  splitParagraphs,
} from './markers.js'

const SAMPLE_SCENE = `<!-- scene:1 v:3 -->
<!-- seg:a3f7 -->
林岚踏上山道，风从袖口灌进来。

<!-- seg:b71c -->
她按住腰间玉牌，指节泛白。

<!-- seg:c028 -->
“再往上，就是剑冢了。”老仆的声音从身后传来。
`

describe('parseSceneFile', () => {
  it('解析场景头与三段', () => {
    const s = parseSceneFile(SAMPLE_SCENE)
    expect(s.sceneNo).toBe(1)
    expect(s.version).toBe(3)
    expect(s.segments).toHaveLength(3)
    expect(s.segments[0]?.segId).toBe('a3f7')
    expect(s.segments[1]?.text).toBe('她按住腰间玉牌，指节泛白。')
  })

  it('段文本首尾空白被去除', () => {
    const s = parseSceneFile(SAMPLE_SCENE)
    for (const seg of s.segments) {
      expect(seg.text).toBe(seg.text.trim())
    }
  })

  it('缺场景头抛 INVALID_INPUT', () => {
    expect(() => parseSceneFile('<!-- seg:a3f7 -->\n文本')).toThrowError(InkloomError)
    try {
      parseSceneFile('<!-- seg:a3f7 -->\n文本')
    } catch (e) {
      expect((e as InkloomError).code).toBe('INVALID_INPUT')
    }
  })

  it('段标记重复抛 INVALID_INPUT', () => {
    const dup = '<!-- scene:1 v:1 -->\n<!-- seg:aaaa -->\nA\n\n<!-- seg:aaaa -->\nB\n'
    try {
      parseSceneFile(dup)
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('INVALID_INPUT')
    }
  })

  it('空段被丢弃（不产生空 segId 段）', () => {
    const withEmpty = '<!-- scene:1 v:1 -->\n<!-- seg:aaaa -->\n\n<!-- seg:bbbb -->\nB\n'
    expect(parseSceneFile(withEmpty).segments).toHaveLength(1)
  })
})

describe('serializeSceneFile', () => {
  it('往返一致（parse → serialize → parse 结构等价）', () => {
    const a = parseSceneFile(SAMPLE_SCENE)
    const b = parseSceneFile(serializeSceneFile(a))
    expect(b).toEqual(a)
  })

  it('序列化结果符合 §2.7 格式（段间空行分隔，首段前不空行）', () => {
    const out = serializeSceneFile({
      sceneNo: 2,
      version: 1,
      segments: [
        { segId: 'x001', text: '甲' },
        { segId: 'x002', text: '乙' },
      ],
    })
    expect(out).toBe('<!-- scene:2 v:1 -->\n<!-- seg:x001 -->\n甲\n\n<!-- seg:x002 -->\n乙\n')
  })

  it('空场景（无段）也能序列化', () => {
    const out = serializeSceneFile({ sceneNo: 1, version: 1, segments: [] })
    expect(out).toBe('<!-- scene:1 v:1 -->\n')
    expect(parseSceneFile(out).segments).toHaveLength(0)
  })
})

describe('parseChapterFile', () => {
  const SAMPLE_CHAPTER = `# 第四章 剑冢

<!-- scene:1 -->
林岚踏上山道。

她按住玉牌。

<!-- scene:2 -->
剑冢在雾中显现。
`

  it('解析标题与两个场景', () => {
    const c = parseChapterFile(SAMPLE_CHAPTER)
    expect(c.title).toBe('第四章 剑冢')
    expect(c.scenes).toHaveLength(2)
    expect(c.scenes[1]?.sceneNo).toBe(2)
    expect(c.scenes[1]?.text).toBe('剑冢在雾中显现。')
  })

  it('场景内多段保留软换行', () => {
    expect(parseChapterFile(SAMPLE_CHAPTER).scenes[0]?.text).toBe('林岚踏上山道。\n\n她按住玉牌。')
  })

  it('缺一级标题抛 INVALID_INPUT', () => {
    try {
      parseChapterFile('<!-- scene:1 -->\n正文')
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('INVALID_INPUT')
    }
  })

  it('往返一致', () => {
    const a = parseChapterFile(SAMPLE_CHAPTER)
    expect(parseChapterFile(serializeChapterFile(a))).toEqual(a)
  })
})

describe('serializeChapterFile', () => {
  it('定稿不含段标记（§2.7 二）', () => {
    const out = serializeChapterFile({
      title: '第四章',
      scenes: [{ sceneNo: 1, text: '甲段。' }],
    })
    expect(out).not.toContain('<!-- seg:')
    expect(out).toContain('<!-- scene:1 -->')
  })
})

describe('splitParagraphs', () => {
  it('按空行切分并去空段', () => {
    expect(splitParagraphs('甲\n\n乙\n\n\n丙\n')).toEqual(['甲', '乙', '丙'])
  })

  it('单个换行不切分', () => {
    expect(splitParagraphs('甲\n乙')).toEqual(['甲\n乙'])
  })

  it('全空白返回空数组', () => {
    expect(splitParagraphs('\n\n  \n')).toEqual([])
  })
})
