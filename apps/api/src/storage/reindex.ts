import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { countWords, parseChapterFile, parseSceneFile, type SceneFile } from '@inkloom/core'
import { InkloomError } from '@inkloom/shared'
import type { IndexDb } from '../index-db/client.js'
import { hashContent } from './atomic-write.js'
import { readJsonArray, readJsonElement } from './elements.js'
import { bookPaths } from './paths.js'
import { parseRevisionRelPath, readAllRevisionFiles } from './revisions.js'

export interface ReindexReport {
  projects: number
  characters: number
  worldRules: number
  blueprints: number
  plotThreads: number
  chapters: number
  segments: number
  revisions: number
  warnings: string[]
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function num0(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

function str0(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/**
 * 从文件重建索引（P0-18）。
 *
 * 设计前提：**索引里的一切都可丢弃**。所以先清空，再从文件读。
 * 扫描范围（spec §2.6 索引重建）：
 *   .json  → Project / Character / WorldRule / Blueprint / PlotThread / …
 *   .md    → Chapter / DraftSegment（含段标记解析）
 *   .jsonl → EntityRevision（★ 上一轮审查的阻塞点：原设计漏了它）
 *
 * 容错策略：单个文件坏 → 记 warning 并跳过，绝不中断整个重建。
 * 理由：宁可索引少一条（可再修），也不能让用户卡在「重建失败」上无法启动。
 */
export async function reindex(root: string, db: IndexDb): Promise<ReindexReport> {
  const paths = bookPaths(root)
  const warnings: string[] = []

  // 1. 清空（顺序：先子后父，避免外键冲突）
  await db.draftSegment.deleteMany()
  await db.chapter.deleteMany()
  await db.scenePlan.deleteMany()
  await db.entityRevision.deleteMany()
  await db.characterRelation.deleteMany()
  await db.characterSignature.deleteMany()
  await db.character.deleteMany()
  await db.worldRule.deleteMany()
  await db.powerTier.deleteMany()
  await db.powerSystem.deleteMany()
  await db.blueprint.deleteMany()
  await db.plotThread.deleteMany()
  await db.storyArc.deleteMany()
  await db.styleAsset.deleteMany()
  await db.writingTechnique.deleteMany()
  await db.location.deleteMany()
  await db.route.deleteMany()
  await db.loreReference.deleteMany()
  await db.project.deleteMany()

  const report: ReindexReport = {
    projects: 0,
    characters: 0,
    worldRules: 0,
    blueprints: 0,
    plotThreads: 0,
    chapters: 0,
    segments: 0,
    revisions: 0,
    warnings,
  }

  // 2. Project
  const novel = await readJsonElement(root, 'novel.json')
  if (novel === null) {
    throw new InkloomError('NOT_FOUND', 'novel.json 不存在，无法重建索引')
  }
  const p = asRecord(novel)
  const projectId = String(p['id'])
  await db.project.create({
    data: {
      id: projectId,
      folderId: String(p['folderId']),
      rootPath: str0(p['rootPath']) ?? root.split('\\').join('/'),
      name: str0(p['name']) ?? '',
      genre: str0(p['genre']) ?? '',
      subGenre: str0(p['subGenre']),
      totalChapters: num0(p['totalChapters']),
      wordsPerChapter: num0(p['wordsPerChapter']),
      coreIdea: str0(p['coreIdea']),
      premise: str0(p['premise']),
      theme: str0(p['theme']),
      toneContract: str0(p['toneContract']),
      anchorLocked: p['anchorLocked'] === true,
      status: str0(p['status']) ?? 'draft',
    },
  })
  report.projects = 1

  // 3. 角色
  for (const raw of await readJsonArray(root, 'characters/index.json')) {
    const c = asRecord(raw)
    const id = str0(c['id'])
    if (id === null) {
      warnings.push('characters/index.json 有一条缺少 id，已跳过')
      continue
    }
    try {
      await db.character.create({
        data: {
          id,
          projectId,
          name: str0(c['name']) ?? '',
          role: str0(c['role']) ?? 'minor',
          gender: str0(c['gender']),
          age: str0(c['age']),
          appearance: str0(c['appearance']),
          personality: str0(c['personality']),
          background: str0(c['background']),
          abilities: str0(c['abilities']),
          motivation: str0(c['motivation']),
          arc: str0(c['arc']),
          curLocation: str0(c['curLocation']),
          curTierId: str0(c['curTierId']),
          curPhysical: str0(c['curPhysical']),
          curMental: str0(c['curMental']),
          curItems: str0(c['curItems']),
          curEvents: str0(c['curEvents']),
          stateChapter: num0(c['stateChapter']),
          stateProvenance: str0(c['stateProvenance']),
          stateStale: c['stateStale'] === true,
          visualAnchor: str0(c['visualAnchor']),
        },
      })
      report.characters += 1
    } catch (e) {
      warnings.push(`角色 ${id} 写入失败：${(e as Error).message}`)
    }
  }

  // 4. 世界规则 / 地点 / 路线
  for (const raw of await readJsonArray(root, 'world/rules.json')) {
    const r = asRecord(raw)
    const id = str0(r['id'])
    if (id === null) continue
    try {
      await db.worldRule.create({
        data: {
          id,
          projectId,
          category: str0(r['category']) ?? 'power',
          name: str0(r['name']) ?? '',
          content: str0(r['content']) ?? '',
          priority: str0(r['priority']) ?? 'soft',
        },
      })
      report.worldRules += 1
    } catch (e) {
      warnings.push(`世界规则 ${id} 写入失败：${(e as Error).message}`)
    }
  }
  for (const raw of await readJsonArray(root, 'world/locations.json')) {
    const l = asRecord(raw)
    const id = str0(l['id'])
    if (id === null) continue
    try {
      await db.location.create({
        data: {
          id,
          projectId,
          name: str0(l['name']) ?? '',
          type: str0(l['type']) ?? 'plain',
          region: str0(l['region']),
        },
      })
    } catch (e) {
      warnings.push(`地点 ${id} 写入失败：${(e as Error).message}`)
    }
  }
  for (const raw of await readJsonArray(root, 'world/routes.json')) {
    const r = asRecord(raw)
    const id = str0(r['id'])
    if (id === null) continue
    try {
      await db.route.create({
        data: {
          id,
          projectId,
          fromId: str0(r['fromId']) ?? '',
          toId: str0(r['toId']) ?? '',
          mode: str0(r['mode']) ?? 'walk',
          days: num0(r['days']) ?? 1,
          condition: str0(r['condition']),
          bidirectional: r['bidirectional'] !== false,
        },
      })
    } catch (e) {
      warnings.push(`路线 ${id} 写入失败：${(e as Error).message}`)
    }
  }

  // 5. 蓝图（每章一个文件）
  for (const name of await listDir(join(paths.story, 'blueprints'))) {
    if (!name.endsWith('.json')) continue
    const rel = `story/blueprints/${name}`
    let b: Record<string, unknown>
    try {
      b = asRecord(await readJsonElement(root, rel))
    } catch (e) {
      warnings.push(`${rel} 读取失败：${(e as Error).message}`)
      continue
    }
    const id = str0(b['id'])
    const chapterNo = num0(b['chapterNo'])
    if (id === null || chapterNo === null) {
      warnings.push(`${rel} 缺少 id 或 chapterNo，已跳过`)
      continue
    }
    try {
      await db.blueprint.create({
        data: {
          id,
          projectId,
          chapterNo,
          title: str0(b['title']),
          goal: str0(b['goal']) ?? '',
          conflict: str0(b['conflict']) ?? '',
          turn: str0(b['turn']),
          hook: str0(b['hook']) ?? '',
          castIds: JSON.stringify(b['castIds'] ?? []),
          locationId: str0(b['locationId']),
          storyDay: num0(b['storyDay']),
          storyTime: str0(b['storyTime']),
          beatType: str0(b['beatType']) ?? 'rising',
          tensionLevel: num0(b['tensionLevel']) ?? 3,
          userGuidance: str0(b['userGuidance']),
        },
      })
      report.blueprints += 1
    } catch (e) {
      warnings.push(`${rel} 写入失败：${(e as Error).message}`)
    }
  }

  // 6. 剧情线索
  for (const raw of await readJsonArray(root, 'story/threads.json')) {
    const t = asRecord(raw)
    const id = str0(t['id'])
    if (id === null) continue
    try {
      await db.plotThread.create({
        data: {
          id,
          projectId,
          kind: str0(t['kind']) ?? 'setup',
          title: str0(t['title']) ?? '',
          plantedChapter: num0(t['plantedChapter']),
          advancedChapters: JSON.stringify(t['advancedChapters'] ?? []),
          resolvedChapter: num0(t['resolvedChapter']),
          status: str0(t['status']) ?? 'active',
          payoffHint: str0(t['payoffHint']),
          payoffWindow: num0(t['payoffWindow']),
        },
      })
      report.plotThreads += 1
    } catch (e) {
      warnings.push(`线索 ${id} 写入失败：${(e as Error).message}`)
    }
  }

  // 7. 章文件 → Chapter
  for (const name of await listDir(paths.chapters)) {
    const match = /^ch-(\d+)\.md$/.exec(name)
    if (match?.[1] === undefined) continue
    const chapterNo = Number(match[1])
    const raw = await readFile(join(paths.chapters, name), 'utf8')
    try {
      const parsed = parseChapterFile(raw)
      await db.chapter.create({
        data: {
          id: `ch_${chapterNo}`,
          projectId,
          chapterNo,
          title: parsed.title,
          status: 'finalized',
          finalizedAt: new Date(),
          summaryStale: true,
        },
      })
      report.chapters += 1
    } catch (e) {
      warnings.push(`${name} 解析失败：${(e as Error).message}`)
    }
  }

  // 8. 场景候选文件 → DraftSegment
  for (const dirName of await listDir(paths.chapters)) {
    const dirMatch = /^ch-(\d+)$/.exec(dirName)
    if (dirMatch?.[1] === undefined) continue
    const chapterNo = Number(dirMatch[1])
    for (const fileName of await listDir(join(paths.chapters, dirName, 'scenes'))) {
      const m = /^s(\d+)\.v(\d+)\.md$/.exec(fileName)
      if (m?.[1] === undefined || m[2] === undefined) continue
      const sceneNo = Number(m[1])
      const rel = `chapters/${dirName}/scenes/${fileName}`
      const raw = await readFile(join(root, rel), 'utf8')
      let scene: SceneFile
      try {
        scene = parseSceneFile(raw)
      } catch (e) {
        warnings.push(`${rel} 解析失败：${(e as Error).message}`)
        continue
      }
      for (let i = 0; i < scene.segments.length; i++) {
        const seg = scene.segments[i]
        if (seg === undefined) continue
        try {
          await db.draftSegment.create({
            data: {
              // ❗id 必须带 version：同一段会同时存在于 v1 和 v2 两个文件里，
              //   不带 version 会让 v2 的段主键冲突、被下游 catch 静默吞掉。
              id: `seg_${chapterNo}_${sceneNo}_${scene.version}_${seg.segId}`,
              projectId,
              chapterNo,
              sceneNo,
              segId: seg.segId,
              seq: i,
              filePath: rel,
              contentHash: hashContent(seg.text),
              // ❗字数必须算：不然 `scenes` 显示 0 字，用户无法判断候选稿多长
              wordCount: countWords(seg.text),
              status: 'candidate',
            },
          })
          report.segments += 1
        } catch (e) {
          warnings.push(`${rel} 段 ${seg.segId} 写入失败：${(e as Error).message}`)
        }
      }
    }
  }

  // 9. EntityRevision（★ 从 .jsonl 重建）
  for (const rel of await readAllRevisionFiles(root)) {
    const ids = parseRevisionRelPath(rel)
    if (ids === null) {
      warnings.push(`revision 文件名不合格式：${rel}`)
      continue
    }
    const raw = await readFile(join(root, rel), 'utf8')
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (t.length === 0) continue
      try {
        const r = JSON.parse(t) as Record<string, unknown>
        await db.entityRevision.create({
          data: {
            id: String(r['id']),
            projectId,
            entityType: String(r['entityType']),
            entityId: String(r['entityId']),
            version: Number(r['version']),
            parentRevisionId: str0(r['parentRevisionId']),
            payload: String(r['payload']),
            changeSource: String(r['changeSource']),
            changeReason: str0(r['changeReason']),
            generationRunId: str0(r['generationRunId']),
          },
        })
        report.revisions += 1
      } catch (e) {
        warnings.push(`${rel} 中一条 revision 写入失败：${(e as Error).message}`)
      }
    }
  }

  return report
}
