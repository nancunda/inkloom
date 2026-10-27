import type { PlanSkill, Project } from '@inkloom/shared'

/**
 * 技能 = 一段「这类任务该怎么做」的提示词片段。
 *
 * ★ 单一来源：规划阶段的技能清单、任务执行时的详细要求、门禁后的重做，
 *   都从这里取，不允许在 prompt.ts 里再抄一份——两份写法一定会漂移。
 * ★ 它是提示词，不是代码沙箱：没有强制力，靠 write_plan 的 skill enum
 *   与 prompt 的纪律约束；真正的硬约束在工具校验里。
 */
export interface Skill {
  id: PlanSkill
  label: string
  /** 一行说明，写进规划阶段的技能清单 */
  summary: string
  /** 详细写法，任务执行时注入 */
  guidance: (project: Project) => string
}

export const SKILLS: Record<PlanSkill, Skill> = {
  world: {
    id: 'world',
    label: '世界',
    summary: '规则 / 力量体系 / 地点 / 路线',
    guidance:
      () => `- world/rules.json：3–6 条硬规则（priority=hard）或软规则（soft），每条要有名字与可执行的内容，不要写空话。
- world/power-system.json：1 套力量体系（id=ps1），tiers 从低到高 3–6 级，每项至少 {id, systemId:"ps1", name, level}；角色只能引用这些 tier id。
- world/locations.json：3–5 个地点，id 形如 l1；x/y 可以留空。
- world/routes.json：2–4 条路线，days 为正整数（0 会被拒绝），连接已有地点。`,
  },
  characters: {
    id: 'characters',
    label: '人物',
    summary: '角色 / 关系 / 签名',
    guidance:
      () => `- characters/index.json：4–6 个角色。主角 1 个（role=protagonist），对手 1 个（antagonist），其余 supporting/minor。每个角色至少写：name、role、personality、background、motivation、arc、visualAnchor（外貌锚点，供生图）。
- characters/relations.json：4–8 条关系，fromId/toId 必须是已有角色 id，kind 用 master/disciple/kin/ally/enemy/rival/lover，strength 1–5。
- characters/signatures.json：主角与对手各 1–2 条签名（口头禅/动作/意象），trigger 与 frequency 要具体。`,
  },
  story: {
    id: 'story',
    label: '故事',
    summary: '分卷 / 章节蓝图',
    guidance: (project) => {
      const total = project.totalChapters ?? 5
      return `- story/arcs.json：1–2 卷，startChapter/endChapter 覆盖第 1–${total} 章，区间不能重叠；purpose 写这一卷要完成什么，turningPoint 写转折章。
- story/blueprints/ch-001.json … ch-${String(total).padStart(3, '0')}.json：每章一个蓝图。必填：id（b1…）、chapterNo、goal、conflict、hook、castIds；建议填 turn、beatType、tensionLevel、locationId、storyDay。
- 蓝图之间要有递进：第 1 章建立处境，中段升级，最后留钩子；不要每章同一个冲突。`
    },
  },
  chapter: {
    id: 'chapter',
    label: '正文',
    summary: '生成一章初稿（含形象图）',
    guidance:
      () => `- 调用 generate_chapter(chapterNo=N)，可带一句 guidance（例如"开篇 300 字内出现第一个具体冲突"）。这会真实调用模型、耗时 1–3 分钟；一次会话可连续生成多章，只要计划里还有这个任务。
- 生成后读一下返回的场景数与 warnings；如果有截断告警，在摘要里如实说明，不要假装完整。
- 需要主角形象图时调用 generate_portrait(characterId=主角 id)；一次会话可连续生成多张。
- 产物在 chapters/ch-NNN/scenes/ 下，是候选稿；作者去写作页逐场接受/拒绝，不要自己宣布定稿。`,
  },
  review: {
    id: 'review',
    label: '审阅',
    summary: '整理当前进度，请作者做决定',
    guidance: () => `- 先 read_book 核对事实：章节、场景、字数、产物路径。不要凭记忆写摘要。
- 摘要要具体：改了什么、作者该看哪一处、还有什么没做。不要写"已完成"这种空话。
- request_review 必须是该轮唯一的工具调用，调用后不要再写任何文件。`,
  },
  free: {
    id: 'free',
    label: '自由',
    summary: '按作者要求做其他事（不碰正文生成）',
    guidance: () => `- 只做作者明确要求的事；不要顺手改别的文件。
- 数组文件（characters/index.json、relations.json、signatures.json、world/rules.json、locations.json、routes.json、story/arcs.json）必须传**完整数组**，不是单行；entityId 填本次改动那一行的 id。
- projectId 由服务端补，不要自己编；已有对象的 projectId 原样保留。
- 不要修改 novel.json 里的锚点（coreIdea / premise / theme / toneContract）。`,
  },
}

export function getSkill(id: PlanSkill): Skill {
  return SKILLS[id]
}

/** 写进规划阶段 prompt 的技能清单 */
export function skillsIndex(): string {
  return Object.values(SKILLS)
    .map((s) => `- ${s.id}（${s.label}）：${s.summary}`)
    .join('\n')
}
