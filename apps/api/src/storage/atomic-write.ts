import { createHash } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { InkloomError } from '@inkloom/shared'

export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface WriteOptions {
  /**
   * 期望的当前文件 hash（写前 CAS，spec §2.6 防线 1）。
   * - 传字符串：文件必须存在且 hash 相同
   * - 传 null：文件必须不存在
   * - 不传：不校验（仅用于确定无并发的新文件）
   */
  expectedHash?: string | null
}

export async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

const RENAME_RETRIES = 5
const RENAME_DELAY_MS = 40

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; i < RENAME_RETRIES; i++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      // Windows 上目标文件被其他进程短暂占用会 EPERM/EBUSY/EACCES
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e
      if (i === RENAME_RETRIES - 1) throw e
      await new Promise((r) => setTimeout(r, RENAME_DELAY_MS * (i + 1)))
    }
  }
}

/**
 * 原子写入（spec §2.6 写入顺序 步骤 0–2）。
 *
 * 顺序：CAS 校验 → 写 tmp → fsync → rename。
 * rename 是原子替换，失败时原文件完好无损。
 *
 * ★ 为什么必须有 CAS：rename 是无条件替换。没有写前 hash 比对，
 *   用户在 2s 轮询窗口内的手动编辑会被静默吞掉（ADR-26 承诺“外部编辑不丢”）。
 */
export async function atomicWrite(
  filePath: string,
  content: string,
  options: WriteOptions = {},
): Promise<{ newHash: string }> {
  if (options.expectedHash !== undefined) {
    const current = await readIfExists(filePath)
    const actual = current === null ? null : hashContent(current)
    if (actual !== options.expectedHash) {
      throw new InkloomError(
        'CAS_MISMATCH',
        `写前校验失败：${filePath} 期望 hash=${options.expectedHash ?? 'null(不存在)'}，实际=${actual ?? 'null(不存在)'}`,
      )
    }
  }

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }

  try {
    await renameWithRetry(tmp, filePath)
  } catch (e) {
    await unlink(tmp).catch(() => undefined)
    throw e
  }

  return { newHash: hashContent(content) }
}
