import { countWords, sanitizeRewrittenSegment } from '@inkloom/core'
import { buildRewriteMessages } from '@inkloom/prompt'
import { blueprintSchema, InkloomError } from '@inkloom/shared'
import { chat } from '../llm/deepseek.js'
import type { FetchLike } from '../llm/types.js'
import { readJsonElement } from '../storage/elements.js'
import { readSceneFile } from '../storage/scenes.js'
import { getContext } from './context.js'
import { editSceneSeg } from './scene-review-service.js'

export interface RewriteSceneSegOptions {
  chapterNo: number
  sceneNo: number
  version: number
  segId: string
  /** 用户的额外要求，如「更克制」 */
  guidance?: string
  apiKey: string
  model?: string
  fetchImpl?: FetchLike
}

export interface RewriteSceneSegResult {
  newVersion: number
  relPath: string
  original: string
  rewritten: string
}

/** core 只给判定，中文措辞在这一层（core 不背文案） */
const REASON_TEXT: Record<string, string> = {
  empty: '模型返回为空（或只剩标点），已放弃落盘',
  too_short: '模型输出不足原文 40%，可能删掉了情节，已放弃落盘',
  too_long: '模型输出超过原文 300%，可能改成了扩写，已放弃落盘',
  has_marker: '模型输出里含段标记，说明它写的是整段场景而不是这一段，已放弃落盘',
}

const pad3 = (n: number): string => String(n).padStart(3, '0')

/**
 * 局部重写：让模型改写场景里的一段，产物作为新版本候选。
 *
 * ★ 落盘复用 editSceneSeg，不新开写盘路径——
 *   「旧版本整版 rejected、段 ID 不变、Git 提交」这些规则只有一处实现。
 * ★ 校验在写盘之前：不过关就不产生任何文件，不允许先写后删。
 */
export async function rewriteSceneSeg(
  opts: RewriteSceneSegOptions,
): Promise<RewriteSceneSegResult> {
  const { root, db, project } = getContext()

  const scene = await readSceneFile(root, opts.chapterNo, opts.sceneNo, opts.version)
  if (scene === null) {
    throw new InkloomError(
      'NOT_FOUND',
      `第 ${opts.chapterNo} 章场景 ${opts.sceneNo} v${opts.version} 的文件不存在`,
    )
  }

  const idx = scene.segments.findIndex((s) => s.segId === opts.segId)
  if (idx < 0) {
    throw new InkloomError(
      'NOT_FOUND',
      `第 ${opts.chapterNo} 章场景 ${opts.sceneNo} v${opts.version} 里没有段 ${opts.segId}`,
    )
  }

  // 定稿后正文不可再变：先查清楚，别让用户等完 40 秒才被拒
  const chapter = await db.chapter.findFirst({
    where: { projectId: project.id, chapterNo: opts.chapterNo },
    select: { status: true },
  })
  if (chapter?.status === 'finalized') {
    throw new InkloomError(
      'CONFLICT',
      `第 ${opts.chapterNo} 章已定稿，需先 unfinalize 才能重写`,
    )
  }

  const blueprint = await readBlueprint(root, opts.chapterNo)
  const original = scene.segments[idx]?.text ?? ''
  const messages = buildRewriteMessages({
    chapterNo: opts.chapterNo,
    sceneNo: opts.sceneNo,
    sceneGoal: blueprint?.goal ?? null,
    conflict: blueprint?.conflict ?? null,
    hook: blueprint?.hook ?? null,
    prevText: scene.segments[idx - 1]?.text ?? null,
    nextText: scene.segments[idx + 1]?.text ?? null,
    original,
    guidance: opts.guidance ?? null,
  })

  const r = await chat({
    apiKey: opts.apiKey,
    model: opts.model ?? 'deepseek-flash',
    messages,
    // 段一般 100–400 字；×4 再留 1024 给推理模型的思考空间
    maxTokens: Math.ceil(countWords(original) * 4) + 1024,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  })

  const verdict = sanitizeRewrittenSegment(r.content, original)
  if (!verdict.ok) {
    throw new InkloomError('INVALID_INPUT', REASON_TEXT[verdict.reason] ?? verdict.reason)
  }

  const { newVersion, relPath } = await editSceneSeg({
    chapterNo: opts.chapterNo,
    sceneNo: opts.sceneNo,
    version: opts.version,
    segId: opts.segId,
    newText: verdict.text,
  })

  return { newVersion, relPath, original, rewritten: verdict.text }
}

/** 蓝图缺失或坏掉都不阻塞重写：少一点上下文而已，不该让整件事失败 */
async function readBlueprint(
  root: string,
  chapterNo: number,
): Promise<{ goal: string; conflict: string; hook: string | null } | null> {
  const raw = await readJsonElement(root, `story/blueprints/ch-${pad3(chapterNo)}.json`)
  if (raw === null) return null
  const parsed = blueprintSchema.safeParse(raw)
  if (!parsed.success) return null
  const b = parsed.data
  return { goal: b.goal, conflict: b.conflict, hook: b.hook ?? null }
}
