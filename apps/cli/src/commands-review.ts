import { diffText, renderDiffHints, summarizeDiff } from '@inkloom/core'
import { getContext } from '../../api/src/services/context.js'
import { finalizeChapter, unfinalizeChapter } from '../../api/src/services/finalize-service.js'
import {
  acceptScene,
  editSceneSeg,
  listChapterScenes,
  rejectScene,
} from '../../api/src/services/scene-review-service.js'
import {
  applyStateProposals,
  loadLatestProposals,
  proposeStateChanges,
} from '../../api/src/services/state-proposal-service.js'
import { readSceneFile } from '../../api/src/storage/scenes.js'
import { type CommandCtx, withBook } from './commands.js'
import { requireFlag, requirePositional } from './flags.js'

/**
 * 审阅与定稿命令（P1-b）。
 *
 * ★ 单独成文件：9 个命令加进 commands.ts 会让它超过 500 行（spec §9.2 的 CI 上限）。
 */

/** inkloom scenes <dir> --chapter N */
export async function scenes({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom scenes <dir> --chapter N')
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const rows = await withBook(dir, () => listChapterScenes(chapterNo))
  if (rows.length === 0) {
    console.log(`第 ${chapterNo} 章还没有候选场景，先跑 write`)
    return
  }
  console.log(`第 ${chapterNo} 章场景（${rows.length} 个版本）`)
  for (const r of rows) {
    const mark = r.status === 'accepted' ? '✓' : r.status === 'rejected' ? '✗' : '·'
    console.log(
      `  ${mark} 场景 ${r.sceneNo}  v${r.version}  ${r.wordCount} 字 / ${r.segCount} 段  ${r.status}`,
    )
  }
}

/** inkloom accept <dir> --chapter N --scene M --version V */
export async function accept({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom accept <dir> --chapter N --scene M --version V',
  )
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const sceneNo = Number(requireFlag(flags, 'scene'))
  const version = Number(requireFlag(flags, 'version'))
  const r = await withBook(dir, () => acceptScene({ chapterNo, sceneNo, version }))
  console.log(`✓ 接受 场景 ${sceneNo} v${version}  → ${r.relPath}`)
  console.log('  同场景其它 accepted 版本已自动降为 rejected（Ruling 36）')
}

/** inkloom reject <dir> --chapter N --scene M --version V */
export async function reject({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom reject <dir> --chapter N --scene M --version V',
  )
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const sceneNo = Number(requireFlag(flags, 'scene'))
  const version = Number(requireFlag(flags, 'version'))
  await withBook(dir, () => rejectScene({ chapterNo, sceneNo, version }))
  console.log(`✗ 拒绝 场景 ${sceneNo} v${version}（文件保留，可再接受）`)
}

/** inkloom edit <dir> --chapter N --scene M --version V --seg XXXX --text "…" */
export async function edit({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom edit <dir> --chapter N --scene M --version V --seg XXXX --text "…"',
  )
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const sceneNo = Number(requireFlag(flags, 'scene'))
  const version = Number(requireFlag(flags, 'version'))
  const segId = requireFlag(flags, 'seg')
  const text = requireFlag(flags, 'text')
  const r = await withBook(dir, () =>
    editSceneSeg({ chapterNo, sceneNo, version, segId, newText: text }),
  )
  console.log(`✓ 段 ${segId} 已改 → 场景 ${sceneNo} v${r.newVersion}（${r.relPath}）`)
  console.log('  新版本状态 candidate，旧版本整版 rejected')
}

/** inkloom diff <dir> --chapter N --scene M --from V1 --to V2 */
export async function diffScene({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom diff <dir> --chapter N --scene M --from V1 --to V2',
  )
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const sceneNo = Number(requireFlag(flags, 'scene'))
  const from = Number(requireFlag(flags, 'from'))
  const to = Number(requireFlag(flags, 'to'))

  await withBook(dir, async () => {
    const { root } = getContext()
    const a = await readSceneFile(root, chapterNo, sceneNo, from)
    const b = await readSceneFile(root, chapterNo, sceneNo, to)
    if (a === null || b === null) {
      throw new Error(`场景 ${sceneNo} 的 v${a === null ? from : to} 不存在`)
    }
    const oldText = a.segments.map((s) => s.text).join('\n\n')
    const newText = b.segments.map((s) => s.text).join('\n\n')
    const spans = diffText(oldText, newText)
    const s = summarizeDiff(spans)
    console.log(`场景 ${sceneNo}  v${from} → v${to}`)
    console.log(
      `  相似度 ${(s.similarity * 100).toFixed(1)}%   新增 ${s.addedChars} 字   删除 ${s.removedChars} 字`,
    )
    const hints = renderDiffHints(spans, 40)
    if (hints.length === 0) {
      console.log('  两个版本内容完全相同')
      return
    }
    for (const h of hints) console.log(`  ${h}`)
    console.log('\n（diff 只用于展示，落库以你接受哪个版本为准）')
  })
}

/** inkloom finalize <dir> --chapter N [--title "…"] */
export async function finalize({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom finalize <dir> --chapter N [--title "…"]')
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const r = await withBook(dir, () =>
    finalizeChapter({
      chapterNo,
      ...(flags['title'] === undefined ? {} : { title: flags['title'] }),
    }),
  )
  console.log(`✓ 第 ${chapterNo} 章已定稿`)
  console.log(`  正文    = ${r.relPath}`)
  console.log(`  字数    = ${r.wordCount}`)
  console.log(`  场景数  = ${r.sceneCount}`)
  if (r.summary.length > 0) console.log(`  摘要    = ${r.summary}`)
  console.log('  下一步：inkloom propose 提取状态变更（可选）')
}

/** inkloom unfinalize <dir> --chapter N */
export async function unfinalize({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom unfinalize <dir> --chapter N')
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  await withBook(dir, () => unfinalizeChapter({ chapterNo }))
  console.log(`✓ 第 ${chapterNo} 章已撤销定稿（finalized → review），正文文件保留`)
}

/** inkloom propose <dir> --chapter N */
export async function propose({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(positional, 0, 'inkloom propose <dir> --chapter N')
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const apiKey = process.env['DEEPSEEK_API_KEY']
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error('缺少 DEEPSEEK_API_KEY（见 .env.example）')
  }
  const r = await withBook(dir, () =>
    proposeStateChanges({
      chapterNo,
      apiKey,
      ...(flags['model'] === undefined ? {} : { model: flags['model'] }),
    }),
  )
  if (r.proposals.length === 0) {
    console.log('本章没有检测到角色状态变化')
  } else {
    console.log(`第 ${chapterNo} 章状态提案（${r.proposals.length} 条，全部未落库）`)
    for (const [i, p] of r.proposals.entries()) {
      console.log(`  ${i + 1}. ${p.characterName}（${p.characterId}）${p.field}`)
      console.log(`     → ${p.newValue}   自第 ${p.stateChapter} 章起生效`)
      console.log(`     证据：「${p.evidenceQuote}」`)
    }
    console.log('\n确认：inkloom apply-proposals <dir> --chapter N --accept all')
    console.log('只应用部分：inkloom apply-proposals <dir> --chapter N --accept 1,3')
  }
  if (r.unparsed.length > 0) {
    console.log(`\n⚠ 有 ${r.unparsed.length} 行无法解析：`)
    for (const u of r.unparsed) console.log(`  ${u}`)
  }
}

/** inkloom apply-proposals <dir> --chapter N --accept all|1,3 */
export async function applyProposals({ positional, flags }: CommandCtx): Promise<void> {
  const dir = requirePositional(
    positional,
    0,
    'inkloom apply-proposals <dir> --chapter N --accept all|1,3',
  )
  const chapterNo = Number(requireFlag(flags, 'chapter'))
  const spec = requireFlag(flags, 'accept')

  const proposals = await withBook(dir, () => loadLatestProposals(chapterNo))
  let acceptIds: string[]
  if (spec === 'all') {
    acceptIds = proposals.map((p) => p.id)
  } else {
    // 1-based 序号，逗号分隔
    const idx = spec
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= proposals.length)
    acceptIds = idx.map((n) => proposals[n - 1]?.id).filter((x): x is string => x !== undefined)
  }

  const r = await withBook(dir, () => applyStateProposals({ chapterNo, acceptIds }))
  console.log(`✓ 已应用 ${r.applied} 条，跳过 ${r.skipped} 条`)
  if (r.applied > 0) console.log('  已写入 EntityRevision（append-only，可回退到旧版本）')
}
