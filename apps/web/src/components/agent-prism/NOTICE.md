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
5. `DetailsView/DetailsView.tsx`：新增 `extraTabs`（在 Attributes 之后、RAW 之前插入），
   与内置 id 撞名的 key 会被忽略。`DetailsViewTab` 联合类型尾部加 `(string & {})`，
   保留内置 tab 的字面量提示同时允许自定义 key。
6. `TraceList/TraceList.tsx`：新增可选 `onRename` / `onDelete`；
   `onExpandStateChange` 改为**可选**，不传时折叠按钮隐藏（否则在内嵌面板里就是个死按钮）。
   新增 `TraceListItemMenu.tsx`（`…` 菜单，原生 button + 绝对定位，无新依赖；
   Esc 关闭、点击外部关闭、最后一行向上展开；只传一个回调时只显示那一项）。
7. `TraceListItemHeader.tsx` / `TraceListItem.tsx`：新增 `actions` 插槽（渲染在 span 徽标左侧），
   避免菜单用绝对定位盖住徽标。

不在本目录、但属于同一套适配的改动：

8. `apps/web/src/index.css` 用 `@theme inline` 把 83 个 `--agentprism-*` 映射成
   `--color-agentprism-*`（与 `theme/index.ts` 的 `AGENT_PRISM_TOKENS` 一一对应）。
9. `apps/web/src/index.css` 用同特异度的 `:root` **覆盖** `theme.css` 的浅/深两套值，
   固定为浅色（应用没有暗色模式），并把表面/文字/边框/品牌色对齐到项目的 `neutral-*`
   阶梯（spec §8.3）。`theme.css` 本身未改。
10. `apps/web/src/index.css` 用 `@custom-variant dark (&:where(.dark, .dark *))` 把
    `dark:` 改为 class 驱动，否则组件里的 `dark:` 类会跟着系统深色偏好乱亮。

## 维护约定

- 不跟随上游自动升级；需要升级时重新 degit，并按上面清单重放改动。
- 本目录整体排除在 Biome 之外（上游风格：双引号、有分号），但**必须**通过 `tsc`
  —— 不要在 `tsconfig` 里 exclude 它。
- 排除的代价：第 5–7 条手改的 `DetailsView.tsx` / `TraceList*.tsx` 同样没有 lint
  兜底（`noExplicitAny`、hooks 规则都不生效）。改这几个文件时靠人工 review + `tsc`。
- 新增 tab / 回调时优先改本目录的 `DetailsView`、`TraceList`，不要在外层包一层再转发。
- inkloom 自己的适配层在 `apps/web/src/agent-trace/`（`to-trace.ts` 事件→span、
  `SessionList.tsx` 收窄 `TraceList`），不要去改上游的映射逻辑。
