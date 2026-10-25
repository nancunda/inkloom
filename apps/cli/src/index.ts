#!/usr/bin/env node
import * as cmd from './commands.js'
import * as review from './commands-review.js'
import { parseFlags } from './flags.js'

const USAGE = `inkloom <command> [options]

建书与索引
  create <dir> --name <书名> --genre <题材> [--core-idea …] [--premise …] [--theme …] [--tone …]
  reindex <dir>                                从文件重建索引（索引删了也能救回来）

生成
  write <dir> --chapter N [--guidance "…"] [--model "…"]   生成第 N 章的场景候选稿

审阅与定稿
  scenes   <dir> --chapter N                                  列出本章场景与状态
  accept   <dir> --chapter N --scene M --version V            接受某版本
  reject   <dir> --chapter N --scene M --version V            拒绝某版本（文件保留）
  edit     <dir> --chapter N --scene M --version V --seg XXXX --text "…"
                                                              改一段 → 产新版本
  rewrite  <dir> --chapter N --scene M --version V --seg XXXX [--guidance "…"]
                                                              模型重写这一段 → 产新版本
  diff     <dir> --chapter N --scene M --from V1 --to V2      字符级 diff
  finalize <dir> --chapter N [--title "…"]                    定稿（要求无 candidate）
  unfinalize <dir> --chapter N                                撤销定稿
  propose  <dir> --chapter N                                  提取状态变更提案
  apply-proposals <dir> --chapter N --accept all|1,3          应用确认的提案

要素（append-only，永不覆盖历史）
  element set <dir> --type <t> --id <id> --rel <path> --json <json> [--reason <说明>]
  element rollback <dir> --type <t> --id <id> --rel <path> --to <version>
  element delete <dir> --type <t> --id <id> --rel <path>      软删除（可恢复）
  element history <dir> --type <t> --id <id>                  查看版本历史

时间点
  checkpoint <dir> --label <说明>              建检查点（Git + 要素历史同点）
  checkpoints <dir>                            列出检查点
  rollback <dir> --to <checkpointId>           回退到某个检查点

导出
  export <dir> --format json|md|txt [--out <file>]

type 取值：character | blueprint | world_rule | plot_thread | style_asset
          | character_signature | writing_technique | location | route | lore_reference
`

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }
  const { positional, flags } = parseFlags(args)
  const ctx = { positional, flags }

  switch (command) {
    case 'create':
      await cmd.create(ctx)
      break
    case 'reindex':
      await cmd.reindexCmd(ctx)
      break
    case 'write':
      await cmd.write(ctx)
      break
    case 'scenes':
      await review.scenes(ctx)
      break
    case 'accept':
      await review.accept(ctx)
      break
    case 'reject':
      await review.reject(ctx)
      break
    case 'edit':
      await review.edit(ctx)
      break
    case 'rewrite':
      await review.rewrite(ctx)
      break
    case 'diff':
      await review.diffScene(ctx)
      break
    case 'finalize':
      await review.finalize(ctx)
      break
    case 'unfinalize':
      await review.unfinalize(ctx)
      break
    case 'propose':
      await review.propose(ctx)
      break
    case 'apply-proposals':
      await review.applyProposals(ctx)
      break
    case 'element': {
      const sub = positional[0]
      if (sub === undefined)
        throw new Error('用法：inkloom element <set|rollback|delete|history> ...')
      // 让子命令也能拿到 dir（位置参数第 2 个）
      const shifted = { positional: positional.slice(1), flags }
      if (sub === 'set') await cmd.elementSet(shifted)
      else if (sub === 'rollback') await cmd.elementRollback(shifted)
      else if (sub === 'delete') await cmd.elementDelete(shifted)
      else if (sub === 'history') await cmd.elementHistory(shifted)
      else throw new Error(`未知子命令：element ${sub}`)
      break
    }
    case 'export':
      await cmd.exportCmd(ctx)
      break
    case 'checkpoint':
      await cmd.checkpoint(ctx)
      break
    case 'checkpoints':
      await cmd.listCheckpoints(ctx)
      break
    case 'rollback':
      await cmd.rollbackCmd(ctx)
      break
    default:
      console.error(`未知命令：${command}\n\n${USAGE}`)
      process.exit(1)
  }
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
