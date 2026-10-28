# AgentPrism（已复制源码）

- 上游：https://github.com/evilmartians/agent-prism
- 复制时 commit：`4fd371b5e4f25acd04278e94a0d4b21e543eb42c`
- 来源目录：`packages/ui/src/components`
- 许可证：MIT（见上游仓库）
- 复制日期：2026-10-28

## 我们对上游做的改动（升级时按此清单重放）

1. Tailwind 3 → 4 主题适配：`apps/web/src/index.css` 里用 `@theme inline` 把
   `--agentprism-*` 映射成 `--color-agentprism-*`（83 个 token，与 `theme/index.ts`
   的 `AGENT_PRISM_TOKENS` 一一对应）。
2. `rounded-sm` → `rounded-xs`（2 处：`roundedClasses.ts`、`SpanCard/SpanCardTimeline.tsx`）。
3. `shadow-sm` → `shadow-xs`（1 处：`Tabs.tsx`）。
4. `outline-none` → `outline-hidden`（1 处：`SpanCard/SpanCard.tsx`）。
5. `DetailsView` 增加 `extraTabs` 支持（切片 4）。
6. `TraceList` 增加可选 `onRename` / `onDelete`（切片 4）。

## 维护约定

- 不跟随上游自动升级；需要升级时重新 degit，并按上面清单重放改动。
- 本目录排除在 Biome 之外（上游风格不同：双引号、有分号），但**必须**通过 `tsc`
  —— 不要在 `tsconfig` 里 exclude 它。
- 新增 tab / 回调时优先改本目录的 `DetailsView`、`TraceList`，不要在外层包一层再转发。
