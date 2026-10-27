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
  retracted?: boolean
  sourceFile?: string
}

export interface GraphIssue {
  severity: 'error' | 'warning'
  code: string
  subject: string
  message: string
}

export interface GraphSource {
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
  nodes: Map<string, GraphNode>
  edges: GraphEdgeView[]
  classOf: Map<string, string[]>
  subclasses: Map<string, string[]>
  classes: ClassDef[]
  predicates: PredicateDef[]
  issues: GraphIssue[]
  builtFrom: { files: string[]; mtimeMax: number }
}
