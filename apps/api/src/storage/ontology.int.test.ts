import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readOntologyFiles } from './ontology.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkloom-ontology-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

describe('readOntologyFiles', () => {
  it('没有文件时返回空图数据', async () => {
    const f = await readOntologyFiles(root)
    expect(f.classesFile).toBeNull()
    expect(f.nodes).toEqual([])
    expect(f.edges).toEqual([])
    expect(f.warnings).toEqual([])
    expect(f.mtimeMax).toBe(0)
  })

  it('★ 坏行跳过并记 warning，好行照常返回', async () => {
    await write(
      'world/ontology/nodes.jsonl',
      [
        '{"id":"grp-qingyun","type":"group","name":"青云宗","createdAt":"2026-10-27T00:00:00.000Z"}',
        '不是 JSON',
        '{"id":"itm-sword","type":"item","name":"断水","createdAt":"2026-10-27T00:00:00.000Z"}',
      ].join('\n'),
    )
    const f = await readOntologyFiles(root)
    expect(f.nodes.map((n) => n.id)).toEqual(['grp-qingyun', 'itm-sword'])
    expect(f.warnings).toHaveLength(1)
    expect(f.warnings[0]).toContain('nodes.jsonl 第 2 行')
  })

  it('classes.json 坏掉时忽略并记 warning', async () => {
    await write('world/ontology/classes.json', '{oops')
    const f = await readOntologyFiles(root)
    expect(f.classesFile).toBeNull()
    expect(f.warnings[0]).toContain('classes.json')
  })

  it('classes.json 带 BOM 仍能解析（Windows 编辑器）', async () => {
    const body = JSON.stringify({ version: 1, classes: [], predicates: [] })
    await write('world/ontology/classes.json', `\uFEFF${body}`)
    const f = await readOntologyFiles(root)
    expect(f.classesFile).not.toBeNull()
    expect(f.warnings).toEqual([])
  })

  it('CRLF 与末尾空行不产生假坏行；不合 schema 的行单独报', async () => {
    await write(
      'world/ontology/nodes.jsonl',
      [
        '{"id":"grp-a","type":"group","name":"甲","createdAt":"2026-10-27T00:00:00.000Z"}',
        '{"id":"没有前缀","type":"group","name":"乙","createdAt":"2026-10-27T00:00:00.000Z"}',
        '',
      ].join('\r\n'),
    )
    const f = await readOntologyFiles(root)
    expect(f.nodes.map((n) => n.id)).toEqual(['grp-a'])
    expect(f.warnings).toHaveLength(1)
    expect(f.warnings[0]).toContain('nodes.jsonl 第 2 行')
  })

  it('watchFiles 指向不存在的文件时不抛，且不影响已有的 mtimeMax', async () => {
    await write(
      'world/ontology/edges.jsonl',
      '{"id":"ed-aaaaaa","from":"c1","predicate":"instanceOf","to":"cls-character","source":{"kind":"author"},"createdAt":"2026-10-27T00:00:00.000Z"}',
    )
    const f = await readOntologyFiles(root, [join(root, 'characters/ghost.json')])
    expect(f.edges).toHaveLength(1)
    expect(f.mtimeMax).toBeGreaterThan(0)
    expect(f.files).toContain('characters/ghost.json')
  })

  it('watchFiles 的 mtime 参与 mtimeMax（实体文件变了缓存要失效）', async () => {
    await write('characters/index.json', '[]')
    const file = join(root, 'characters/index.json')
    const f = await readOntologyFiles(root, [file])
    expect(f.mtimeMax).toBeGreaterThan(0)
    expect(f.files).toContain('characters/index.json')
  })
})
