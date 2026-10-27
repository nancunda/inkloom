import type {
  Character,
  CharacterRelation,
  ClassDef,
  ClassesFile,
  GraphEdge,
  Location,
  NodeType,
  OntologyNode,
  PlotThread,
  PredicateDef,
  Route,
  StoryArc,
  WorldRule,
} from '@inkloom/shared'

export interface GraphNode {
  id: string
  type: NodeType
  name: string
  aliases?: string[]
  attrs: Record<string, string>
  virtual: boolean
  sourceFile?: string
}

/** 虚拟边来自实体投影，没有作者写入时间，所以 createdAt 可选 */
export type GraphEdgeView = Omit<GraphEdge, 'createdAt'> & {
  createdAt?: string
  virtual: boolean
  /** 虚拟路线：双向时匹配忽略方向 */
  undirected?: boolean
  /** 被别的边 retracts 指向 */
  retracted?: boolean
  /** 废止记录行本身（带 retracts）：只用于吊销，不参与推导；展示侧仍需按此标记过滤 */
  tombstone?: boolean
  sourceFile?: string
}

/** spec §6 的 12 个问题码 */
export const GRAPH_ISSUE_CODES = [
  'DUP_NODE',
  'DUP_EDGE',
  'EDGE_ENDPOINT_MISSING',
  'EDGE_BAD_PREDICATE',
  'EDGE_DOMAIN_RANGE',
  'CLASS_CYCLE',
  'CLASS_PARENT_MISSING',
  'EVENT_CAUSE_MISSING',
  'EVENT_PARTICIPANT_MISSING',
  'EVENT_LOCATION_MISSING',
  'PROPOSAL_EVIDENCE_MISSING',
  'PROPOSAL_CAP_EXCEEDED',
] as const
export type GraphIssueCode = (typeof GRAPH_ISSUE_CODES)[number]

export interface GraphIssue {
  severity: 'error' | 'warning'
  code: GraphIssueCode
  subject: string
  message: string
  evidence?: string
}

export interface GraphSource {
  // events?: StoryEvent[]  ⏳ 切片 2 引入（切片 1 不读 events.jsonl）
  characters: Character[]
  relations: CharacterRelation[]
  locations: Location[]
  routes: Route[]
  rules: WorldRule[]
  threads: PlotThread[]
  arcs: StoryArc[]
  nodes: OntologyNode[]
  edges: GraphEdge[]
  classesFile: ClassesFile | null
  builtFrom: { files: string[]; mtimeMax: number }
}

export interface GraphSnapshot {
  nodes: ReadonlyMap<string, GraphNode>
  edges: GraphEdgeView[]
  classOf: ReadonlyMap<string, string[]>
  subclasses: ReadonlyMap<string, string[]>
  classes: ClassDef[]
  predicates: PredicateDef[]
  issues: GraphIssue[]
  builtFrom: { files: string[]; mtimeMax: number }
}
