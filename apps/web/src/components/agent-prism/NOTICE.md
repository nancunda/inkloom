# AgentPrism（已复制源码）

- 上游：https://github.com/evilmartians/agent-prism
- 复制时 commit：`4fd371b5e4f25acd04278e94a0d4b21e543eb42c`
- 来源目录：`packages/ui/src/components`
- 许可证：MIT（见上游仓库）
- 复制日期：2026-10-28

## 我们对上游做的改动（升级时按此清单重放）

已实现的源码改动：

1. `rounded-sm` → `rounded-xs`（2 处：`roundedClasses.ts`、`SpanCard/SpanCardTimeline.tsx`）。
2. `shadow-sm` → `shadow-xs`（1 处：`Tabs.tsx`）。
3. `outline-none` → `outline-hidden`（1 处：`SpanCard/SpanCard.tsx`）。
4. `DetailsView/DetailsViewJsonOutput.tsx`：去掉 `import colors from "tailwindcss/colors"`
   （运行时 import 构建期包，会把整份调色板打进客户端），布尔值改用
   `oklch(var(--agentprism-code-boolean))`；该变量定义在 `index.css` 的 `:root` 里。

不在本目录、但属于同一套适配的改动：

5. `apps/web/src/index.css` 用 `@theme inline` 把 83 个 `--agentprism-*` 映射成
   `--color-agentprism-*`（与 `theme/index.ts` 的 `AGENT_PRISM_TOKENS` 一一对应）。
6. `apps/web/src/index.css` 用同特异度的 `:root` **覆盖** `theme.css` 的浅/深两套值，
   固定为浅色（应用没有暗色模式），并把表面/文字/边框/品牌色对齐到项目的 `neutral-*`
   阶梯（spec §8.3）。`theme.css` 本身未改。
7. `apps/web/src/index.css` 用 `@custom-variant dark (&:where(.dark, .dark *))` 把
   `dark:` 改为 class 驱动，否则组件里的 `dark:` 类会跟着系统深色偏好乱亮。

尚未实现（切片 4 的后续任务，做完请移到上面）：

8. `DetailsView` 增加 `extraTabs` 支持（**尚未实现**）。
9. `TraceList` 增加可选 `onRename` / `onDelete`（**尚未实现**）。

## 维护约定

- 不跟随上游自动升级；需要升级时重新 degit，并按上面清单重放改动。
- 本目录整体排除在 Biome 之外（上游风格：双引号、有分号），但**必须**通过 `tsc`
  —— 不要在 `tsconfig` 里 exclude 它。
- 排除的代价：第 8、9 条要手改的 `DetailsView.tsx` / `TraceList.tsx` 同样没有 lint
  兜底（`noExplicitAny`、hooks 规则都不生效）。改这两个文件时靠人工 review + `tsc`。
- 新增 tab / 回调时优先改本目录的 `DetailsView`、`TraceList`，不要在外层包一层再转发。
