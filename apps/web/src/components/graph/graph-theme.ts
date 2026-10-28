import type { StylesheetJson } from 'cytoscape'

export const TYPE_LABEL: Record<string, string> = {
  character: '人物',
  group: '组织',
  place: '地点',
  rule: '规则',
  item: '物品',
  concept: '概念',
  class: '类',
}

export const TYPE_COLOR: Record<string, string> = {
  character: '#1f2937',
  group: '#b45309',
  place: '#0f766e',
  rule: '#be123c',
  item: '#7c3aed',
  concept: '#4b5563',
  class: '#a1a1a1',
}

export const REL_LABEL: Record<string, string> = {
  master: '师徒',
  disciple: '弟子',
  kin: '亲族',
  ally: '同盟',
  enemy: '敌对',
  rival: '竞争',
  lover: '情爱',
}

/** 谓词中文名；rel:* 按 kind 映射，未注册的原样输出 */
export function predicateLabel(predicate: string, labels: Map<string, string>): string {
  if (predicate.startsWith('rel:')) {
    const kind = predicate.slice(4)
    return REL_LABEL[kind] ?? kind
  }
  return labels.get(predicate) ?? predicate
}

/**
 * Cytoscape 样式。
 * ★ cytoscape 自带的 index.d.ts 比运行时保守，个别属性会报类型错；只在字面量上断言，不要改成 any。
 */
export const GRAPH_STYLE = [
  {
    selector: 'node[kind="class"]',
    style: {
      'background-color': '#f5f5f5',
      'background-opacity': 0.65,
      'border-color': '#b3b3b3',
      'border-width': 1,
      'border-style': 'dashed',
      label: 'data(label)',
      'font-size': 11,
      color: '#525252',
      'text-valign': 'top',
      'text-margin-y': -4,
      padding: 14,
    },
  },
  {
    selector: 'node[kind="instance"]',
    style: {
      'background-color': '#ffffff',
      'border-width': 2,
      'border-color': 'data(color)',
      shape: 'round-rectangle',
      width: 96,
      height: 30,
      label: 'data(label)',
      'font-size': 11,
      color: '#262626',
      'text-valign': 'center',
      'text-halign': 'center',
      'text-wrap': 'ellipsis',
      'text-max-width': 84,
    },
  },
  {
    selector: 'node[kind="instance"][?virtual]',
    style: { 'border-style': 'dashed' },
  },
  {
    selector: 'edge',
    style: {
      width: 1.2,
      'line-color': '#8a8a8a',
      'target-arrow-color': '#8a8a8a',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': 9,
      color: '#737373',
      'text-background-color': '#ffffff',
      'text-background-opacity': 0.9,
      'text-background-padding': '2px',
    },
  },
  {
    selector: 'edge[?virtual]',
    style: { 'line-style': 'dashed', 'line-color': '#c4c4c4', 'target-arrow-color': '#c4c4c4' },
  },
  {
    selector: 'edge[?retracted]',
    style: { 'line-style': 'dotted', opacity: 0.25 },
  },
  { selector: '.dimmed', style: { opacity: 0.15 } },
  {
    selector: 'node.hl',
    style: { 'border-color': '#f59e0b', 'border-width': 3 },
  },
  {
    selector: 'edge.hl',
    style: { 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b', width: 2.4 },
  },
  { selector: 'node:selected', style: { 'border-color': '#2563eb', 'border-width': 3 } },
] as unknown as StylesheetJson
