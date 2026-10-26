import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RevisionRecord } from '@inkloom/core'
import type { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git, initRepo } from '../git/runner.js'
import {
  checkpointRelPath,
  createCheckpoint,
  readCheckpoints,
  rollbackToCheckpoint,
} from './checkpoints.js'
import { appendRevision, countRevisionLines } from './revisions.js'

let root: string

function rec(version: number): RevisionRecord {
  return {
    id: `r${version}`,
    entityType: 'character',
    entityId: 'c1',
    version,
    parentRevisionId: version === 1 ? null : `r${version - 1}`,
    payload: JSON.stringify({ id: 'c1', curPhysical: `状态${version}` }),
    changeSource: 'human',
    changeReason: null,
    generationRunId: null,
    createdAt: '2026-10-25T00:00:00.000Z',
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-ck-'))
  await initRepo(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkpointRelPath', () => {
  it('固定在 .inkloom/checkpoints.jsonl', () => {
    expect(checkpointRelPath()).toBe('.inkloom/checkpoints.jsonl')
  })
})

describe('createCheckpoint', () => {
  it('记录 gitRef 与各 revision 文件的行数', async () => {
    await writeFile(join(root, 'a.md'), '正文一', 'utf8')
    await appendRevision(root, rec(1))
    await appendRevision(root, rec(2))
    const ck = await createCheckpoint(root, '第 1 章定稿')
    expect(ck.label).toBe('第 1 章定稿')
    expect(ck.gitRef).toMatch(/^[0-9a-f]{7,}$/)
    expect(ck.revisionsOffsets['.inkloom/revisions/character__c1.jsonl']).toBe(2)
  })

  it('多次 checkpoint 追加到同一 JSONL，顺序保持', async () => {
    await createCheckpoint(root, 'A')
    await createCheckpoint(root, 'B')
    await createCheckpoint(root, 'C')
    const list = await readCheckpoints(root)
    expect(list.map((c) => c.label)).toEqual(['A', 'B', 'C'])
  })

  it('id 唯一', async () => {
    await createCheckpoint(root, 'A')
    await createCheckpoint(root, 'B')
    const list = await readCheckpoints(root)
    expect(new Set(list.map((c) => c.id)).size).toBe(2)
  })
})

describe('readCheckpoints', () => {
  it('无文件返回空数组', async () => {
    expect(await readCheckpoints(root)).toEqual([])
  })
})

describe('rollbackToCheckpoint', () => {
  it('★ 同时恢复正文与要素历史（不是只回 Git）', async () => {
    await writeFile(join(root, 'a.md'), '正文一', 'utf8')
    await appendRevision(root, rec(1))
    const ck = await createCheckpoint(root, '在第 1 章')

    await writeFile(join(root, 'b.md'), '正文二', 'utf8')
    await appendRevision(root, rec(2))
    await appendRevision(root, rec(3))
    await createCheckpoint(root, '在第 2 章')

    const r = await rollbackToCheckpoint(root, ck.id)
    expect(r.truncatedRevisionFiles).toContain('.inkloom/revisions/character__c1.jsonl')
    expect(await countRevisionLines(root, 'character', 'c1')).toBe(1)
  })

  it('回退本身也留痕（追加一条 rollback checkpoint）', async () => {
    await writeFile(join(root, 'a.md'), '甲', 'utf8')
    const ck = await createCheckpoint(root, '起')
    await writeFile(join(root, 'b.md'), '乙', 'utf8')
    await createCheckpoint(root, '终')

    await rollbackToCheckpoint(root, ck.id)
    const list = await readCheckpoints(root)
    expect(list.some((c) => c.label.includes('回退到'))).toBe(true)
  })

  it('不存在的 checkpoint → NOT_FOUND', async () => {
    try {
      await rollbackToCheckpoint(root, 'ck-nope')
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('NOT_FOUND')
    }
  })

  it('恢复被改动的文件内容（只限 TRACKED_DIRS 内的路径）', async () => {
    await mkdir(join(root, 'chapters'), { recursive: true })
    const rel = join('chapters', 'ch-001.md')
    await writeFile(join(root, rel), '第一版', 'utf8')
    const ck = await createCheckpoint(root, '第一版')
    await writeFile(join(root, rel), '第二版', 'utf8')
    await createCheckpoint(root, '第二版')

    await rollbackToCheckpoint(root, ck.id)
    expect(await readFile(join(root, rel), 'utf8')).toBe('第一版')
  })

  it('★ 回退会删掉检查点之后新增的文件（不能留幽灵章）', async () => {
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(join(root, 'chapters', 'ch-001.md'), '第一章', 'utf8')
    const ck = await createCheckpoint(root, '只有一章')

    await writeFile(join(root, 'chapters', 'ch-002.md'), '第二章', 'utf8')
    await createCheckpoint(root, '两章')

    await rollbackToCheckpoint(root, ck.id)
    await expect(readFile(join(root, 'chapters', 'ch-002.md'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, 'chapters', 'ch-001.md'), 'utf8')).toBe('第一章')
  })

  it('★ 回退后工作区干净，且快照与回退记录都进了 git 历史', async () => {
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(join(root, 'chapters', 'ch-001.md'), '甲', 'utf8')
    const ck = await createCheckpoint(root, '起')
    await writeFile(join(root, 'chapters', 'ch-002.md'), '乙', 'utf8')

    await rollbackToCheckpoint(root, ck.id)

    expect((await git(root, ['status', '--porcelain'])).trim()).toBe('')
    const log = await git(root, ['log', '--oneline'])
    expect(log).toContain('回退前快照')
    expect(log).toContain(`回退到 起 (${ck.id})`)
  })

  it('★ 检查点之后新建实体的 revision 文件被清空', async () => {
    const ck = await createCheckpoint(root, '还没有 c1')
    await appendRevision(root, rec(1))
    await createCheckpoint(root, '有 c1')

    await rollbackToCheckpoint(root, ck.id)
    expect(await countRevisionLines(root, 'character', 'c1')).toBe(0)
  })

  it('★ 整个目录被删掉也能回退（恢复不能看磁盘上还在不在）', async () => {
    await mkdir(join(root, 'chapters'), { recursive: true })
    await writeFile(join(root, 'chapters', 'ch-001.md'), '第一章', 'utf8')
    const ck = await createCheckpoint(root, '有目录')

    await rm(join(root, 'chapters'), { recursive: true, force: true })

    await rollbackToCheckpoint(root, ck.id)
    expect(await readFile(join(root, 'chapters', 'ch-001.md'), 'utf8')).toBe('第一章')
  })

  it('索引文件不进版本历史（.gitignore 自动补全）', async () => {
    await mkdir(join(root, '.inkloom'), { recursive: true })
    await writeFile(join(root, '.inkloom', 'index.sqlite'), 'binary', 'utf8')

    await createCheckpoint(root, 'A')

    const tracked = await git(root, ['ls-files'])
    expect(tracked).not.toContain('index.sqlite')
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.inkloom/index.sqlite')
  })
})
