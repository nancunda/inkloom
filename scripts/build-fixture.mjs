#!/usr/bin/env node
// 生成 fixtures/qixia —— 玄幻示例书。
// 一物四用（spec §8.4）：单测输入、集成数据、E2E 种子、人工评估样本。
import { execSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ROOT = 'fixtures/qixia'

async function json(rel, value) {
  const p = join(ROOT, rel)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function scene(chapterNo, sceneNo, segs) {
  const pad = String(chapterNo).padStart(3, '0')
  const rel = join(ROOT, 'chapters', `ch-${pad}`, 'scenes', `s${sceneNo}.v1.md`)
  await mkdir(dirname(rel), { recursive: true })
  const body = segs
    .map(([segId, text]) => `<!-- seg:${segId} -->\n${text}`)
    .join('\n\n')
  await writeFile(rel, `<!-- scene:${sceneNo} v:1 -->\n${body}\n`, 'utf8')
}

async function chapter(chapterNo, title, scenes) {
  const pad = String(chapterNo).padStart(3, '0')
  const blocks = scenes.map(([no, text]) => `<!-- scene:${no} -->\n${text}`).join('\n\n')
  await mkdir(join(ROOT, 'chapters'), { recursive: true })
  await writeFile(join(ROOT, 'chapters', `ch-${pad}.md`), `# ${title}\n\n${blocks}\n`, 'utf8')
}

// ---- 建书（走 CLI，保证目录结构与 project-id 一致）----
await rm(ROOT, { recursive: true, force: true })
execSync(`pnpm cli create ${ROOT} --name qixia --genre xuanhuan`, { stdio: 'inherit' })

// ---- 角色（5 个）----
await json('characters/index.json', [
  {
    id: 'c1',
    projectId: 'p',
    name: '林岚',
    role: 'protagonist',
    gender: '女',
    age: '17',
    appearance: '青灰道袍，眉间一点朱砂，左眉一道旧疤，腕上缠麻绳',
    personality: '执拗、认死理，对承诺看得比命重',
    background: '剑冢守碑人的养女，不知自己姓氏来历',
    motivation: '找到刻在剑冢碑上的那个名字',
    arc: '从「想被承认」到「自己定义名字」',
    curPhysical: '健康',
    curTierId: 't2',
    stateChapter: 1,
    stateStale: false,
  },
  {
    id: 'c2',
    projectId: 'p',
    name: '苏婉',
    role: 'supporting',
    personality: '冷静、话少，习惯先算代价再动手',
    background: '药庐传人',
    curPhysical: '健康',
    stateChapter: 1,
  },
  {
    id: 'c3',
    projectId: 'p',
    name: '玄阳子',
    role: 'supporting',
    personality: '散漫、爱酒，剑术极高',
    background: '林岚的授业师',
    stateChapter: 1,
  },
  {
    id: 'c4',
    projectId: 'p',
    name: '裴无咎',
    role: 'antagonist',
    personality: '温文尔雅，杀人时也笑着说抱歉',
    background: '天枢阁少主',
    stateChapter: 1,
  },
  {
    id: 'c5',
    projectId: 'p',
    name: '老仆',
    role: 'minor',
    personality: '沉默，只在关键处说一句',
    background: '守碑人',
    stateChapter: 1,
  },
])

// ---- 关系与签名 ----
await json('characters/relations.json', [
  { id: 'rel1', projectId: 'p', fromId: 'c3', toId: 'c1', kind: 'master', strength: 5, sinceChapter: 1 },
  { id: 'rel2', projectId: 'p', fromId: 'c2', toId: 'c1', kind: 'ally', strength: 4, sinceChapter: 2 },
  { id: 'rel3', projectId: 'p', fromId: 'c4', toId: 'c1', kind: 'enemy', strength: 3, sinceChapter: 4 },
])
await json('characters/signatures.json', [
  {
    id: 'sig1',
    projectId: 'p',
    characterId: 'c3',
    kind: 'entrance_verse',
    content: '一壶一剑一山秋，懒向人间问去留。',
    trigger: 'entrance',
    frequency: 'once',
    isActive: true,
  },
  {
    id: 'sig2',
    projectId: 'p',
    characterId: 'c3',
    kind: 'catchphrase',
    content: '酒没了，人就该走了。',
    trigger: 'exit',
    frequency: 'key_moment',
    isActive: true,
  },
  {
    id: 'sig3',
    projectId: 'p',
    characterId: 'c1',
    kind: 'signature_action',
    content: '按住腰间玉牌，指节泛白',
    trigger: 'anger',
    frequency: 'key_moment',
    isActive: true,
  },
])

// ---- 世界 ----
await json('world/rules.json', [
  {
    id: 'w1',
    projectId: 'p',
    category: 'power',
    name: '灵潮',
    content: '灵气每甲子涨落一次，涨时突破成功率翻倍，落时强行突破必死',
    priority: 'hard',
  },
  {
    id: 'w2',
    projectId: 'p',
    category: 'geography',
    name: '剑冢不可越',
    content: '剑冢边界有剑气，未经允许者越过即被削去三魂之一',
    priority: 'hard',
  },
  {
    id: 'w3',
    projectId: 'p',
    category: 'taboo',
    name: '不可直呼碑上之名',
    content: '直呼剑冢碑上的名字会引来碑主残念',
    priority: 'hard',
  },
  {
    id: 'w4',
    projectId: 'p',
    category: 'faction',
    name: '天枢阁',
    content: '掌门以下分四院，最强的那个才配姓裴',
    priority: 'soft',
  },
])
await json('world/locations.json', [
  { id: 'l1', projectId: 'p', name: '青芜山', type: 'mountain', region: '东境' },
  { id: 'l2', projectId: 'p', name: '剑冢', type: 'ruin', region: '东境' },
  { id: 'l3', projectId: 'p', name: '药庐', type: 'sect', region: '东境' },
])
await json('world/routes.json', [
  { id: 'r1', projectId: 'p', fromId: 'l1', toId: 'l2', mode: 'walk', days: 3, bidirectional: true },
  { id: 'r2', projectId: 'p', fromId: 'l1', toId: 'l3', mode: 'walk', days: 1, bidirectional: true },
  {
    id: 'r3',
    projectId: 'p',
    fromId: 'l3',
    toId: 'l2',
    mode: 'fly',
    days: 1,
    condition: '仅灵潮涨时可飞渡',
    bidirectional: false,
  },
])

// ---- 结构：5 章蓝图 + 3 条线索 ----
const chapters = [
  { no: 1, title: '第一章 入山', goal: '林岚决定上山', conflict: '老仆阻拦', turn: '', hook: '剑冢方向传来一声剑鸣', tension: 2, beat: 'setup', cast: ['c1', 'c5'], castIds: ['c1', 'c5'] },
  { no: 2, title: '第二章 守碑人', goal: '得知自己的身世线索', conflict: '老仆不肯说', turn: '老仆露出左眉同样的疤', hook: '他说：你不该问', tension: 3, beat: 'rising', cast: ['c1', 'c5', 'c2'] },
  { no: 3, title: '第三章 剑气', goal: '越过剑冢边界', conflict: '剑气削魂', turn: '', hook: '碑上浮出一个字', tension: 4, beat: 'rising', cast: ['c1', 'c3'] },
  { no: 4, title: '第四章 剑冢', goal: '走到碑前', conflict: '裴无咎阻拦', turn: '裴无咎也在找这个名字', hook: '碑上的名字是她自己', tension: 5, beat: 'climax', cast: ['c1', 'c4', 'c3'] },
  { no: 5, title: '第五章 名字', goal: '决定是否读出名', conflict: '读名即召残念', turn: '', hook: '她开口了', tension: 5, beat: 'twist', cast: ['c1', 'c4'] },
]

for (const ch of chapters) {
  await json(`story/blueprints/ch-${String(ch.no).padStart(3, '0')}.json`, {
    id: `b${ch.no}`,
    projectId: 'p',
    chapterNo: ch.no,
    title: ch.title,
    goal: ch.goal,
    conflict: ch.conflict,
    turn: ch.turn || undefined,
    hook: ch.hook,
    castIds: ch.castIds,
    tensionLevel: ch.tension,
    beatType: ch.beat,
  })
}

await json('story/threads.json', [
  {
    id: 't1',
    projectId: 'p',
    kind: 'foreshadow',
    title: '碑上的名字',
    description: '林岚想找的那个名字',
    plantedChapter: 1,
    advancedChapters: [2, 3],
    status: 'active',
    payoffHint: '林岚最终读出碑上刻的是自己的名字',
    payoffWindow: 30,
  },
  {
    id: 't2',
    projectId: 'p',
    kind: 'running_gag',
    title: '玄阳子讨酒',
    description: '每次出场必问酒',
    plantedChapter: 1,
    advancedChapters: [],
    status: 'active',
  },
  {
    id: 't3',
    projectId: 'p',
    kind: 'setup',
    title: '左眉的疤',
    description: '林岚与老仆同位置的疤',
    plantedChapter: 2,
    advancedChapters: [],
    status: 'active',
    payoffWindow: 60,
  },
])

// ---- 文风 ----
await json('styles/default.json', {
  id: 'style_default',
  projectId: 'p',
  name: '冷硬短句',
  description: '短句为主，少形容词，多用动作与物象承载情绪',
  samples: ['风从袖口灌进来。她按住玉牌，指节泛白。'],
  bannedWords: ['仿佛', '不禁', '顿时', '宛如'],
  bannedPatterns: ['不是……而是……'],
  quantLimits: { 仿佛: 0, 空气中弥漫: 0 },
  isDefault: true,
})

// ---- 前三章候选稿 + 定稿 ----
await scene(1, 1, [
  ['a1a1', '林岚踏上山道，风从袖口灌进来。'],
  ['a1a2', '“再往上，就是剑冢了。”老仆的声音从身后传来。'],
])
await scene(2, 1, [
  ['b2b1', '老仆的手停在半空。'],
  ['b2b2', '他左眉上，有一道和林岚一样的疤。'],
])
await scene(3, 1, [
  ['c3c1', '剑气贴着面颊削过去。'],
  ['c3c2', '碑上浮出一个字，她认不出，却觉得眼熟。'],
])

await chapter(1, '第一章 入山', [
  [1, '林岚踏上山道，风从袖口灌进来。\n\n“再往上，就是剑冢了。”老仆的声音从身后传来。'],
])
await chapter(2, '第二章 守碑人', [
  [1, '老仆的手停在半空。\n\n他左眉上，有一道和林岚一样的疤。'],
])
await chapter(3, '第三章 剑气', [
  [1, '剑气贴着面颊削过去。\n\n碑上浮出一个字，她认不出，却觉得眼熟。'],
])

// ---- 重建索引 ----
execSync(`pnpm cli reindex ${ROOT}`, { stdio: 'inherit' })

// 夹具是外层仓库里的样本，不应该是嵌套 git 仓库（否则会被当成 submodule）
// 同理 index.sqlite 是派生物，由 .gitignore 排除
await rm(join(ROOT, '.git'), { recursive: true, force: true })
await rm(join(ROOT, '.inkloom', 'index.sqlite'), { force: true })

console.log('✓ 夹具生成完成：fixtures/qixia')
