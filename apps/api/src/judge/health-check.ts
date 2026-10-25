import {
  type JudgeProvider,
  type JudgeRequest,
  type JudgeResult,
  shouldInject,
} from '@inkloom/core'
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
  // 提到闭包外：Promise.all 的回调里 TS 拿不到上面的 narrowing
  const provider = opts.provider

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
    // ★ 按 context 分组后逐组调用：JEV 的 state 是「一段被判断的文本」，
    //   把不同场景混在一次请求里，模型会拿 A 场景的正文去答 B 场景的问题。
    const groups = new Map<string, number[]>()
    requests.forEach((req, i) => {
      const list = groups.get(req.context) ?? []
      list.push(i)
      groups.set(req.context, list)
    })

    const results: (JudgeResult | undefined)[] = []
    // ★ 组间并行：每组只关心自己的正文，彼此无依赖。
    //   串行的话 5 个场景要 30 秒以上，界面看起来像卡住了。
    const settled = await Promise.all(
      [...groups.values()].map(async (idxList) => {
        const groupReqs = idxList
          .map((i) => requests[i])
          .filter((r): r is JudgeRequest => r !== undefined)
        return { idxList, groupResults: await provider.judge(groupReqs) }
      }),
    )
    for (const { idxList, groupResults } of settled) {
      idxList.forEach((globalIdx, j) => {
        results[globalIdx] = groupResults[j]
      })
    }

    base.findings = results.map((r, i) => {
      const meta = index[i] ?? { sceneNo: 0, version: 0, kind: 'slop' as const }
      return {
        sceneNo: meta.sceneNo,
        version: meta.version,
        kind: meta.kind,
        value: r?.value ?? '',
        confidence: r?.confidence ?? 0,
        injectable: r === undefined ? false : shouldInject(r),
      }
    })
  } catch (e) {
    // ★ 降级：判断层挂了不阻塞写作，只如实说明
    base.degraded = e instanceof Error ? e.message : String(e)
  }
  return base
}
