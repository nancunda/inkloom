import type { AgentTool } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import { AGENT_ROLE_IDS, AGENT_ROLES, isAgentRoleId, toolsForRole } from './roles.js'

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
  it('★ 四个角色齐全，id 与键一致', () => {
    expect(AGENT_ROLE_IDS).toEqual(['researcher', 'worldbuilder', 'critic', 'stylist'])
    for (const id of AGENT_ROLE_IDS) {
      expect(AGENT_ROLES[id].id).toBe(id)
      expect(AGENT_ROLES[id].systemPrompt.length).toBeGreaterThan(40)
    }
  })

  it('★ 白名单永远不含写工具与 delegate', () => {
    for (const role of Object.values(AGENT_ROLES)) {
      for (const banned of FORBIDDEN) expect(role.tools).not.toContain(banned)
      expect(role.maxSteps).toBeGreaterThanOrEqual(4)
      expect(role.maxSteps).toBeLessThanOrEqual(6)
    }
    expect(AGENT_ROLES.critic.output).toBe('json')
    expect(AGENT_ROLES.researcher.output).toBe('text')
  })

  it('isAgentRoleId 只认四个角色', () => {
    expect(isAgentRoleId('critic')).toBe(true)
    expect(isAgentRoleId('writer')).toBe(false)
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
})
