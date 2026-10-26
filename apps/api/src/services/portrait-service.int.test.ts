import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ImageProvider } from '../assets/image-provider.js'
import { git } from '../git/runner.js'
import type { IndexDb } from '../index-db/client.js'
import type { FetchLike } from '../llm/types.js'
import { writeJsonElement } from '../storage/elements.js'
import { createProject } from '../storage/project.js'
import { freshIndexDb } from '../test-utils/index-db-fixture.js'
import { clearContext, setContext } from './context.js'
import { generatePortrait } from './portrait-service.js'

let base: string
let root: string
let db: IndexDb
let pid = ''

/** 一个最小的 PNG 头：够验证「二进制没被写坏」 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

const fakeImage: ImageProvider = {
  id: 'fake',
  async generate(req) {
    return {
      url: 'https://img.example/x.png',
      provider: 'fake',
      model: 'fake-model',
      params: { image_size: '1024x1024', promptEcho: req.prompt.slice(0, 10) },
    }
  },
}

const downloadOk: FetchLike = async () =>
  new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'inkloom-portrait-'))
  root = join(base, 'book')
  db = await freshIndexDb(base)
  const { project } = await createProject({ rootPath: root, name: '七霞', genre: '玄幻' })
  pid = project.id
  await setContext({ root, db, project })
  await writeJsonElement(root, 'characters/index.json', [
    {
      id: 'c1',
      projectId: pid,
      name: '林岚',
      role: 'protagonist',
      appearance: '青灰道袍，眉间一点朱砂',
      visualAnchor: '青灰道袍，眉间一点朱砂，左眉一道旧疤，佩短刀在右腰',
    },
    { id: 'c2', projectId: pid, name: '无名', role: 'minor' },
  ])
})

afterEach(async () => {
  clearContext()
  await db.$disconnect()
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('generatePortrait（P4）', () => {
  it('★ 生图 → 落盘为二进制 → 记 Asset（prompt/provider/model/params 齐全）', async () => {
    const r = await generatePortrait({
      characterId: 'c1',
      apiKey: 'sk-test',
      imageProvider: fakeImage,
      fetchImpl: downloadOk,
    })

    expect(r.filePath).toBe('assets/characters/c1.png')
    expect(r.name).toBe('林岚')

    // 文件真的是 PNG 字节，而不是被当字符串写坏的文本
    const bytes = await readFile(join(root, r.filePath))
    expect(bytes.subarray(0, 8)).toEqual(PNG_BYTES.subarray(0, 8))

    const asset = await db.asset.findFirst({ where: { ownerId: 'c1' } })
    expect(asset?.assetType).toBe('portrait')
    expect(asset?.provider).toBe('fake')
    expect(asset?.model).toBe('fake-model')
    expect(asset?.prompt).toContain('左眉一道旧疤')
    expect(asset?.visualAnchor).toContain('左眉一道旧疤')
    expect(JSON.parse(asset?.params ?? '{}')).toMatchObject({ image_size: '1024x1024' })

    // ★ 形象图必须进书的 git：换机/克隆/回退时不能只剩一条 DB 记录
    expect(await git(root, ['ls-files', '--', 'assets/characters/c1.png'])).toContain(
      'assets/characters/c1.png',
    )
  })

  it('★ prompt 以 visualAnchor 开头（锚点第一，appearance 只作补充）', async () => {
    const r = await generatePortrait({
      characterId: 'c1',
      apiKey: 'sk-test',
      imageProvider: fakeImage,
      fetchImpl: downloadOk,
    })
    expect(r.prompt.startsWith('青灰道袍，眉间一点朱砂，左眉一道旧疤')).toBe(true)
  })

  it('角色不存在 → NOT_FOUND', async () => {
    await expect(
      generatePortrait({
        characterId: 'zz',
        apiKey: 'k',
        imageProvider: fakeImage,
        fetchImpl: downloadOk,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('★ 既无 visualAnchor 也无 appearance → INVALID_INPUT（不烧生图额度）', async () => {
    await expect(
      generatePortrait({
        characterId: 'c2',
        apiKey: 'k',
        imageProvider: fakeImage,
        fetchImpl: downloadOk,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(access(join(root, 'assets/characters/c2.png'))).rejects.toThrow()
  })

  it('图片下载失败 → UNAVAILABLE，不留 Asset 行', async () => {
    const badDownload: FetchLike = async () => new Response('nope', { status: 500 })
    await expect(
      generatePortrait({
        characterId: 'c1',
        apiKey: 'k',
        imageProvider: fakeImage,
        fetchImpl: badDownload,
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await db.asset.count()).toBe(0)
  })
})
