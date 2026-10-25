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
