/** 与 apps/api/src/routes 的响应结构一一对应。改了那边要同步这里。 */

export interface ChapterSummary {
  chapterNo: number
  title: string | null
  status: string
  wordCount: number
  summary: string | null
  finalizedAt: string | null
}

export interface Book {
  id: string
  name: string
  genre: string
  coreIdea?: string
  premise?: string
  theme?: string
  coreConflict?: string
  toneContract?: string
  chapters: ChapterSummary[]
}

export interface SceneRow {
  sceneNo: number
  version: number
  relPath: string
  wordCount: number
  segCount: number
  status: 'candidate' | 'accepted' | 'rejected'
  acceptedAt: string | null
}

export interface ChapterDetail {
  chapterNo: number
  title: string | null
  status: string
  wordCount: number
  summary: string | null
  scenes: SceneRow[]
}

export interface Seg {
  segId: string
  text: string
}

export interface SceneDetail {
  sceneNo: number
  version: number
  segments: Seg[]
}

export interface DiffSpan {
  op: 'same' | 'add' | 'remove'
  text: string
}

export interface DiffResult {
  similarity: number
  addedChars: number
  removedChars: number
  unchangedChars: number
  spans: DiffSpan[]
}

export interface BlueprintLite {
  chapterNo: number
  title: string | null
  goal: string
  conflict: string
  tensionLevel: number
  beatType: string
}

export interface GeneratedScene {
  sceneNo: number
  version: number
  relPath: string
  wordCount: number
  segCount: number
}

export interface GenerateResult {
  runId: string
  chapterNo: number
  strategy: string
  scenes: GeneratedScene[]
  tokenEstimate: number
  usage: { input: number; output: number; reasoning: number; cacheHit: number }
  warnings: string[]
  degradedReason: string | null
}

export interface FinalizeResult {
  relPath: string
  wordCount: number
  sceneCount: number
  summary: string
}

export type ProposalField = 'curPhysical' | 'curMental' | 'curTierId'

export interface StateProposal {
  id: string
  characterId: string
  characterName: string
  field: ProposalField
  newValue: string
  evidenceQuote: string
  /** ★ 证据是否真的出现在正文里（Ruling 44）。false 时 UI 必须显警告 */
  evidenceVerified: boolean
  stateChapter: number
}

export interface ProposeResult {
  runId: string
  proposals: StateProposal[]
  unparsed: string[]
}

export interface LocationRow {
  id: string
  name: string
  type: string
  region: string
  description: string
  /** 可选坐标；缺省时前端做圆环布局 */
  x: number | null
  y: number | null
}

export interface RouteRow {
  id: string
  fromId: string
  toId: string
  mode: string
  /** 标准行进天数（系统算，AI 不得改） */
  days: number
  condition: string
  bidirectional: boolean
}

export interface WorldData {
  locations: LocationRow[]
  routes: RouteRow[]
}

export interface ThreadRow {
  id: string
  kind: string
  title: string
  description: string
  plantedChapter: number | null
  advancedChapters: number[]
  resolvedChapter: number | null
  status: string
  payoffHint: string
  payoffWindow: number | null
  /** 还悬着、且已过期望回收章 */
  overdue: boolean
}

export interface ThreadsData {
  currentChapter: number
  threads: ThreadRow[]
}

export interface SearchHit {
  title: string
  url: string
  content: string
}

export interface SearchResult {
  provider: string
  query: string
  hits: SearchHit[]
}

export interface RelationNode {
  id: string
  name: string
  role: string
}

export interface RelationEdge {
  id: string
  fromId: string
  toId: string
  /** master | disciple | kin | ally | enemy | rival | lover */
  kind: string
  strength: number
  sinceChapter?: number
  untilChapter?: number
}

export interface RelationGraphData {
  /** null = 不按章节过滤（看全部关系） */
  chapterNo: number | null
  nodes: RelationNode[]
  edges: RelationEdge[]
}

export interface GenerateJob {
  id: string
  kind: 'generate'
  status: 'running' | 'done' | 'failed'
  chapterNo: number
  startedAt: string
  finishedAt: string | null
  result: GenerateResult | null
  error: string | null
}

export interface HealthFinding {
  sceneNo: number
  version: number
  kind: 'slop' | 'pace' | 'consistency'
  value: string | number | boolean
  confidence: number
  /** 置信度够不够写进 prompt（< 0.75 不注入） */
  injectable: boolean
}

export interface HealthReport {
  chapterNo: number
  enabled: boolean
  provider: string | null
  findings: HealthFinding[]
  /** 判断层不可用时的说明；非空说明这次体检被降级了 */
  degraded: string | null
}
