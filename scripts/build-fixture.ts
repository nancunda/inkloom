#!/usr/bin/env node
// 生成 fixtures/qixia —— 玄幻示例书。
// 一物四用（spec §8.4）：单测输入、集成数据、E2E 种子、人工评估样本。
//
// ★ 为什么直调模块而不是 `pnpm cli` 子进程：
//   execSync 走 shell，传中文锚点（--core-idea 等）会被 GBK 转码成乱码。
//   直调 createProject 既能传全部字段，又不经过 shell。
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitAll, initRepo } from '../apps/api/src/git/runner.js'
import { openBookIndexDb } from '../apps/api/src/index-db/open-book.js'
import { mergeChapter } from '../apps/api/src/storage/chapters.js'
import { writeJsonElement } from '../apps/api/src/storage/elements.js'
import { bookPaths } from '../apps/api/src/storage/paths.js'
import { createProject } from '../apps/api/src/storage/project.js'
import { reindex } from '../apps/api/src/storage/reindex.js'
import { writeSceneFile } from '../apps/api/src/storage/scenes.js'

const ROOT = 'fixtures/qixia'

// ---- 清空 + 建书（含锚点）----
await rm(ROOT, { recursive: true, force: true })
const { project } = await createProject({
  rootPath: ROOT,
  name: '七霞',
  genre: '玄幻',
  totalChapters: 5,
  wordsPerChapter: 2000,
  coreIdea: '剑冢的碑上刻着一个名字，那是她自己的',
  premise: '守碑人的养女林岚，为确认碑上刻的是不是自己的名字而闯入剑冢',
  theme: '名字与身份：一个人的名字是被给的，还是自己挣来的',
  toneContract: '冷峻克制，少抒情；短句；情绪靠动作与物象承载，不写心理独白',
})
const pid = project.id
await initRepo(ROOT)
await commitAll(ROOT, `chore: 初始化书籍 ${project.name}`)

// ---- 角色（5）----
await writeJsonElement(ROOT, 'characters/index.json', [
  {
    id: 'c1',
    projectId: pid,
    name: '林岚',
    role: 'protagonist',
    gender: '女',
    age: '17',
    appearance: '青灰道袍，眉间一点朱砂，左眉一道旧疤，腕上缠麻绳',
    personality: '执拗、认死理，对承诺看得比命重，话极少',
    background: '剑冢守碑人的养女，不知自己姓氏来历',
    motivation: '确认碑上刻的名字是不是自己的',
    arc: '从「想被承认」到「自己定义名字」',
    curPhysical: '健康',
    curTierId: 't2',
    stateChapter: 1,
    stateStale: false,
    visualAnchor: '青灰道袍，眉间一点朱砂，左眉一道旧疤，佩短刀在右腰，腕缠麻绳',
  },
  {
    id: 'c2',
    projectId: pid,
    name: '苏婉',
    role: 'supporting',
    personality: '冷静、话少，习惯先算代价再动手',
    background: '药庐传人',
    stateChapter: 1,
  },
  {
    id: 'c3',
    projectId: pid,
    name: '玄阳子',
    role: 'supporting',
    personality: '散漫、爱酒，剑术极高',
    background: '林岚的授业师',
    stateChapter: 1,
  },
  {
    id: 'c4',
    projectId: pid,
    name: '裴无咎',
    role: 'antagonist',
    personality: '温文尔雅，说话像在算账，杀人时也笑着说抱歉',
    background: '天枢阁阁主第四子，为姓这个姓杀了三个兄长',
    motivation: '弄清碑上那个名字，好证明自己配姓裴',
    stateChapter: 1,
  },
  {
    id: 'c5',
    projectId: pid,
    name: '老仆',
    role: 'minor',
    personality: '沉默，只在关键处说一句',
    background: '守碑人',
    stateChapter: 1,
  },
])

// ---- 关系与签名 ----
await writeJsonElement(ROOT, 'characters/relations.json', [
  {
    id: 'rel1',
    projectId: pid,
    fromId: 'c3',
    toId: 'c1',
    kind: 'master',
    strength: 5,
    sinceChapter: 1,
  },
  {
    id: 'rel2',
    projectId: pid,
    fromId: 'c2',
    toId: 'c1',
    kind: 'ally',
    strength: 4,
    sinceChapter: 2,
  },
  {
    id: 'rel3',
    projectId: pid,
    fromId: 'c4',
    toId: 'c1',
    kind: 'enemy',
    strength: 3,
    sinceChapter: 4,
  },
])
await writeJsonElement(ROOT, 'characters/signatures.json', [
  {
    id: 'sig1',
    projectId: pid,
    characterId: 'c3',
    kind: 'entrance_verse',
    content: '一壶一剑一山秋，懒向人间问去留。',
    trigger: 'entrance',
    frequency: 'once',
    isActive: true,
  },
  {
    id: 'sig2',
    projectId: pid,
    characterId: 'c3',
    kind: 'catchphrase',
    content: '酒没了，人就该走了。',
    trigger: 'exit',
    frequency: 'key_moment',
    isActive: true,
  },
  {
    id: 'sig3',
    projectId: pid,
    characterId: 'c1',
    kind: 'signature_action',
    content: '按住腰间短刀柄，拇指顶开卡扣又推回去',
    trigger: 'anger',
    frequency: 'key_moment',
    isActive: true,
  },
])

// ---- 世界 ----
await writeJsonElement(ROOT, 'world/rules.json', [
  {
    id: 'w1',
    projectId: pid,
    category: 'power',
    name: '灵潮',
    content: '灵气每甲子涨落一次。涨时突破成功率翻倍，落时强行突破必死',
    priority: 'hard',
  },
  {
    id: 'w2',
    projectId: pid,
    category: 'geography',
    name: '剑冢不可越',
    content: '剑冢边界有剑气，未经允许者越过即被削去三魂之一。越界后不可回头',
    priority: 'hard',
  },
  {
    id: 'w3',
    projectId: pid,
    category: 'taboo',
    name: '碑名不可由他人念',
    content: '碑上的名字只有本人能念。他人代念会招来碑主残念，残念只认念名者',
    priority: 'hard',
  },
  {
    id: 'w4',
    projectId: pid,
    category: 'faction',
    name: '天枢阁的姓',
    content: '掌门以下分四院，只有最强的那个才配姓裴。同辈相残不算罪',
    priority: 'soft',
  },
])
await writeJsonElement(ROOT, 'world/locations.json', [
  { id: 'l1', projectId: pid, name: '青芜山', type: 'mountain', region: '东境' },
  { id: 'l2', projectId: pid, name: '剑冢', type: 'ruin', region: '东境' },
  { id: 'l3', projectId: pid, name: '药庐', type: 'sect', region: '东境' },
])
await writeJsonElement(ROOT, 'world/routes.json', [
  {
    id: 'r1',
    projectId: pid,
    fromId: 'l1',
    toId: 'l2',
    mode: 'walk',
    days: 3,
    bidirectional: true,
  },
  {
    id: 'r2',
    projectId: pid,
    fromId: 'l1',
    toId: 'l3',
    mode: 'walk',
    days: 1,
    bidirectional: true,
  },
  {
    id: 'r3',
    projectId: pid,
    fromId: 'l3',
    toId: 'l2',
    mode: 'fly',
    days: 1,
    condition: '仅灵潮涨时可飞渡',
    bidirectional: false,
  },
])
await writeJsonElement(ROOT, 'world/power-system.json', {
  id: 'ps1',
  projectId: pid,
  name: '灵阶',
  description: '练气 → 筑基 → 金丹 → 元婴 → 化神',
  tiers: [
    { id: 't1', systemId: 'ps1', name: '练气', level: 1 },
    { id: 't2', systemId: 'ps1', name: '筑基', level: 2 },
    { id: 't3', systemId: 'ps1', name: '金丹', level: 3 },
    { id: 't4', systemId: 'ps1', name: '元婴', level: 4 },
    { id: 't5', systemId: 'ps1', name: '化神', level: 5 },
  ],
})

// ---- 结构：5 章蓝图 + 3 条线索 ----
const chapters = [
  {
    no: 1,
    title: '第一章 入山',
    goal: '林岚决定上山',
    conflict: '老仆阻拦',
    turn: '',
    hook: '剑冢方向传来一声剑鸣',
    tension: 2,
    beat: 'setup',
    cast: ['c1', 'c5'],
  },
  {
    no: 2,
    title: '第二章 守碑人',
    goal: '问出自己身世的线索',
    conflict: '老仆不肯说',
    turn: '老仆左眉有同样的疤',
    hook: '他说：你不该问',
    tension: 3,
    beat: 'rising',
    cast: ['c1', 'c5', 'c2'],
  },
  {
    no: 3,
    title: '第三章 剑气',
    goal: '越过剑冢边界',
    conflict: '剑气削魂',
    turn: '',
    hook: '碑上浮出一个字',
    tension: 4,
    beat: 'rising',
    cast: ['c1', 'c3'],
    locationId: 'l2',
  },
  {
    no: 4,
    title: '第四章 剑冢',
    goal: '走到碑前看清那个名字',
    conflict: '裴无咎拦路',
    turn: '裴无咎也在找这个名字',
    hook: '碑上的名字是她自己',
    tension: 5,
    beat: 'climax',
    cast: ['c1', 'c4', 'c3'],
    locationId: 'l2',
  },
  {
    no: 5,
    title: '第五章 名字',
    goal: '决定是否念出名',
    conflict: '念名即召残念',
    turn: '',
    hook: '她开口了',
    tension: 5,
    beat: 'twist',
    cast: ['c1', 'c4'],
    locationId: 'l2',
  },
]
for (const ch of chapters) {
  await writeJsonElement(ROOT, `story/blueprints/ch-${String(ch.no).padStart(3, '0')}.json`, {
    id: `b${ch.no}`,
    projectId: pid,
    chapterNo: ch.no,
    title: ch.title,
    goal: ch.goal,
    conflict: ch.conflict,
    ...(ch.turn === '' ? {} : { turn: ch.turn }),
    hook: ch.hook,
    castIds: ch.cast,
    ...(ch.locationId === undefined ? {} : { locationId: ch.locationId }),
    tensionLevel: ch.tension,
    beatType: ch.beat,
  })
}

await writeJsonElement(ROOT, 'story/threads.json', [
  {
    id: 't1',
    projectId: pid,
    kind: 'foreshadow',
    title: '碑上的名字',
    description: '林岚想确认的那个名字',
    plantedChapter: 1,
    advancedChapters: [2, 3],
    status: 'active',
    payoffHint: '林岚读出碑上刻的是自己的名字',
    payoffWindow: 5,
  },
  {
    id: 't2',
    projectId: pid,
    kind: 'running_gag',
    title: '玄阳子讨酒',
    description: '每次出场必问酒',
    plantedChapter: 1,
    advancedChapters: [],
    status: 'active',
  },
  {
    id: 't3',
    projectId: pid,
    kind: 'setup',
    title: '左眉的疤',
    description: '林岚与老仆同位置的疤',
    plantedChapter: 2,
    advancedChapters: [],
    status: 'active',
    payoffWindow: 5,
  },
])

// ---- 文风 ----
await writeJsonElement(ROOT, 'styles/default.json', {
  id: 'style_default',
  projectId: pid,
  name: '冷硬短句',
  description: '短句为主，少形容词；用动作与物象承载情绪，不写“他感到/她心里”这类心理陈述',
  samples: ['风从袖口灌进来。她按住玉牌，指节泛白。', '剑气贴着面颊削过去。她没躲。'],
  bannedWords: ['仿佛', '不禁', '顿时', '宛如', '似乎'],
  bannedPatterns: ['不是……而是……', '空气中弥漫着'],
  quantLimits: { 仿佛: 0, 似乎: 0, 心中: 2 },
  isDefault: true,
})

// ---- 前三章候选稿 + 定稿 ----
const drafts: { chapterNo: number; segs: [string, string][] }[] = [
  {
    chapterNo: 1,
    segs: [
      ['a1a1', '林岚踏上山道，风从袖口灌进来。'],
      ['a1a2', '“再往上，就是剑冢了。”老仆的声音从身后传来。'],
    ],
  },
  {
    chapterNo: 2,
    segs: [
      ['b2b1', '老仆的手停在半空。'],
      ['b2b2', '他左眉上，有一道和林岚一样的疤。'],
    ],
  },
  {
    chapterNo: 3,
    segs: [
      ['c3c1', '剑气贴着面颊削过去。'],
      ['c3c2', '碑上浮出一个字，她认不出，却觉得眼熟。'],
    ],
  },
]
for (const d of drafts) {
  await writeSceneFile(
    ROOT,
    { sceneNo: 1, version: 1, segments: d.segs.map(([segId, text]) => ({ segId, text })) },
    d.chapterNo,
  )
}

await mergeChapter(ROOT, {
  chapterNo: 1,
  title: '第一章 入山',
  scenes: [
    {
      sceneNo: 1,
      text: '林岚踏上山道，风从袖口灌进来。\n\n“再往上，就是剑冢了。”老仆的声音从身后传来。',
    },
  ],
})
await mergeChapter(ROOT, {
  chapterNo: 2,
  title: '第二章 守碑人',
  scenes: [{ sceneNo: 1, text: '老仆的手停在半空。\n\n他左眉上，有一道和林岚一样的疤。' }],
})
await mergeChapter(ROOT, {
  chapterNo: 3,
  title: '第三章 剑气',
  scenes: [{ sceneNo: 1, text: '剑气贴着面颊削过去。\n\n碑上浮出一个字，她认不出，却觉得眼熟。' }],
})

// ---- 重建索引 ----
const db = await openBookIndexDb(ROOT)
try {
  const report = await reindex(ROOT, db)
  console.log('✓ 索引重建：', JSON.stringify(report))
} finally {
  await db.$disconnect()
}

// ---- 清掉夹具里的 .git 与派生索引 ----
// 夹具是外层仓库里的样本，不该是嵌套 git 仓库；index.sqlite 是派生物
await rm(join(ROOT, '.git'), { recursive: true, force: true })
await rm(bookPaths(ROOT).indexDb, { force: true, maxRetries: 5, retryDelay: 100 })

// README 里补一句（createProject 已写，这里覆盖成夹具版）
await writeFile(
  join(ROOT, 'README.md'),
  '# 七霞\n\ninkloom 的示例书（fixture）。一物四用：单测输入、集成数据、E2E 种子、人工评估样本。\n\n' +
    '5 个角色 / 5 章蓝图 / 3 条线索 / 5 个境界 / 前 3 章正文已完成。\n\n' +
    '重新生成：`pnpm fixture`\n',
  'utf8',
)

console.log('✓ 夹具生成完成：fixtures/qixia')
