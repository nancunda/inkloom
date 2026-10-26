import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { InkloomError, type Project, projectSchema } from '@inkloom/shared'
import { atomicWrite, readIfExists } from './atomic-write.js'
import { ensureBookGitignore } from './book-gitignore.js'
import { readJsonElement, writeJsonElement } from './elements.js'
import { type BookPaths, bookPaths } from './paths.js'

export interface CreateProjectInput {
  rootPath: string
  name: string
  genre: string
  totalChapters?: number
  wordsPerChapter?: number
  coreIdea?: string
  premise?: string
  theme?: string
  toneContract?: string
}

export interface OpenedProject {
  project: Project
  folderId: string
  paths: BookPaths
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export async function readProjectId(rootPath: string): Promise<string | null> {
  return readIfExists(bookPaths(rootPath).projectIdFile)
}

/** 建书时写入的空容器，避免后续读取方到处判 undefined */
const EMPTY_CONTAINERS: ReadonlyArray<readonly [string, unknown]> = [
  ['characters/index.json', []],
  ['characters/relations.json', []],
  ['characters/signatures.json', []],
  ['world/rules.json', []],
  ['world/locations.json', []],
  ['world/routes.json', []],
  ['story/arcs.json', []],
  ['story/threads.json', []],
  ['story/techniques.json', []],
]

/**
 * 建书（P0-1 / P0-17）。
 *
 * 铁律：一本书 = 一个文件夹。所有数据都在里面，用户可整个拷走。
 * 幂等策略：已存在 project-id 则拒绝，**绝不覆盖**（宁可报错也不毁数据）。
 */
export async function createProject(input: CreateProjectInput): Promise<OpenedProject> {
  const paths = bookPaths(input.rootPath)

  const existing = await readProjectId(input.rootPath)
  if (existing !== null) {
    throw new InkloomError(
      'CONFLICT',
      `${input.rootPath} 已是一本 inkloom 书（folderId=${existing}）`,
    )
  }

  const dirs = [
    paths.world,
    paths.characters,
    paths.story,
    paths.chapters,
    paths.styles,
    paths.assets,
    join(paths.assets, 'characters'),
    join(paths.assets, 'references'),
    paths.inkloom,
    paths.revisions,
    paths.runs,
    join(paths.story, 'blueprints'),
  ]
  for (const d of dirs) await mkdir(d, { recursive: true })

  const folderId = randomUUID().replace(/-/g, '')

  const project = projectSchema.parse({
    id: newId('proj'),
    folderId,
    rootPath: input.rootPath.split('\\').join('/'),
    name: input.name,
    genre: input.genre,
    ...(input.totalChapters === undefined ? {} : { totalChapters: input.totalChapters }),
    ...(input.wordsPerChapter === undefined ? {} : { wordsPerChapter: input.wordsPerChapter }),
    ...(input.coreIdea === undefined ? {} : { coreIdea: input.coreIdea }),
    ...(input.premise === undefined ? {} : { premise: input.premise }),
    ...(input.theme === undefined ? {} : { theme: input.theme }),
    ...(input.toneContract === undefined ? {} : { toneContract: input.toneContract }),
    anchorLocked: false,
    status: 'draft',
    createdAt: new Date().toISOString(),
  })

  // 建书就把忽略规则写好：索引从第一天起就不该进版本历史
  await ensureBookGitignore(input.rootPath)
  // 先写身份锚：即使后续步骤崩溃，也不会把这本书误认成别的书
  await atomicWrite(paths.projectIdFile, folderId)
  await writeJsonElement(input.rootPath, 'novel.json', project)
  for (const [rel, value] of EMPTY_CONTAINERS) {
    await writeJsonElement(input.rootPath, rel, value)
  }
  // 文风默认一套（isDefault=true），否则装配时不知道 S2 段该用哪套
  await writeJsonElement(input.rootPath, 'styles/default.json', {
    id: 'style_default',
    projectId: project.id,
    name: '默认文风',
    description: '（待填写：用词/句式/节奏的整体语感）',
    samples: [],
    bannedWords: [],
    bannedPatterns: [],
    quantLimits: {},
    isDefault: true,
  })
  await atomicWrite(
    join(input.rootPath, 'README.md'),
    `# ${input.name}\n\n由 inkloom 管理。\n\n` +
      `- 正文在 \`chapters/\`（定稿为 \`ch-NNN.md\`，候选稿在 \`chapters/ch-NNN/scenes/\`）\n` +
      `- 设定在 \`world/\` 与 \`characters/\`\n` +
      `- 索引在 \`.inkloom/index.sqlite\`（可删，执行 \`inkloom reindex\` 可重建）\n`,
  )

  return { project, folderId, paths }
}

/**
 * 开书（P0-17）。
 *
 * 双重校验：project-id 存在 + 与 novel.json 的 folderId 一致。
 * 理由：书文件夹被移动/改名后路径变了但身份不能错——防止把 A 书当成 B 书。
 */
export async function openProject(rootPath: string): Promise<OpenedProject> {
  const paths = bookPaths(rootPath)
  const folderId = await readProjectId(rootPath)
  if (folderId === null) {
    throw new InkloomError('NOT_FOUND', `${rootPath} 不是 inkloom 书（缺 .inkloom/project-id）`)
  }

  const raw = await readJsonElement(rootPath, 'novel.json')
  if (raw === null) {
    throw new InkloomError('NOT_FOUND', `${rootPath} 缺少 novel.json`)
  }

  const parsed = projectSchema.safeParse(raw)
  if (!parsed.success) {
    throw new InkloomError(
      'INVALID_INPUT',
      `novel.json 校验失败：${parsed.error.issues[0]?.message ?? ''}`,
    )
  }

  if (parsed.data.folderId !== folderId) {
    throw new InkloomError(
      'CONFLICT',
      `身份不一致：project-id=${folderId}，novel.json.folderId=${parsed.data.folderId}`,
    )
  }

  return { project: parsed.data, folderId, paths }
}
