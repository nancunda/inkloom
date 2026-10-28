import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSceneFile } from '../storage/scenes.js'
import { readChapters } from './book-snapshot.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-snap-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('readChapters', () => {
  // 回归：E2E 里第 1 章已生成 5 个场景候选（未定稿），旧实现只读 SQLite 的
  // Chapter 表，agent 看到 chapters: [] 后判断「一个字都没写」，拒绝提交审阅。
  it('★ 只有候选场景也算“有内容”，每场取最新版本', async () => {
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 1, segments: [{ segId: 'aaaa', text: '旧版本' }] },
      1,
    )
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 2, segments: [{ segId: 'aaaa', text: '第一场正文' }] },
      1,
    )
    await writeSceneFile(
      root,
      { sceneNo: 2, version: 1, segments: [{ segId: 'bbbb', text: '第二场正文' }] },
      1,
    )

    const chapters = await readChapters(root)

    expect(chapters).toHaveLength(1)
    expect(chapters[0]?.status).toBe('draft')
    expect(chapters[0]?.file).toBeNull()
    expect(chapters[0]?.scenes).toEqual([
      { sceneNo: 1, latestVersion: 2, chars: 5 },
      { sceneNo: 2, latestVersion: 1, chars: 5 },
    ])
    expect(chapters[0]?.wordCount).toBe(10)
  })

  it('定稿文件优先：状态 finalized、标题来自一级标题', async () => {
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(
      join(root, 'chapters', 'ch-001.md'),
      '# 七斤四两\n\n<!-- scene:1 -->\n\n正文第一段\n',
      'utf8',
    )
    await writeSceneFile(
      root,
      { sceneNo: 1, version: 1, segments: [{ segId: 'aaaa', text: '候选正文' }] },
      1,
    )

    const chapters = await readChapters(root)

    expect(chapters[0]).toMatchObject({
      chapterNo: 1,
      title: '七斤四两',
      status: 'finalized',
      // ★ 验收发现：critic 猜成 chapters/ch04.md，两次读空；快照必须直接给真实路径
      file: 'chapters/ch-001.md',
    })
    expect(chapters[0]?.scenes).toHaveLength(1)
  })

  it('没有 chapters 目录时返回空数组', async () => {
    expect(await readChapters(root)).toEqual([])
  })
})
