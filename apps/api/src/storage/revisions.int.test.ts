import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RevisionRecord } from '@inkloom/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendRevision,
  countRevisionLines,
  lastRevision,
  parseRevisionRelPath,
  readAllRevisionFiles,
  readRevisions,
  revisionFileRelPath,
  truncateRevisions,
} from './revisions.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-rv-'))
  await mkdir(join(root, '.inkloom', 'revisions'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function rec(version: number, over: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    id: `r${version}`,
    entityType: 'character',
    entityId: 'c1',
    version,
    parentRevisionId: version === 1 ? null : `r${version - 1}`,
    payload: JSON.stringify({ name: '林岚', v: version }),
    changeSource: 'human',
    changeReason: null,
    generationRunId: null,
    createdAt: '2026-10-25T00:00:00.000Z',
    ...over,
  }
}

describe('revisionFileRelPath', () => {
  it('按 entityType__entityId.jsonl 命名', () => {
    expect(revisionFileRelPath('character', 'lin-lan')).toBe(
      '.inkloom/revisions/character__lin-lan.jsonl',
    )
  })

  it('★ entityId 中的路径分隔符被替换（防目录穿越）', () => {
    expect(revisionFileRelPath('blueprint', 'ch/004')).toBe(
      '.inkloom/revisions/blueprint__ch_004.jsonl',
    )
    const evil = revisionFileRelPath('a', '../../etc/passwd')
    // 关键：不能出现路径分隔符，否则 join 后会逃出 revisions 目录
    expect(evil.startsWith('.inkloom/revisions/')).toBe(true)
    expect(evil.slice('.inkloom/revisions/'.length)).not.toContain('/')
    expect(evil).not.toContain('\\')
  })
})

describe('parseRevisionRelPath', () => {
  it('可反解回 entityType 与 entityId', () => {
    expect(parseRevisionRelPath('.inkloom/revisions/character__c1.jsonl')).toEqual({
      entityType: 'character',
      entityId: 'c1',
    })
  })

  it('不合格式返回 null', () => {
    expect(parseRevisionRelPath('.inkloom/revisions/broken.jsonl')).toBeNull()
  })
})

describe('appendRevision / readRevisions', () => {
  it('追加后能读回，字段完整', async () => {
    await appendRevision(root, rec(1))
    const list = await readRevisions(root, 'character', 'c1')
    expect(list).toHaveLength(1)
    expect(list[0]?.entityId).toBe('c1')
    expect(JSON.parse(list[0]?.payload ?? '{}')).toEqual({ name: '林岚', v: 1 })
  })

  it('JSONL 每行一条，行数等于版本数', async () => {
    await appendRevision(root, rec(1))
    await appendRevision(root, rec(2))
    await appendRevision(root, rec(3))
    expect(await countRevisionLines(root, 'character', 'c1')).toBe(3)
  })

  it('lastRevision 返回最后一条', async () => {
    await appendRevision(root, rec(1))
    await appendRevision(root, rec(2))
    expect((await lastRevision(root, 'character', 'c1'))?.version).toBe(2)
  })

  it('没有历史时返回空数组 / null / 0', async () => {
    expect(await readRevisions(root, 'character', 'nope')).toEqual([])
    expect(await lastRevision(root, 'character', 'nope')).toBeNull()
    expect(await countRevisionLines(root, 'character', 'nope')).toBe(0)
  })

  it('不同实体的历史互不干扰', async () => {
    await appendRevision(root, rec(1))
    await appendRevision(root, rec(1, { entityId: 'c2', id: 'x1' }))
    expect(await countRevisionLines(root, 'character', 'c1')).toBe(1)
    expect(await countRevisionLines(root, 'character', 'c2')).toBe(1)
  })

  it('★ 损坏的行被跳过而不是整体失败（JSONL 的容错优势）', async () => {
    await appendRevision(root, rec(1))
    await appendFile(
      join(root, '.inkloom', 'revisions', 'character__c1.jsonl'),
      '{broken\n',
      'utf8',
    )
    await appendRevision(root, rec(2))
    expect(await readRevisions(root, 'character', 'c1')).toHaveLength(2)
  })
})

describe('truncateRevisions', () => {
  it('截断到指定行数为时间点回退服务', async () => {
    for (let v = 1; v <= 5; v++) await appendRevision(root, rec(v))
    await truncateRevisions(root, 'character', 'c1', 3)
    expect(await countRevisionLines(root, 'character', 'c1')).toBe(3)
    expect((await lastRevision(root, 'character', 'c1'))?.version).toBe(3)
  })

  it('keepLines=0 得到空文件', async () => {
    await appendRevision(root, rec(1))
    await truncateRevisions(root, 'character', 'c1', 0)
    expect(await countRevisionLines(root, 'character', 'c1')).toBe(0)
  })

  it('keepLines 大于现有行数时保持不变', async () => {
    await appendRevision(root, rec(1))
    await truncateRevisions(root, 'character', 'c1', 99)
    expect(await countRevisionLines(root, 'character', 'c1')).toBe(1)
  })
})

describe('readAllRevisionFiles', () => {
  it('列出全部 jsonl 的相对路径', async () => {
    await appendRevision(root, rec(1))
    await appendRevision(root, rec(1, { entityType: 'blueprint', entityId: 'b1', id: 'x' }))
    const files = await readAllRevisionFiles(root)
    expect(files.sort()).toEqual([
      '.inkloom/revisions/blueprint__b1.jsonl',
      '.inkloom/revisions/character__c1.jsonl',
    ])
  })

  it('目录为空时返回空数组', async () => {
    expect(await readAllRevisionFiles(root)).toEqual([])
  })
})
