/**
 * 单一写队列（spec §2.6 并发控制 / P0-21）。
 *
 * 所有写操作必须经过它，强制串行。理由：
 *   1. 文件系统没有事务，并发 rename 会产生不可预期的中间态
 *   2. JSONL 追加靠“串行”保证 version 单调（文件系统无唯一约束）
 *   3. SQLite 索引更新与文件写入必须成对出现
 *
 * 硬约束：即使将来恢复并行生成，写入必须串行。生成可并行，落库不可。
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private depth = 0

  run<T>(task: () => Promise<T>): Promise<T> {
    this.depth += 1
    const start = (): Promise<T> => {
      this.depth -= 1
      return task()
    }
    // then 两个回调都传同一函数：前一个失败也要继续执行，否则队列会永久卡死
    const result = this.tail.then(start, start)
    this.tail = result.catch(() => undefined)
    return result
  }

  /** 排队 + 执行中的任务数 */
  get pending(): number {
    return this.depth
  }
}

/** 进程级单例。任何写存储的代码都必须用它。 */
export const writeQueue = new WriteQueue()
