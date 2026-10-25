import { join, relative } from 'node:path'

export interface BookPaths {
  root: string
  novelJson: string
  world: string
  characters: string
  story: string
  chapters: string
  styles: string
  assets: string
  inkloom: string
  indexDb: string
  revisions: string
  runs: string
  checkpoints: string
  projectIdFile: string
}

/** 书文件夹的固定目录结构（spec §2.5）。一本书 = 一个文件夹，可整个拷走 */
export function bookPaths(root: string): BookPaths {
  const inkloom = join(root, '.inkloom')
  return {
    root,
    novelJson: join(root, 'novel.json'),
    world: join(root, 'world'),
    characters: join(root, 'characters'),
    story: join(root, 'story'),
    chapters: join(root, 'chapters'),
    styles: join(root, 'styles'),
    assets: join(root, 'assets'),
    inkloom,
    indexDb: join(inkloom, 'index.sqlite'),
    revisions: join(inkloom, 'revisions'),
    runs: join(inkloom, 'runs'),
    checkpoints: join(inkloom, 'checkpoints.jsonl'),
    projectIdFile: join(inkloom, 'project-id'),
  }
}

/** 把绝对路径转成相对书根的 POSIX 路径（入库统一用 POSIX） */
export function relativeToBook(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/')
}
