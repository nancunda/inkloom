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
  /** 身份锚：书在磁盘上换位置也不会认错 */
  folderId?: string
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
  hook: string
  castIds: string[]
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
  snippet: string
  provider: string
}

export interface SearchResult {
  /** 全部 provider 都失败时为 null */
  provider: string | null
  query: string
  hits: SearchHit[]
  /** true = 没用 Tavily（没 key / 被熔断 / 走了 SearXNG） */
  degraded: boolean
  warnings: string[]
}

export interface CharacterRow {
  id: string
  name: string
  role: string
  gender?: string
  age?: string
  appearance?: string
  personality?: string
  background?: string
  motivation?: string
  arc?: string
  curTierId?: string
  curPhysical?: string
  stateChapter?: number
  stateStale?: boolean
  visualAnchor?: string
  [k: string]: unknown
}

export interface WorldRuleRow {
  id: string
  category: string
  name: string
  content: string
  priority: 'hard' | 'soft'
  [k: string]: unknown
}

export interface PowerTier {
  id: string
  systemId: string
  name: string
  level: number
}

export interface PowerSystem {
  id: string
  name: string
  description?: string
  tiers: PowerTier[]
  [k: string]: unknown
}

export interface SettingsField {
  key: string
  secret: boolean
  value: string
  set: boolean
  pendingRestart: boolean
  default: string
}

export interface SettingsData {
  envPath: string
  exists: boolean
  fields: SettingsField[]
  judgeMode: string
}

export interface ChapterText {
  chapterNo: number
  text: string
  wordCount: number
  finalized: boolean
}

export interface OverviewChapter {
  chapterNo: number
  title: string | null
  status: string
  wordCount: number
  tensionLevel: number
  beatType: string
}

export interface CheckpointRow {
  id: string
  label: string
  createdAt: string
  gitRef: string | null
  shortRef: string | null
  /** 这个检查点记录了多少个要素历史文件的位置 */
  revisions: number
}

export interface StoryArcRow {
  id: string
  name: string
  startChapter: number
  endChapter: number
  purpose: string | null
  turningPoint: number | null
  order: number
}

export interface OverviewData {
  chapters: OverviewChapter[]
  stats: {
    total: number
    finalized: number
    words: number
    wordsPerChapter: number
    progress: number
  }
  threads: { total: number; active: number; overdue: number }
  /** 卷：张力曲线的分组带，也用于故事页编辑 */
  arcs: StoryArcRow[]
  runs: { total: number; failed: number }
}

export interface AssetItem {
  ownerId: string
  filePath: string
}

export interface AssetsData {
  characters: AssetItem[]
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

// ---------------------------------------------------------------------------
// Agent（共创循环）
// ---------------------------------------------------------------------------

export type AgentRunStatus = 'running' | 'waiting_review' | 'paused' | 'done' | 'failed' | 'stopped'

export type AgentGate =
  | {
      kind: 'plan'
      planId: string
      title: string
      summary: string
      artifacts: string[]
    }
  | {
      kind: 'task'
      planId: string
      taskId: string
      title: string
      summary: string
      artifacts: string[]
    }

export type AgentPlanStatus = 'drafting' | 'awaiting_approval' | 'approved' | 'done' | 'aborted'
export type AgentTaskStatus = 'todo' | 'doing' | 'done' | 'skipped' | 'blocked'
export type AgentSkill = 'world' | 'characters' | 'story' | 'chapter' | 'review' | 'free'

export interface AgentPlanTask {
  id: string
  title: string
  skill: AgentSkill
  brief: string
  review: 'required' | 'none'
  status: AgentTaskStatus
  artifacts: string[]
  feedback: string | null
  summary: string | null
  reviewed: boolean
}

export interface AgentPlan {
  version: 1
  id: string
  title: string
  goal: string
  status: AgentPlanStatus
  summary: string | null
  feedback: string | null
  createdAt: string
  updatedAt: string
  tasks: AgentPlanTask[]
}

export interface AgentRunBudget {
  steps: number
  maxSteps: number
  chapterCalls: number
  portraitCalls: number
}

export type AgentEvent =
  | { seq: number; at: string; type: 'run.started'; goal: string }
  | { seq: number; at: string; type: 'user.message'; text: string }
  | { seq: number; at: string; type: 'thinking.delta'; text: string }
  | { seq: number; at: string; type: 'text.delta'; text: string }
  | { seq: number; at: string; type: 'assistant.message'; text: string; thinking: string }
  | {
      seq: number
      at: string
      type: 'tool.started'
      toolCallId: string
      toolName: string
      args: unknown
    }
  | {
      seq: number
      at: string
      type: 'tool.ended'
      toolCallId: string
      toolName: string
      isError: boolean
      summary: string
    }
  | { seq: number; at: string; type: 'gate.waiting'; gate: AgentGate }
  | {
      seq: number
      at: string
      type: 'gate.resolved'
      decision: 'approve' | 'revise' | 'skip'
      feedback: string | null
    }
  | { seq: number; at: string; type: 'plan.updated'; plan: AgentPlan }
  | { seq: number; at: string; type: 'run.finished' }
  | { seq: number; at: string; type: 'run.paused'; reason: string }
  | { seq: number; at: string; type: 'run.failed'; error: string }
  | { seq: number; at: string; type: 'run.stopped' }
  | { seq: number; at: string; type: 'ping' }

export interface AgentRun {
  id: string
  goal: string
  status: AgentRunStatus
  startedAt: string
  finishedAt: string | null
  planId: string | null
  gate: AgentGate | null
  error: string | null
  budget: AgentRunBudget
  tokens: number
  events: AgentEvent[]
}

// ---------------------------------------------------------------------------
// 书库：一个文件夹下每本书是一个一级目录
// ---------------------------------------------------------------------------
export interface LibraryBook {
  folder: string
  rootPath: string
  name: string
  genre: string
  totalChapters: number | null
  updatedAt: string
}

export interface LibraryCurrent {
  folder: string
  rootPath: string
  name: string
}

export interface LibraryData {
  libraryRoot: string
  current: LibraryCurrent | null
  books: LibraryBook[]
}

// ---------------------------------------------------------------------------
// 图谱（世界模型）
// ---------------------------------------------------------------------------
export interface OntologyNodeRow {
  id: string
  type: string
  name: string
  aliases?: string[]
  attrs: Record<string, string>
  virtual: boolean
  sourceFile?: string
  classIds: string[]
}

export interface OntologyEdgeRow {
  id: string
  from: string
  predicate: string
  to: string
  /** 服务端给的端点名字（可能缺省，旧响应） */
  fromName?: string
  toName?: string
  sinceChapter?: number
  untilChapter?: number
  confidence?: number
  retracted?: boolean
  tombstone?: boolean
  virtual: boolean
  undirected?: boolean
  sourceFile?: string
}

export interface OntologyClassRow {
  id: string
  name: string
  parentId: string | null
  kind: string
  properties: unknown[]
  rules: unknown[]
  instanceCount?: number
}

export interface OntologyPredicateRow {
  id: string
  label: string
  domain: unknown
  range: unknown
  directed: boolean
  transitive?: boolean
  inverseOf?: string
}

export interface OntologyIssueRow {
  severity: 'error' | 'warning'
  code: string
  subject: string
  message: string
  evidence?: string
}

export interface OntologyGraphData {
  nodes: OntologyNodeRow[]
  edges: OntologyEdgeRow[]
  classes: OntologyClassRow[]
  predicates: OntologyPredicateRow[]
  issues: OntologyIssueRow[]
  warnings: string[]
  total: number
  truncated: boolean
  signature: string
  builtAt: string
}

/** 点开类 id（instanceOf 的端点）时返回的是类详情，不是节点 */
export interface OntologyClassDetail {
  node: null
  class: OntologyClassRow & { instanceCount: number }
  instances: string[]
  edges: OntologyEdgeRow[]
  issues: OntologyIssueRow[]
}

export interface OntologyNodeDetail {
  node: OntologyNodeRow
  edges: OntologyEdgeRow[]
  issues: OntologyIssueRow[]
}

export type OntologyDetailData = OntologyNodeDetail | OntologyClassDetail

export interface OntologyClassesData {
  classes: OntologyClassRow[]
  predicates: OntologyPredicateRow[]
}

/** 路径里的节点是 core 的 GraphNode：没有 classIds（只有 /graph、/nodes/:id 才补） */
export interface OntologyPathNode {
  id: string
  type: string
  name: string
  aliases?: string[]
  attrs: Record<string, string>
  virtual: boolean
  sourceFile?: string
}

/** GET /api/ontology/path 的响应：found=false 时 nodes/edges 为空数组 */
export interface OntologyPathData {
  found: boolean
  nodes: OntologyPathNode[]
  edges: OntologyEdgeRow[]
}

/** 资料卡：Agent 搜到/抓到的外部材料（默认未批准） */
export interface LoreItem {
  id: string
  title: string
  url: string
  snippet: string
  content: string | null
  provider: string
  /** 作者批准后才会被跨会话 read_lore 读到 */
  approved: boolean
}
