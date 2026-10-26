import { randomUUID } from 'node:crypto'
import { countWords, newSegId, type SceneFile, splitScenes, toSegments } from '@inkloom/core'
import { assemble, DEFAULT_BUDGET } from '@inkloom/prompt'
import { commitAll, initRepo } from '../git/runner.js'
import { chat } from '../llm/deepseek.js'
import { type FetchLike, LlmError } from '../llm/types.js'
import { hashContent } from '../storage/atomic-write.js'
import {
  collectChapterSegIds,
  latestSceneVersion,
  readSceneFile,
  writeSceneFile,
} from '../storage/scenes.js'
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
  usage: { input: number; output: number; reasoning: number; cacheHit: number }
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

  // 全程可追加的告警（最终写进 run.warnings 并回传给调用方）
  const warnings: string[] = []

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
  //
  // ★ max_tokens 必须把 reasoning 算进去：deepseek-flash 是推理模型，
  //   completion_tokens = reasoning + 正文，两者共用 max_tokens 额度。
  //   实测设 words×2.5（2000 字→5000）时：一次撞满截断只剩 3 个场景，
  //   两次 thinking 吃完全部额度、content 直接为空（EMPTY）。
  //   按 words×6 给足（2000 字→12000，约 8000 字 + 思考空间）。
  const wordsPerChapter = loaded.input.project.wordsPerChapter ?? 3000
  const maxTokens = Math.ceil(wordsPerChapter * 6)
  let content: string
  let usage: { input: number; output: number; reasoning: number; cacheHit: number }
  let truncated = false
  try {
    const r = await chat({
      apiKey: opts.apiKey,
      model,
      messages: assembled.messages,
      maxTokens,
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    })
    content = r.content
    usage = r.usage
    // ★ finish_reason=length 说明撞到了 max_tokens，输出被硬截断。
    //  实测：三条硬约束冲突时模型会一直写到上限，最后一个场景只剩 160 字。
    //  不能当成功处理，否则用户会拿到残缺章节还不知道。
    truncated = r.finishReason === 'length'
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
  warnings.push(...split.warnings)
  if (truncated) {
    warnings.push(
      `输出撞到 max_tokens（${maxTokens}）被截断，最后一个场景很可能不完整，建议重生成或改小目标字数`,
    )
  }

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
      : truncated
        ? 'output_truncated'
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

export interface RewriteSceneOptions {
  chapterNo: number
  sceneNo: number
  apiKey: string
  /** 作者对这一次重写的具体要求 */
  guidance?: string
  model?: string
  fetchImpl?: FetchLike
}

export interface RewriteSceneResult {
  runId: string
  chapterNo: number
  scene: GeneratedScene
  usage: { input: number; output: number; reasoning: number; cacheHit: number }
}

/**
 * 整场重写（spec §4.13 场景卡「↻ 重写」）。
 *
 * ★ 与「重写这段」的区别：段级保持段 ID 不变（用于精修一两句），
 *   整场重写产生新版本、全新段 ID（用于「这一场整体不对」）。
 *   两者不能合并：段 ID 是跨章引用的锚，整场换版就该换锚。
 * ★ 仍然走同一套装配：蓝图、世界规则、角色状态、文风样本一个不落——
 *   否则重写出来的东西会和全书脱节。
 * ★ 用原来的场景正文作为参考而不是约束：告诉模型「事件可以沿用，字句不必保留」。
 */
export async function rewriteScene(opts: RewriteSceneOptions): Promise<RewriteSceneResult> {
  const { root, db, project } = getContext()

  const loaded = await loadChapterContext(opts.chapterNo, {
    ...(opts.guidance === undefined ? {} : { userGuidance: opts.guidance }),
  })
  const assembled = assemble(loaded.input, DEFAULT_BUDGET)

  const latest = await latestSceneVersion(root, opts.chapterNo, opts.sceneNo)
  const current =
    latest === null ? null : await readSceneFile(root, opts.chapterNo, opts.sceneNo, latest)
  const original = current === null ? '' : current.segments.map((s) => s.text).join('\n\n')

  const instruction = [
    `【本次只重写第 ${opts.sceneNo} 场】`,
    '只输出这一场的正文。不要写章节标题，不要输出其他场景，不要使用场景分隔标记。',
    original === '' ? '' : `以下是这一场的当前稿，可参考其事件，不必保留字句：\n\n${original}`,
    opts.guidance === undefined || opts.guidance.trim() === ''
      ? ''
      : `额外要求：${opts.guidance.trim()}`,
  ]
    .filter((x) => x !== '')
    .join('\n\n')

  const messages = [...assembled.messages, { role: 'user' as const, content: instruction }]

  const runId = newRunId()
  const model = opts.model ?? 'deepseek-flash'
  await db.generationRun.create({
    data: {
      id: runId,
      projectId: project.id,
      chapterNo: opts.chapterNo,
      commitState: 'pending',
      purpose: 'rewrite_scene',
      provider: 'deepseek',
      model,
      params: JSON.stringify({ sceneNo: opts.sceneNo }),
      assembledPrompt: JSON.stringify(messages),
      tokenEstimate: assembled.tokenEstimate,
      status: 'running',
    },
  })

  const wordsPerChapter = loaded.input.project.wordsPerChapter ?? 3000
  // 单场大约是整章的三分之一，按 words×6 给足（含 reasoning 额度）
  const maxTokens = Math.ceil((wordsPerChapter / 3) * 6)

  let content: string
  let usage: RewriteSceneResult['usage']
  try {
    const r = await chat({
      apiKey: opts.apiKey,
      model,
      messages,
      maxTokens,
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

  // 模型偶尔仍会带围栏或「第一场」标题，去掉它们，否则正文里会出现假标题
  const text = content
    .replace(/^```[a-z]*\r?\n?/i, '')
    .replace(/```\s*$/, '')
    .replace(/^第[一二三四五六七八九十百\d]+场[^\n]*\r?\n+/, '')
    .trim()

  const paragraphs = toSegments(text)
  if (paragraphs.length === 0) {
    await db.generationRun.update({
      where: { id: runId },
      data: { status: 'failed', errorMessage: 'EMPTY: 重写结果为空', finishedAt: new Date() },
    })
    throw new Error('EMPTY: 重写结果为空')
  }

  const taken = await collectChapterSegIds(root, opts.chapterNo)
  const segments = paragraphs.map((t) => {
    const segId = newSegId(Math.random, taken)
    taken.add(segId)
    return { segId, text: t }
  })

  const version = (latest ?? 0) + 1
  const scene: SceneFile = { sceneNo: opts.sceneNo, version, segments }
  const { relPath } = await writeSceneFile(root, scene, opts.chapterNo)

  await db.draftSegment.createMany({
    data: segments.map((s, seq) => ({
      id: `seg_${opts.chapterNo}_${opts.sceneNo}_${version}_${s.segId}`,
      projectId: project.id,
      chapterNo: opts.chapterNo,
      sceneNo: opts.sceneNo,
      segId: s.segId,
      seq,
      filePath: relPath,
      contentHash: hashContent(s.text),
      wordCount: countWords(s.text),
      status: 'candidate',
      sourceRunId: runId,
    })),
  })

  const wordCount = segments.reduce((n, s) => n + countWords(s.text), 0)
  await db.generationRun.update({
    where: { id: runId },
    data: {
      status: 'success',
      finishedAt: new Date(),
      usageInput: usage.input,
      usageOutput: usage.output + usage.reasoning,
      cacheHitTokens: usage.cacheHit,
      commitState: 'done',
    },
  })

  await commitAll(root, `feat(scene): ch${opts.chapterNo} s${opts.sceneNo} v${version} 整场重写`)

  return {
    runId,
    chapterNo: opts.chapterNo,
    scene: {
      sceneNo: opts.sceneNo,
      version,
      relPath,
      wordCount,
      segCount: segments.length,
    },
    usage,
  }
}
