import { realpath } from 'node:fs/promises'
import { InkloomError } from '@inkloom/shared'
import { clearRuns, hasLiveAgentRun } from '../agent/run-service.js'
import { commitAll, initRepo, isRepo } from '../git/runner.js'
import { openBookIndexDb } from '../index-db/open-book.js'
import { type AppContext, closeContext, peekContext, setContext } from '../services/context.js'
import { clearJobs, runningJobCount } from '../services/job-service.js'
import { clearGraphCache } from '../services/ontology-service.js'
import { ensureBookGitignore } from '../storage/book-gitignore.js'
import { openProject } from '../storage/project.js'
import { writeQueue } from '../storage/queue.js'
import { reindex } from '../storage/reindex.js'
import { rememberLastBook, resolveBookDir } from './library.js'

export interface PreparedBook {
  context: AppContext
  indexWasEmpty: boolean
  notes: string[]
}

/**
 * 打开一本书所需的一切副作用，**但不切 current**。
 *
 * ★ 顺序是硬约束（老 server.ts 的注释已经解释过）：
 *   count 必须在 setContext 之前——setContext 会 upsert Project 行，
 *   数晚了就永远不为空，空索引重建永远不会触发。
 * ★ 拆成 prepare/activate 两步，是为了切书时「先开新、成功后再关旧」：
 *   新书打不开时旧书仍然可用。
 */
export async function prepareBook(root: string): Promise<PreparedBook> {
  const notes: string[] = []
  // 统一成 realpath：否则同一本书因 C:/ 与 C:\ 两种写法被当成两本，
  // switchBook 的“已在当前书”短路也会失效。
  const rootReal = await realpath(root).catch(() => {
    throw new InkloomError('NOT_FOUND', `书籍目录不存在：${root}`)
  })
  const opened = await openProject(rootReal)
  const db = await openBookIndexDb(rootReal)
  const indexWasEmpty = (await db.project.count()) === 0

  const freshRepo = !(await isRepo(rootReal))
  if (freshRepo) {
    await initRepo(rootReal)
  }
  const hygiene = await ensureBookGitignore(rootReal)
  if (hygiene.untracked.length > 0) {
    notes.push(`索引已移出版本历史（${hygiene.untracked.length} 个文件，下次写入时提交）`)
  }
  if (freshRepo) {
    await commitAll(rootReal, 'chore: 初始化书籍仓库（首次启动）')
    notes.push('已为这本书初始化 Git 仓库')
  }

  return { context: { root: rootReal, db, project: opened.project }, indexWasEmpty, notes }
}

async function activate(prepared: PreparedBook): Promise<AppContext> {
  await setContext(prepared.context)
  // ★ reindex 必须在 setContext 之后：setContext 会 upsert Project 行，
  //   而同步角色/蓝图等实体时有 Project 外键；早于它会静默失败。
  if (prepared.indexWasEmpty) {
    const report = await reindex(prepared.context.root, prepared.context.db)
    prepared.notes.push(`索引为空，已从文件重建（${report.chapters} 章 / ${report.segments} 段）`)
    for (const w of report.warnings) prepared.notes.push(`⚠ ${w}`)
  }
  return prepared.context
}

/** 启动时打开一本书（兼容 INKLOOM_BOOK） */
export async function openBookAt(root: string): Promise<PreparedBook> {
  const prepared = await prepareBook(root)
  await activate(prepared)
  return prepared
}

let switching: Promise<void> = Promise.resolve()

/**
 * 切书：单飞 + 写队列 + 先开新后关旧。
 *
 * ★ 单飞：两个并发的 open 会各开一个 Prisma client，后写覆盖前写，
 *   前一个 db 永不 disconnect → Windows 上 EBUSY。
 * ★ 放进 writeQueue：排空在飞的 upsertElement / 定稿 / 回退，
 *   避免 disconnect 之后 Prisma 惰性重连旧库。
 * ★ 切书前拒绝有 running/waiting 的 run 与 running 的生成任务；
 *   done/stopped 的 run 在切换后清掉（它们能被 sendAgentMessage 重新激活）。
 */
export function switchBook(libraryRoot: string, folder: string): Promise<void> {
  const task = async (): Promise<void> => {
    if (hasLiveAgentRun()) {
      throw new InkloomError('CONFLICT', '还有进行中的共创会话，先停止或完成再切换')
    }
    if (runningJobCount() > 0) {
      throw new InkloomError('CONFLICT', '还有生成任务在跑，等它完成再切换')
    }
    const root = await resolveBookDir(libraryRoot, folder)
    if (peekContext()?.root === root) return

    const next = await prepareBook(root) // 1. 先开新
    await closeContext() // 2. 成功后才关旧
    clearGraphCache() // 旧书的图快照不该跟到新书
    await activate(next) // 3. 最后切指针
    clearRuns()
    clearJobs()
    await rememberLastBook(root).catch(() => undefined)
  }
  const result = switching.then(
    () => writeQueue.run(task),
    () => writeQueue.run(task),
  )
  switching = result.catch(() => undefined)
  return result
}

/** 关闭当前书（回到书库页） */
export async function closeBook(): Promise<void> {
  await closeContext()
  clearGraphCache()
  clearRuns()
  clearJobs()
}
