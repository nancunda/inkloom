import { randomUUID } from 'node:crypto'
import { countWords, newSegId, type SceneFile, splitScenes, toSegments } from '@inkloom/core'
import { assemble, DEFAULT_BUDGET } from '@inkloom/prompt'
import { commitAll, initRepo } from '../git/runner.js'
import { chat } from '../llm/deepseek.js'
import { type FetchLike, LlmError } from '../llm/types.js'
import { hashContent } from '../storage/atomic-write.js'
import { collectChapterSegIds, latestSceneVersion, writeSceneFile } from '../storage/scenes.js'
import { getContext } from './context.js'
import { loadChapterContext } from './context-loader.js'

export interface GenerateChapterOptions {
  chapterNo: number
  apiKey: string
  model?: string
  userGuidance?: string
  temperature?: number
  /** 注入假 fetch 用于集成测试（零网络） */
  fetchImpl?: FetchLike
}

export interface GeneratedScene {
  sceneNo: number
  version: number
  relPath: string
  wordCount: number
  segCount: number
}

export interface GenerateChapterResult {
  runId: string
  chapterNo: number
  strategy: 'marker' | 'heuristic' | 'whole'
  scenes: GeneratedScene[]
  tokenEstimate: number
  usage: { input: number; output: number; cacheHit: number }
  warnings: string[]
  degradedReason: string | null
}

function newRunId(): string {
  return `run_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/**
 * 生成一章（spec §4.1 九步）。
 *
 * 顺序不可换：
 *   1 装载 → 2 装配 → 3 建 run（先建，失败也有记录）
 *   → 4 调 LLM → 5 切分 → 6 落候选稿 + 索引 → 7 更新 run → 8 Git commit
 *
 * ★ run 必须在调 LLM **之前**建：否则模型超时/失败时没有任何记录，
 *   事后无法知道「那次到底发了什么 prompt」。
 * ★ 但装载失败要在建 run **之前**：蓝图都没有的请求不该留下垃圾 run。
 * ★ 候选稿必须进 Git（第 8 步）：正文历史归 Git，不 commit 等于没有版本。
 *   Git 失败只记 warning 不抛错——候选稿已经落盘，不该因为版本控制挂了就丢掉成果。
 */
export async function generateChapter(
  opts: GenerateChapterOptions,
): Promise<GenerateChapterResult> {
  const { root, db, project } = getContext()

  // 1. 装载（失败直接抛，不留 run）
  const loaded = await loadChapterContext(opts.chapterNo, {
    ...(opts.userGuidance === undefined ? {} : { userGuidance: opts.userGuidance }),
  })

  // 2. 装配
  const assembled = assemble(loaded.input, DEFAULT_BUDGET)

  // 3. 建 run
  const runId = newRunId()
  const model = opts.model ?? 'deepseek-flash'
  await db.generationRun.create({
    data: {
      id: runId,
      projectId: project.id,
      chapterNo: opts.chapterNo,
      commitState: 'pending',
      purpose: 'draft',
      provider: 'deepseek',
      model,
      params: JSON.stringify({ temperature: opts.temperature ?? null }),
      assembledPrompt: JSON.stringify(assembled.messages),
      tokenEstimate: assembled.tokenEstimate,
      status: 'running',
    },
  })

  // 4. 调 LLM
  let content: string
  let usage: { input: number; output: number; cacheHit: number }
  try {
    const r = await chat({
      apiKey: opts.apiKey,
      model,
      messages: assembled.messages,
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    })
    content = r.content
    usage = r.usage
  } catch (e) {
    const msg = e instanceof LlmError ? `${e.code}: ${e.message}` : (e as Error).message
    await db.generationRun.update({
      where: { id: runId },
      data: { status: 'failed', errorMessage: msg, finishedAt: new Date() },
    })
    throw e
  }

  // 5. 切分
  const split = splitScenes(content)

  // 6. 落候选稿 + 索引
  const taken = await collectChapterSegIds(root, opts.chapterNo)
  const scenes: GeneratedScene[] = []
  const warnings = [...split.warnings]

  for (let i = 0; i < split.scenes.length; i++) {
    const sceneNo = i + 1
    const paragraphs = toSegments(split.scenes[i] ?? '')
    if (paragraphs.length === 0) {
      warnings.push(`场景 ${sceneNo} 内容为空，已跳过`)
      continue
    }
    const segments = paragraphs.map((text) => {
      const segId = newSegId(Math.random, taken)
      taken.add(segId)
      return { segId, text }
    })

    // 场景版本 = 该场景已有最大版本 + 1（直接问文件，不靠索引反解）
    const latest = await latestSceneVersion(root, opts.chapterNo, sceneNo)
    const version = (latest ?? 0) + 1

    const scene: SceneFile = { sceneNo, version, segments }
    const { relPath } = await writeSceneFile(root, scene, opts.chapterNo)

    await db.draftSegment.createMany({
      data: segments.map((s, seq) => ({
        id: `seg_${opts.chapterNo}_${sceneNo}_${version}_${s.segId}`,
        projectId: project.id,
        chapterNo: opts.chapterNo,
        sceneNo,
        segId: s.segId,
        seq,
        filePath: relPath,
        // ★ 每段自己的 hash，不是整场景文件的 hash（spec §3.9：contentHash 是「该段」的）
        contentHash: hashContent(s.text),
        wordCount: countWords(s.text),
        status: 'candidate',
        sourceRunId: runId,
      })),
    })

    scenes.push({
      sceneNo,
      version,
      relPath,
      wordCount: segments.reduce((n, s) => n + countWords(s.text), 0),
      segCount: segments.length,
    })
  }

  // 7. 更新 run
  const degradedReason =
    assembled.degradation.length > 0
      ? assembled.degradation.map((d) => `${d.blockId}:${d.action}`).join(',')
      : split.strategy !== 'marker'
        ? `scene_split_fallback:${split.strategy}`
        : null

  await db.generationRun.update({
    where: { id: runId },
    data: {
      status: 'success',
      output: content,
      usageInput: usage.input,
      usageOutput: usage.output,
      cacheHitTokens: usage.cacheHit,
      commitState: 'committed',
      degradedReason,
      warnings: warnings.length > 0 ? JSON.stringify(warnings) : null,
      finishedAt: new Date(),
    },
  })

  // 8. 候选稿进 Git（spec §2.6 写入顺序第 5 步）
  try {
    await initRepo(root)
    await commitAll(root, `feat(scene): 第 ${opts.chapterNo} 章生成 ${scenes.length} 个场景候选`)
  } catch (e) {
    warnings.push(`Git 提交失败（候选稿已落盘）：${(e as Error).message}`)
  }

  return {
    runId,
    chapterNo: opts.chapterNo,
    strategy: split.strategy,
    scenes,
    tokenEstimate: assembled.tokenEstimate,
    usage,
    warnings,
    degradedReason,
  }
}
