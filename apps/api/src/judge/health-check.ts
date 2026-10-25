import { type JudgeProvider, type JudgeRequest, shouldInject } from '@inkloom/core'
import { getContext } from '../services/context.js'
import { listChapterScenes } from '../services/scene-review-service.js'
import { readSceneFile } from '../storage/scenes.js'

export type FindingKind = 'slop' | 'pace' | 'consistency'

export interface HealthFinding {
  sceneNo: number
  version: number
  kind: FindingKind
  value: string | number | boolean
  confidence: number
  /** 置信度够不够写进 prompt（ADR-29：< 0.75 不注入） */
  injectable: boolean
}

export interface HealthReport {
  chapterNo: number
  enabled: boolean
  /** provider 的 id；关闭时为 null */
  provider: string | null
  findings: HealthFinding[]
  /** 判断层不可用时的说明：跳过判断，不阻塞任何写操作（spec §4.16） */
  degraded: string | null
}

/** 每个场景最多问三个问题；场景上限避免一章几十场景时一次发太多 */
const MAX_SCENES = 8

const QUESTIONS: { kind: FindingKind; build: (text: string) => JudgeRequest }[] = [
  {
    kind: 'slop',
    build: (text) => ({
      primitive: 'score',
      question: '这段文字有多像 AI 写的？1 = 完全像人写的，5 = 明显像 AI',
      scale: [1, 5],
      context: text,
    }),
  },
  {
    kind: 'pace',
    build: (text) => ({
      primitive: 'score',
      question: '这段的节奏如何？1 = 拖沓，5 = 过长过快',
      scale: [1, 5],
      context: text,
    }),
  },
  {
    kind: 'consistency',
    build: (text) => ({
      primitive: 'noul',
      question: '这段是否与已设定的角色状态或世界规则冲突？',
      context: text,
    }),
  },
]

/**
 * 对一章做判断层体检。
 *
 * ★ 只读：不改任何文件、不写索引。判断层的输出默认是「建议」，
 *   写不写进 prompt 由后续阶段按置信度决定（ADR-29）。
 * ★ 判断层失败（超时/不可用）不让整件事失败：返回 degraded 说明，
 *   调用方照常往下走（spec §4.16 的降级策略）。
 */
export async function checkChapter(opts: {
  chapterNo: number
  provider: JudgeProvider | null
}): Promise<HealthReport> {
  const base: HealthReport = {
    chapterNo: opts.chapterNo,
    enabled: opts.provider !== null,
    provider: opts.provider?.id ?? null,
    findings: [],
    degraded: null,
  }
  if (opts.provider === null) return base

  const { root } = getContext()
  const scenes = (await listChapterScenes(opts.chapterNo)).slice(0, MAX_SCENES)
  if (scenes.length === 0) return base

  const requests: JudgeRequest[] = []
  const index: { sceneNo: number; version: number; kind: FindingKind }[] = []

  for (const row of scenes) {
    const file = await readSceneFile(root, opts.chapterNo, row.sceneNo, row.version)
    if (file === null) continue
    const text = file.segments.map((s) => s.text).join('\n\n')
    for (const q of QUESTIONS) {
      requests.push(q.build(text))
      index.push({ sceneNo: row.sceneNo, version: row.version, kind: q.kind })
    }
  }

  try {
    const results = await opts.provider.judge(requests)
    base.findings = results.map((r, i) => {
      const meta = index[i] ?? { sceneNo: 0, version: 0, kind: 'slop' as const }
      return {
        sceneNo: meta.sceneNo,
        version: meta.version,
        kind: meta.kind,
        value: r.value,
        confidence: r.confidence,
        injectable: shouldInject(r),
      }
    })
  } catch (e) {
    // ★ 降级：判断层挂了不阻塞写作，只如实说明
    base.degraded = e instanceof Error ? e.message : String(e)
  }
  return base
}
