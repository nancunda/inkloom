import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { InkloomError } from '@inkloom/shared'
import { createSiliconFlowImage, type ImageProvider } from '../assets/image-provider.js'
import { commitAll, initRepo } from '../git/runner.js'
import type { FetchLike } from '../llm/types.js'
import { getContext } from '../services/context.js'
import { readJsonElement } from '../storage/elements.js'
import { bookPaths } from '../storage/paths.js'

export interface PortraitOptions {
  characterId: string
  /** 风格后缀，默认国风插画 */
  style?: string
  apiKey: string
  model?: string
  fetchImpl?: FetchLike
  imageProvider?: ImageProvider
}

export interface PortraitResult {
  characterId: string
  name: string
  filePath: string
  provider: string
  model: string
  prompt: string
  visualAnchor: string
}

interface CharacterRow {
  id?: unknown
  name?: unknown
  appearance?: unknown
  visualAnchor?: unknown
  gender?: unknown
  age?: unknown
}

/**
 * 角色形象（P4）：从 visualAnchor 拼 prompt → 生图 → 落盘 → 记 Asset。
 *
 * ★ prompt 以 visualAnchor 为主、appearance 为辅：锚点是「每张图都必须
 *   一致的硬特征」，appearance 只是补充描述。顺序反了会漂。
 * ★ 图片存本地 `assets/characters/<id>.png`，Asset 行记下完整 prompt /
 *   provider / model / params —— 可复现是这一层的全部意义。
 * ★ 图片同时进 git：换机、克隆与回退时形象图不能丢（二进制直接存，不做 LFS）。
 */
export async function generatePortrait(opts: PortraitOptions): Promise<PortraitResult> {
  const { root, db, project } = getContext()
  await initRepo(root)

  const raw = await readJsonElement(root, 'characters/index.json')
  const list = Array.isArray(raw) ? (raw as CharacterRow[]) : []
  const char = list.find((c) => c.id === opts.characterId)
  if (char === undefined) {
    throw new InkloomError('NOT_FOUND', `角色 ${opts.characterId} 不在 characters/index.json 里`)
  }

  const anchor = typeof char.visualAnchor === 'string' ? char.visualAnchor.trim() : ''
  const appearance = typeof char.appearance === 'string' ? char.appearance.trim() : ''
  if (anchor.length === 0 && appearance.length === 0) {
    throw new InkloomError(
      'INVALID_INPUT',
      `角色 ${opts.characterId} 没有 visualAnchor / appearance，无法生图`,
    )
  }

  const name = typeof char.name === 'string' ? char.name : opts.characterId
  const gender = typeof char.gender === 'string' ? char.gender.trim() : ''
  const age =
    typeof char.age === 'string' || typeof char.age === 'number' ? String(char.age).trim() : ''
  const style = opts.style ?? '国风插画，干净背景，半身像'
  // ★ 性别与年龄必须放在最前：实测只给 visualAnchor 时，模型把 17 岁
  //   少女画成了成年男性——外貌描述再详细也拉不回来。
  const identity = [gender, age.length > 0 ? `${age}岁` : ''].filter((x) => x.length > 0).join('，')
  const prompt = [
    identity,
    anchor.length > 0 ? anchor : appearance,
    appearance.length > 0 ? appearance : '',
    style,
  ]
    .filter((x) => x.length > 0)
    .join('，')

  const provider =
    opts.imageProvider ??
    createSiliconFlowImage({
      apiKey: opts.apiKey,
      ...(opts.model === undefined ? {} : { model: opts.model }),
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    })

  const image = await provider.generate({ prompt })

  // 临时 URL 立刻下载：不存 URL 当资产
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const res = await fetchImpl(image.url, {})
  if (!res.ok) throw new InkloomError('UNAVAILABLE', `下载生成的图片失败：HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())

  const relPath = `assets/characters/${opts.characterId}.png`
  await mkdir(join(bookPaths(root).assets, 'characters'), { recursive: true })
  // ★ 图片是二进制：走 Buffer 写，不能当字符串（会把 PNG 字节写坏）
  await writeFile(join(root, relPath), bytes)

  await db.asset.create({
    data: {
      id: `asset_${opts.characterId}_${Date.now()}`,
      projectId: project.id,
      ownerType: 'character',
      ownerId: opts.characterId,
      assetType: 'portrait',
      prompt,
      provider: image.provider,
      model: image.model,
      params: JSON.stringify(image.params),
      filePath: relPath,
      mimeType: 'image/png',
      visualAnchor: anchor.length > 0 ? anchor : appearance,
      anchorSource: 'character_card',
    },
  })

  await commitAll(
    root,
    `feat(asset): 角色形象 ${opts.characterId}（${image.provider}/${image.model}）`,
  )

  return {
    characterId: opts.characterId,
    name,
    filePath: relPath,
    provider: image.provider,
    model: image.model,
    prompt,
    visualAnchor: anchor.length > 0 ? anchor : appearance,
  }
}
