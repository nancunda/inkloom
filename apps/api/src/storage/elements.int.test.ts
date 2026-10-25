import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonArray, readJsonElement, writeJsonElement } from './elements.js'
import { bookPaths, relativeToBook } from './paths.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-el-'))
  await mkdir(join(root, 'characters'), { recursive: true })
  await mkdir(join(root, 'story'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('writeJsonElement / readJsonElement', () => {
  it('往返一致，且写出的 JSON 带缩进与尾换行（Git diff 可读）', async () => {
    const rel = 'characters/lin-lan.json'
    await writeJsonElement(root, rel, { id: 'c1', name: '林岚' })
    expect(await readJsonElement(root, rel)).toEqual({ id: 'c1', name: '林岚' })
    const raw = await readFile(join(root, rel), 'utf8')
    expect(raw).toContain('\n  ')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('文件不存在返回 null', async () => {
    expect(await readJsonElement(root, 'characters/nope.json')).toBeNull()
  })

  it('★ JSON 损坏抛 INVALID_INPUT 并带上文件名（不返回半个对象）', async () => {
    const rel = 'characters/broken.json'
    await writeFile(join(root, rel), '{ not json', 'utf8')
    try {
      await readJsonElement(root, rel)
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('INVALID_INPUT')
      expect((e as Error).message).toContain('broken.json')
    }
  })

  it('CAS 生效', async () => {
    const rel = 'characters/c1.json'
    const { newHash } = await writeJsonElement(root, rel, { a: 1 })
    await writeJsonElement(root, rel, { a: 2 }, { expectedHash: newHash })
    await expect(writeJsonElement(root, rel, { a: 3 }, { expectedHash: newHash })).rejects.toThrow(
      InkloomError,
    )
  })

  it('拒绝写入不存在的目录（不静默建目录）', async () => {
    await expect(writeJsonElement(root, 'no-such/x.json', {})).rejects.toThrow()
  })

  it('中文内容不被转义（写入人类可读）', async () => {
    const rel = 'characters/cn.json'
    await writeJsonElement(root, rel, { name: '林岚' })
    expect(await readFile(join(root, rel), 'utf8')).toContain('林岚')
  })
})

describe('readJsonArray', () => {
  it('读数组文件', async () => {
    await writeJsonElement(root, 'story/threads.json', [{ id: 't1' }, { id: 't2' }])
    expect(await readJsonArray(root, 'story/threads.json')).toHaveLength(2)
  })

  it('文件不存在返回空数组', async () => {
    expect(await readJsonArray(root, 'story/none.json')).toEqual([])
  })

  it('★ 内容不是数组时抛 INVALID_INPUT', async () => {
    await writeJsonElement(root, 'story/bad.json', { a: 1 })
    await expect(readJsonArray(root, 'story/bad.json')).rejects.toThrowError(InkloomError)
  })
})

describe('bookPaths', () => {
  it('给出 spec §2.5 的完整目录结构', () => {
    const p = bookPaths('/books/qixia')
    expect(p.novelJson).toContain('novel.json')
    expect(p.indexDb).toContain(join('.inkloom', 'index.sqlite'))
    expect(p.revisions).toContain(join('.inkloom', 'revisions'))
    expect(p.checkpoints).toContain('checkpoints.jsonl')
  })

  it('relativeToBook 输出 POSIX 分隔符', () => {
    const rel = relativeToBook('/books/qixia', join('/books/qixia', 'chapters', 'ch-001.md'))
    expect(rel).toBe('chapters/ch-001.md')
  })
})
