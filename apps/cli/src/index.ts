#!/usr/bin/env node
import * as cmd from './commands.js'
import { parseFlags } from './flags.js'

const USAGE = `inkloom <command> [options]

建书与索引
  create <dir> --name <书名> --genre <题材>     建一本新书
  reindex <dir>                                从文件重建索引（索引删了也能救回来）

生成
  write <dir> --chapter N [--guidance "…"] [--model "…"]   生成第 N 章的场景候选稿

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
