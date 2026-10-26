import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  mergePlan,
  type Plan,
  type PlanDef,
  type PlanState,
  planDefFileSchema,
  planStateSchema,
} from '@inkloom/shared'
import { atomicWrite, readIfExists } from './atomic-write.js'
import { bookPaths } from './paths.js'

/**
 * 计划的两种落盘：
 *   - 定义：`story/plans/<id>.json`（进 git，可审阅/回滚）
 *   - 状态：`.inkloom/agent/plans/<id>.state.json`（不进 git，随运行更新）
 *   - 指针：`.inkloom/agent/current-plan`（下一次启动恢复用）
 *
 * ★ 任何写都必须走 writeQueue（调用方在工具层排队），这里只负责原子写。
 * ★ 所有读取都容错：坏文件返回 null，绝不让 UI/门禁因一个坏 JSON 全挂。
 */

function assertPlanId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`非法的 plan id：${id}`)
  }
}

export function planDefPath(root: string, id: string): string {
  assertPlanId(id)
  return join(bookPaths(root).story, 'plans', `${id}.json`)
}

export function planStatePath(root: string, id: string): string {
  assertPlanId(id)
  return join(bookPaths(root).inkloom, 'agent', 'plans', `${id}.state.json`)
}

export function currentPlanPath(root: string): string {
  return join(bookPaths(root).inkloom, 'agent', 'current-plan')
}

export async function writePlanDef(root: string, def: PlanDef): Promise<void> {
  const path = planDefPath(root, def.id)
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, `${JSON.stringify(def, null, 2)}\n`)
}

export async function readPlanDef(root: string, id: string): Promise<PlanDef | null> {
  const raw = await readIfExists(planDefPath(root, id))
  if (raw === null) return null
  try {
    const parsed = planDefFileSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function writePlanState(root: string, id: string, state: PlanState): Promise<void> {
  const path = planStatePath(root, id)
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`)
}

export async function readPlanState(root: string, id: string): Promise<PlanState | null> {
  const raw = await readIfExists(planStatePath(root, id))
  if (raw === null) return null
  try {
    const parsed = planStateSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function loadPlan(root: string, id: string): Promise<Plan | null> {
  const def = await readPlanDef(root, id)
  if (def === null) return null
  return mergePlan(def, await readPlanState(root, id))
}

export async function listPlanIds(root: string): Promise<string[]> {
  try {
    const entries = await readdir(join(bookPaths(root).story, 'plans'), { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length))
      .filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id))
  } catch {
    return []
  }
}

export async function setCurrentPlan(root: string, id: string): Promise<void> {
  const path = currentPlanPath(root)
  await mkdir(dirname(path), { recursive: true })
  await atomicWrite(path, `${id}\n`)
}

export async function readCurrentPlan(root: string): Promise<string | null> {
  const raw = await readIfExists(currentPlanPath(root))
  const id = raw?.trim() ?? ''
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : null
}
