import type { AgentTool } from '@earendil-works/pi-agent-core'

export type AgentRoleId = 'researcher' | 'worldbuilder' | 'critic' | 'stylist'

export interface AgentRole {
  id: AgentRoleId
  label: string
  systemPrompt: string
  /**
   * 工具白名单：只读 = 不改文稿/计划。
   * ★ 注意 web_search / read_url 会落 lore 资料卡（默认未批准），不是零副作用。
   */
  tools: readonly string[]
  maxSteps: number
  output: 'text' | 'json'
}

/**
 * 四个角色共用的边界：没有写权限。
 * ★ 这段话是防线的一部分，不是客套：子体的工具集已经被白名单裁过，
 *   但模型仍可能「建议自己调用写工具」，必须明确禁止。
 */
const READ_ONLY =
  '你没有写权限：不能改文件、不能提交计划、不能请求审阅、不能派活给其他智能体。只用工具返回的事实，不要编造文件内容。结论要能被作者直接使用。'

export const AGENT_ROLES: Record<AgentRoleId, AgentRole> = {
  researcher: {
    id: 'researcher',
    label: '研究员',
    systemPrompt: [
      '你是这本书的考据研究员。任务是用联网搜索与阅读，为主 Agent 提供可核验的外部资料。',
      READ_ONLY,
      '每条结论都必须附来源 URL 或资料卡 id；搜不到就直说搜不到，不要用常识补。',
      '一次只查一个问题：先 web_search，需要细节再 read_url；read_book 只用来确认书内已有设定，不要整篇复述。',
    ].join('\n'),
    tools: ['web_search', 'read_url', 'read_lore', 'read_book'],
    maxSteps: 6,
    output: 'text',
  },
  worldbuilder: {
    id: 'worldbuilder',
    label: '世界建筑师',
    systemPrompt: [
      '你是这本书的世界观建筑师。任务是读现有设定与图谱，指出该补哪些节点、边、规则，并说明为什么。',
      READ_ONLY,
      '建议必须落到具体 id / type / 是否已存在；优先复用已有节点，不要造重复概念。',
      '用 query_graph / find_path 核对现状，不要凭印象说「还没有」。',
    ].join('\n'),
    tools: ['read_book', 'read_element', 'query_graph', 'find_path'],
    maxSteps: 5,
    output: 'text',
  },
  critic: {
    id: 'critic',
    label: '一致性检查员',
    systemPrompt: [
      '你是这本书的一致性检查员。任务是核对「本次产物」与既有设定、图谱、章节状态是否矛盾。',
      READ_ONLY,
      '只报矛盾，不报审美偏好：人物/地点/规则/时间线/境界/称谓前后不符才算矛盾。',
      '每条矛盾必须给 evidence（文件相对路径或节点 id）；给不出 evidence 的不要写。',
      '没有矛盾时 conflicts 为空数组（suggestions 也可为空），但外层始终是上面那个对象。',
      '只输出 JSON，不要任何解释文字，格式：',
      '{"conflicts":[{"severity":"error","message":"…","evidence":["characters/index.json"]}],"suggestions":["…"]}',
      'severity 用 error 表示「必须修」，warning 表示「建议修」。',
    ].join('\n'),
    tools: ['read_book', 'read_element', 'query_graph', 'find_path', 'explain_fact'],
    maxSteps: 5,
    output: 'json',
  },
  stylist: {
    id: 'stylist',
    label: '文风顾问',
    systemPrompt: [
      '你是这本书的文风顾问。任务是读正文与文风设定，给出可执行的局部修改建议。',
      READ_ONLY,
      '只给建议不重写：指出哪一句、改成什么、为什么，最多 8 条。',
      '关注视角、句长、对话贴合人物、AI 味套话；不评价剧情好不好。',
    ].join('\n'),
    tools: ['read_book', 'read_element'],
    maxSteps: 4,
    output: 'text',
  },
}

export const AGENT_ROLE_IDS = Object.keys(AGENT_ROLES) as readonly AgentRoleId[]

export function isAgentRoleId(v: unknown): v is AgentRoleId {
  return typeof v === 'string' && (AGENT_ROLE_IDS as readonly string[]).includes(v)
}

/** 写工具与 delegate 的黑名单：白名单是唯一防线，这里再上一道闸 */
export const FORBIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set([
  'delegate',
  'write_element',
  'write_blueprint',
  'write_plan',
  'update_plan',
  'update_task',
  'request_review',
  'generate_chapter',
  'generate_portrait',
])

/**
 * 按白名单过滤工具全集。
 * ★ 白名单里写了但当前会话没有的工具（例如未配置搜索）直接跳过，
 *   不报错：角色仍可退化成只读模式工作。
 */
export function toolsForRole(role: AgentRole, all: readonly AgentTool[]): AgentTool[] {
  const allowed = new Set(role.tools)
  // ★ 开发期断言：白名单是唯一防线，宁可当场炸，也不要静默把写工具交给子体
  for (const name of allowed) {
    if (FORBIDDEN_TOOL_NAMES.has(name)) {
      throw new Error(`角色 ${role.id} 的白名单含写工具 ${name}`)
    }
  }
  return all.filter((t) => allowed.has(t.name))
}
