import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InkloomError } from '@inkloom/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWrite, hashContent, readIfExists } from './atomic-write.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inkloom-aw-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('atomicWrite', () => {
  it('写入新文件并返回 hash', async () => {
    const p = join(dir, 'a.md')
    const { newHash } = await atomicWrite(p, '甲')
    expect(await readFile(p, 'utf8')).toBe('甲')
    expect(newHash).toBe(hashContent('甲'))
  })

  it('不留下 .tmp 文件', async () => {
    const p = join(dir, 'a.md')
    await atomicWrite(p, '甲')
    const files = await readdir(dir)
    expect(files.filter((f) => f.includes('.tmp-'))).toHaveLength(0)
  })

  it('覆盖已有文件（CAS 匹配）', async () => {
    const p = join(dir, 'a.md')
    await atomicWrite(p, '旧')
    await atomicWrite(p, '新', { expectedHash: hashContent('旧') })
    expect(await readFile(p, 'utf8')).toBe('新')
  })

  it('★ CAS 不符 → CAS_MISMATCH，且不写入', async () => {
    const p = join(dir, 'a.md')
    await atomicWrite(p, '外部改过')
    try {
      await atomicWrite(p, '我想写', { expectedHash: hashContent('我以为的内容') })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('CAS_MISMATCH')
    }
    expect(await readFile(p, 'utf8')).toBe('外部改过')
  })

  it('expectedHash=null 要求文件不存在', async () => {
    const p = join(dir, 'new.md')
    await atomicWrite(p, '甲', { expectedHash: null })
    try {
      await atomicWrite(p, '乙', { expectedHash: null })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as InkloomError).code).toBe('CAS_MISMATCH')
    }
  })

  it('不传 expectedHash 时不做校验', async () => {
    const p = join(dir, 'a.md')
    await atomicWrite(p, '旧')
    await atomicWrite(p, '新')
    expect(await readFile(p, 'utf8')).toBe('新')
  })

  it('父目录不存在时报错而不是静默创建', async () => {
    await expect(atomicWrite(join(dir, 'no-such', 'a.md'), '甲')).rejects.toThrow()
  })

  it('写入 UTF-8 中文不变形', async () => {
    const p = join(dir, 'cn.md')
    const text = '林岚踏上山道，风从袖口灌进来。'
    await atomicWrite(p, text)
    expect(await readFile(p, 'utf8')).toBe(text)
  })
})

describe('readIfExists', () => {
  it('存在则返回内容', async () => {
    const p = join(dir, 'a.md')
    await writeFile(p, '甲', 'utf8')
    expect(await readIfExists(p)).toBe('甲')
  })

  it('不存在返回 null', async () => {
    expect(await readIfExists(join(dir, 'nope.md'))).toBeNull()
  })
})
