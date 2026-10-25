import { describe, expect, it } from 'vitest'
import { WriteQueue } from './queue.js'

describe('WriteQueue', () => {
  it('串行执行：后一个任务等前一个完成', async () => {
    const q = new WriteQueue()
    const log: string[] = []
    const slow = q.run(async () => {
      log.push('slow-start')
      await new Promise((r) => setTimeout(r, 30))
      log.push('slow-end')
      return 1
    })
    const fast = q.run(async () => {
      log.push('fast')
      return 2
    })
    const [a, b] = await Promise.all([slow, fast])
    expect(a).toBe(1)
    expect(b).toBe(2)
    expect(log).toEqual(['slow-start', 'slow-end', 'fast'])
  })

  it('★ 前一个任务失败不阻塞后续任务（否则队列永久卡死）', async () => {
    const q = new WriteQueue()
    const failed = q.run(async () => {
      throw new Error('boom')
    })
    const ok = q.run(async () => 'ok')
    await expect(failed).rejects.toThrow('boom')
    await expect(ok).resolves.toBe('ok')
  })

  it('100 个并发任务严格按入队顺序执行', async () => {
    const q = new WriteQueue()
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        q.run(async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 3))
          order.push(i)
        }),
      ),
    )
    expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i))
  })

  it('pending 反映排队深度', async () => {
    const q = new WriteQueue()
    const p1 = q.run(() => new Promise<void>((r) => setTimeout(r, 20)))
    const p2 = q.run(async () => undefined)
    expect(q.pending).toBeGreaterThanOrEqual(1)
    await Promise.all([p1, p2])
    expect(q.pending).toBe(0)
  })
})
