import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { atomicWrite, readIfExists, type WriteOptions } from './atomic-write.js'

function abs(root: string, relPath: string): string {
  return join(root, relPath)
}

/** 读要素 JSON。不存在返回 null；JSON 损坏抛 INVALID_INPUT（绝不返回“半个对象”） */
export async function readJsonElement(root: string, relPath: string): Promise<unknown | null> {
  const raw = await readIfExists(abs(root, relPath))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch (e) {
    throw new InkloomError('INVALID_INPUT', `${relPath} 不是合法 JSON：${(e as Error).message}`)
  }
}

/** 写要素 JSON。统一 2 空格缩进 + 尾换行，保证 Git diff 可读 */
export async function writeJsonElement(
  root: string,
  relPath: string,
  value: unknown,
  opts: WriteOptions = {},
): Promise<{ newHash: string }> {
  const content = `${JSON.stringify(value, null, 2)}\n`
  return atomicWrite(abs(root, relPath), content, opts)
}

/** 读 JSON 数组。不存在返回 []；不是数组抛 INVALID_INPUT */
export async function readJsonArray(root: string, relPath: string): Promise<unknown[]> {
  const v = await readJsonElement(root, relPath)
  if (v === null) return []
  if (!Array.isArray(v)) {
    throw new InkloomError('INVALID_INPUT', `${relPath} 期望是 JSON 数组`)
  }
  return v
}
