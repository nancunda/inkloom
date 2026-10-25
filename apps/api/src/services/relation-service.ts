import { InkloomError } from '@inkloom/shared'
import { commitAll } from '../git/runner.js'
import { getContext } from '../services/context.js'
import { readJsonElement, writeJsonElement } from '../storage/elements.js'

export type RelationKind = 'master' | 'disciple' | 'kin' | 'ally' | 'enemy' | 'rival' | 'lover'

const KINDS: RelationKind[] = ['master', 'disciple', 'kin', 'ally', 'enemy', 'rival', 'lover']

export interface CreateRelationInput {
  fromId: string
  toId: string
  kind: string
  strength?: number
  sinceChapter?: number
}

export interface RelationRecord {
  id: string
  projectId: string
  fromId: string
  toId: string
  kind: string
  strength: number
  sinceChapter?: number
  untilChapter?: number
  note?: string
}

/**
 * 新建角色关系（spec 视图 2：「拖两个节点连线 = 直接建立关系」）。
 *
 * ★ 文件是真相：先写 characters/relations.json，再写索引。
 *   索引丢了 reindex 能从文件重建，反过来不行。
 * ★ 同一对角色同一种关系只允许存在一条（重复连线是误操作，不是新事实）。
 * ★ 方向有意义：师徒 A→B 与 B→A 是两种关系，不做对称合并。
 */
export async function createRelation(input: CreateRelationInput): Promise<RelationRecord> {
  const { root, db, project } = getContext()

  if (input.fromId === input.toId) {
    throw new InkloomError('INVALID_INPUT', '不能给角色自己连关系')
  }
  if (!KINDS.includes(input.kind as RelationKind)) {
    throw new InkloomError('INVALID_INPUT', `kind 必须是 ${KINDS.join('/')}`)
  }
  const strength = input.strength ?? 3
  if (!Number.isInteger(strength) || strength < 1 || strength > 5) {
    throw new InkloomError('INVALID_INPUT', 'strength 必须是 1–5 的整数')
  }

  const rawChars = await readJsonElement(root, 'characters/index.json')
  const chars = Array.isArray(rawChars) ? (rawChars as { id?: unknown }[]) : []
  const ids = new Set(chars.map((c) => c.id).filter((x): x is string => typeof x === 'string'))
  for (const id of [input.fromId, input.toId]) {
    if (!ids.has(id))
      throw new InkloomError('NOT_FOUND', `角色 ${id} 不在 characters/index.json 里`)
  }

  const rawRels = await readJsonElement(root, 'characters/relations.json')
  const rels = Array.isArray(rawRels) ? (rawRels as RelationRecord[]) : []

  const dup = rels.find(
    (r) => r.fromId === input.fromId && r.toId === input.toId && r.kind === input.kind,
  )
  if (dup !== undefined) {
    throw new InkloomError('CONFLICT', '这两个角色之间已经有同类型的关系')
  }

  const record: RelationRecord = {
    id: `rel_${Date.now().toString(36)}`,
    projectId: project.id,
    fromId: input.fromId,
    toId: input.toId,
    kind: input.kind,
    strength,
    ...(input.sinceChapter === undefined ? {} : { sinceChapter: input.sinceChapter }),
  }
  const next = [...rels, record]
  await writeJsonElement(root, 'characters/relations.json', next)

  await db.characterRelation.create({
    data: {
      id: record.id,
      projectId: project.id,
      fromId: record.fromId,
      toId: record.toId,
      kind: record.kind,
      strength: record.strength,
      sinceChapter: record.sinceChapter ?? null,
      untilChapter: null,
      note: null,
    },
  })

  await commitAll(root, `feat(relations): ${record.fromId} → ${record.toId} ${record.kind}`)
  return record
}
