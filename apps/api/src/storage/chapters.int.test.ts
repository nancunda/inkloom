import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SceneFile } from '@inkloom/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chapterRelPath, collectChapterScenes, mergeChapter, splitChapter } from './chapters.js'
import {
  collectChapterSegIds,
  latestSceneVersion,
  listSceneNos,
  listSceneVersions,
  readSceneFile,
  sceneRelPath,
  writeSceneFile,
} from './scenes.js'

let root: string
const sc = (v: number, id = 'aaaa'): SceneFile => ({
  sceneNo: 1,
  version: v,
  segments: [
    { segId: id, text: `第 ${v} 版` },
    { segId: 'bbbb', text: '不变段' },
  ],
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-sc-'))
  await mkdir(join(root, 'chapters'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('sceneRelPath / chapterRelPath', () => {
  it('路径格式符合 §2.7', () => {
    expect(sceneRelPath(4, 1, 3)).toBe('chapters/ch-004/scenes/s1.v3.md')
    expect(sceneRelPath(12, 10, 1)).toBe('chapters/ch-012/scenes/s10.v1.md')
    expect(chapterRelPath(4)).toBe('chapters/ch-004.md')
  })
})

describe('writeSceneFile / readSceneFile', () => {
  it('写入后可读回，结构等价', async () => {
    await writeSceneFile(root, sc(1), 4)
    expect(await readSceneFile(root, 4, 1, 1)).toEqual(sc(1))
  })

  it('写入的文本含段标记（供单段回退寻址）', async () => {
    const { relPath } = await writeSceneFile(root, sc(1), 4)
    const raw = await readFile(join(root, relPath), 'utf8')
    expect(raw).toContain('<!-- seg:aaaa -->')
    expect(raw).toContain('<!-- scene:1 v:1 -->')
  })

  it('★ 不覆盖旧版本（v1 与 v2 并存）', async () => {
    await writeSceneFile(root, sc(1), 4)
    await writeSceneFile(root, sc(2), 4)
    expect(await readSceneFile(root, 4, 1, 1)).toEqual(sc(1))
    expect(await readSceneFile(root, 4, 1, 2)).toEqual(sc(2))
  })

  it('不存在返回 null', async () => {
    expect(await readSceneFile(root, 9, 9, 9)).toBeNull()
  })

  it('自动创建章目录（首次写该章）', async () => {
    await expect(writeSceneFile(root, sc(1), 7)).resolves.toBeDefined()
  })
})

describe('版本查询', () => {
  it('listSceneVersions 升序', async () => {
    await writeSceneFile(root, sc(1), 4)
    await writeSceneFile(root, sc(3), 4)
    await writeSceneFile(root, sc(2), 4)
    expect(await listSceneVersions(root, 4, 1)).toEqual([1, 2, 3])
  })

  it('无版本时返回空数组 / null', async () => {
    expect(await listSceneVersions(root, 4, 9)).toEqual([])
    expect(await latestSceneVersion(root, 4, 9)).toBeNull()
  })

  it('latestSceneVersion 取最大版本', async () => {
    await writeSceneFile(root, sc(1), 4)
    await writeSceneFile(root, sc(5), 4)
    expect(await latestSceneVersion(root, 4, 1)).toBe(5)
  })

  it('listSceneNos 列出出现过的场景号', async () => {
    await writeSceneFile(root, { ...sc(1), sceneNo: 1 }, 4)
    await writeSceneFile(root, { ...sc(1), sceneNo: 3 }, 4)
    expect(await listSceneNos(root, 4)).toEqual([1, 3])
  })
})

describe('collectChapterSegIds', () => {
  it('★ 包含历史版本里已删除的段 ID（这就是墓碑）', async () => {
    // v1 有 aaaa + bbbb
    await writeSceneFile(root, sc(1), 4)
    // v2 删掉了 aaaa，只剩 bbbb + cccc
    await writeSceneFile(
      root,
      {
        sceneNo: 1,
        version: 2,
        segments: [
          { segId: 'bbbb', text: '不变段' },
          { segId: 'cccc', text: '新段' },
        ],
      },
      4,
    )
    const ids = await collectChapterSegIds(root, 4)
    // aaaa 只存在于 v1，仍须被视为已占用
    expect(ids.has('aaaa')).toBe(true)
    expect(ids.has('bbbb')).toBe(true)
    expect(ids.has('cccc')).toBe(true)
  })

  it('空章返回空集合', async () => {
    expect((await collectChapterSegIds(root, 99)).size).toBe(0)
  })
})

describe('mergeChapter', () => {
  it('合并后写出一级标题 + 场景边界 + 正文', async () => {
    const { relPath } = await mergeChapter(root, {
      chapterNo: 4,
      title: '第四章 剑冢',
      scenes: [
        { sceneNo: 1, text: '甲段。\n\n乙段。' },
        { sceneNo: 2, text: '丙段。' },
      ],
    })
    const raw = await readFile(join(root, relPath), 'utf8')
    expect(raw).toContain('# 第四章 剑冢')
    expect(raw).toContain('<!-- scene:1 -->')
    expect(raw).toContain('<!-- scene:2 -->')
    expect(raw).toContain('甲段。')
  })

  it('★ 定稿不含段标记（§2.7 二）', async () => {
    const { relPath } = await mergeChapter(root, {
      chapterNo: 4,
      title: '第四章',
      scenes: [{ sceneNo: 1, text: '甲段。' }],
    })
    expect(await readFile(join(root, relPath), 'utf8')).not.toContain('<!-- seg:')
  })

  it('重复合并覆盖同一文件（定稿是幂等的最终态）', async () => {
    await mergeChapter(root, {
      chapterNo: 4,
      title: '旧标题',
      scenes: [{ sceneNo: 1, text: '甲' }],
    })
    const { relPath } = await mergeChapter(root, {
      chapterNo: 4,
      title: '新标题',
      scenes: [{ sceneNo: 1, text: '乙' }],
    })
    const raw = await readFile(join(root, relPath), 'utf8')
    expect(raw).toContain('新标题')
    expect(raw).not.toContain('旧标题')
  })

  it('空场景被过滤，不产出空场景块', async () => {
    await mergeChapter(root, {
      chapterNo: 5,
      title: '第五章',
      scenes: [
        { sceneNo: 1, text: '甲' },
        { sceneNo: 2, text: '   ' },
      ],
    })
    const raw = await readFile(join(root, chapterRelPath(5)), 'utf8')
    expect(raw).toContain('<!-- scene:1 -->')
    expect(raw).not.toContain('<!-- scene:2 -->')
  })
})

describe('splitChapter（撤销定稿的反解）', () => {
  it('按 <!-- scene:N --> 切回场景', async () => {
    await mergeChapter(root, {
      chapterNo: 4,
      title: '第四章 剑冢',
      scenes: [
        { sceneNo: 1, text: '甲段。' },
        { sceneNo: 2, text: '乙段。' },
      ],
    })
    const out = await splitChapter(root, 4)
    expect(out?.title).toBe('第四章 剑冢')
    expect(out?.scenes).toHaveLength(2)
    expect(out?.scenes[0]?.sceneNo).toBe(1)
    expect(out?.scenes[0]?.segments[0]?.text).toBe('甲段。')
  })

  it('★ 反解后段 ID 是新分配的 4 位 base36', async () => {
    await mergeChapter(root, {
      chapterNo: 4,
      title: '第四章',
      scenes: [{ sceneNo: 1, text: '甲段。' }],
    })
    const out = await splitChapter(root, 4)
    expect(out?.scenes[0]?.segments[0]?.segId).toMatch(/^[0-9a-z]{4}$/)
  })

  it('★ 反解分配的 ID 不与历史版本冲突', async () => {
    // 先造一批历史 ID
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 1, segments: [{ segId: 'aaaa', text: '旧' }] },
      4,
    )
    await mergeChapter(root, {
      chapterNo: 4,
      title: '第四章',
      scenes: [{ sceneNo: 1, text: '甲段。\n\n乙段。' }],
    })
    const historyIds = await collectChapterSegIds(root, 4)
    const out = await splitChapter(root, 4)
    for (const seg of out?.scenes[0]?.segments ?? []) {
      expect(historyIds.has(seg.segId)).toBe(false)
    }
  })

  it('★ version = 原最新 + 1（不覆盖历史候选稿）', async () => {
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 2, segments: [{ segId: 'aaaa', text: '旧' }] },
      4,
    )
    await mergeChapter(root, {
      chapterNo: 4,
      title: '第四章',
      scenes: [{ sceneNo: 1, text: '定稿' }],
    })
    const out = await splitChapter(root, 4)
    expect(out?.scenes[0]?.version).toBe(3)
    const scene0 = out?.scenes[0]
    if (scene0 === undefined) throw new Error('反解应产出场景 1')
    const { relPath } = await writeSceneFile(root, scene0, 4)
    expect(relPath).toBe('chapters/ch-004/scenes/s1.v3.md')
  })

  it('未定稿的章返回 null', async () => {
    expect(await splitChapter(root, 99)).toBeNull()
  })
})

describe('collectChapterScenes', () => {
  it('汇总各场景最新版本，多段用空行连接', async () => {
    await writeSceneFile(
      root,
      {
        sceneNo: 1,
        version: 2,
        segments: [
          { segId: 'aaaa', text: '第一段。' },
          { segId: 'bbbb', text: '第二段。' },
        ],
      },
      3,
    )
    await writeSceneFile(
      root,
      { sceneNo: 2, version: 1, segments: [{ segId: 'cccc', text: '第三段。' }] },
      3,
    )
    const scenes = await collectChapterScenes(root, 3)
    expect(scenes).toEqual([
      { sceneNo: 1, text: '第一段。\n\n第二段。' },
      { sceneNo: 2, text: '第三段。' },
    ])
  })
})

describe('merge 与 split 往返', () => {
  it('★ 文本内容等价（段 ID 会变，文本不变）', async () => {
    const input = {
      chapterNo: 6,
      title: '第六章',
      scenes: [
        { sceneNo: 1, text: '第一段。\n\n第二段。' },
        { sceneNo: 2, text: '第三段。' },
      ],
    }
    await mergeChapter(root, input)
    const split = await splitChapter(root, 6)
    const scenes =
      split?.scenes.map((s) => ({
        sceneNo: s.sceneNo,
        text: s.segments.map((g) => g.text).join('\n\n'),
      })) ?? []
    await mergeChapter(root, { chapterNo: 7, title: split?.title ?? '', scenes })
    const out = await splitChapter(root, 7)
    expect(out?.scenes.map((s) => s.segments.map((g) => g.text))).toEqual([
      ['第一段。', '第二段。'],
      ['第三段。'],
    ])
  })
})
