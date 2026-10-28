import type { AgentTool } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import {
  AGENT_ROLE_IDS,
  AGENT_ROLES,
  FORBIDDEN_TOOL_NAMES,
  isAgentRoleId,
  toolsForRole,
} from './roles.js'

const FORBIDDEN = [
  'delegate',
  'write_element',
  'write_blueprint',
  'write_plan',
  'update_plan',
  'update_task',
  'request_review',
  'generate_chapter',
  'generate_portrait',
]

function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  } as unknown as AgentTool
}

describe('AGENT_ROLES', () => {
  it('★ 四个角色齐全，id 与键一致，id 列表从键派生', () => {
    expect(AGENT_ROLE_IDS).toEqual(['researcher', 'worldbuilder', 'critic', 'stylist'])
    expect([...AGENT_ROLE_IDS].sort()).toEqual(Object.keys(AGENT_ROLES).sort())
    for (const id of AGENT_ROLE_IDS) {
      expect(AGENT_ROLES[id].id).toBe(id)
      expect(AGENT_ROLES[id].systemPrompt.length).toBeGreaterThan(40)
    }
  })

  it('★ 白名单永远不含写工具与 delegate', () => {
    // 两份清单互相校验：实现里的黑名单不能比规格清单少
    for (const banned of FORBIDDEN) expect(FORBIDDEN_TOOL_NAMES.has(banned)).toBe(true)
    for (const role of Object.values(AGENT_ROLES)) {
      for (const banned of FORBIDDEN) expect(role.tools).not.toContain(banned)
    }
    expect(AGENT_ROLES.critic.output).toBe('json')
    expect(AGENT_ROLES.researcher.output).toBe('text')
  })

  it('★ 逐角色步数上限锁死（防互换）', () => {
    expect({
      researcher: AGENT_ROLES.researcher.maxSteps,
      worldbuilder: AGENT_ROLES.worldbuilder.maxSteps,
      critic: AGENT_ROLES.critic.maxSteps,
      stylist: AGENT_ROLES.stylist.maxSteps,
    }).toEqual({ researcher: 12, worldbuilder: 10, critic: 8, stylist: 8 })
  })

  it('isAgentRoleId 只认四个角色', () => {
    expect(isAgentRoleId('critic')).toBe(true)
    expect(isAgentRoleId('writer')).toBe(false)
    expect(isAgentRoleId(null)).toBe(false)
    expect(isAgentRoleId(42)).toBe(false)
  })

  it('toolsForRole 只放行白名单内、且真实存在的工具', () => {
    const all = [
      fakeTool('web_search'),
      fakeTool('read_book'),
      fakeTool('write_element'),
      fakeTool('delegate'),
      fakeTool('不存在的工具'),
    ]
    const got = toolsForRole(AGENT_ROLES.researcher, all).map((t) => t.name)
    expect(got).toEqual(['web_search', 'read_book'])
  })

  it('★ 白名单混入写工具时立即抛错（防线前移）', () => {
    const rogue = { ...AGENT_ROLES.critic, tools: ['read_book', 'write_element'] }
    expect(() => toolsForRole(rogue, [fakeTool('read_book')])).toThrow(
      /白名单含写工具 write_element/,
    )
  })
})
