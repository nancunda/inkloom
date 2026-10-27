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

  it('watchFiles 的 mtime 参与 mtimeMax（实体文件变了缓存要失效）', async () => {
    await write('characters/index.json', '[]')
    const file = join(root, 'characters/index.json')
    const f = await readOntologyFiles(root, [file])
    expect(f.mtimeMax).toBeGreaterThan(0)
    expect(f.files).toContain('characters/index.json')
  })
})
