# 阅读器实现计划

> **Spec**：`docs/superpowers/specs/2026-10-29-book-reader-design.md`
> 执行方式：逐任务实现 + 每个任务自测；最后整支 CodeReview 一轮。

**目标**：新增「阅读」模块，把正文排成可翻页的书（桌面双页对开 / 窄屏单页滚动）。

**技术栈**：React 19 + Tailwind 4 + 现有 TanStack Query hooks；分页靠 CSS multi-column。

---

### Task 1：分页与阅读位置的纯函数

**Files**
- Create: `apps/web/src/reader/paginate.ts`
- Create: `apps/web/src/reader/paginate.test.ts`
- Create: `apps/web/src/reader/reading-position.ts`
- Create: `apps/web/src/reader/reading-position.test.ts`

**接口**
- `columnCount(scrollWidth: number, colWidth: number, gap: number): number` — `scrollWidth <= 0` 返回 0；否则 `ceil((scrollWidth - 1) / (colWidth + gap))`
- `spreadCount(columns: number): number` — `ceil(columns / 2)`
- `translationFor(spread: number, colWidth: number, gap: number): number` — `-2 * spread * (colWidth + gap)`
- `clampSpread(spread: number, spreads: number): number`
- `spreadAfterReflow(spread: number, fromSpreads: number, toSpreads: number): number` — 按比例，`fromSpreads <= 1` 时回 0
- `pageNumbers(spread: number, columns: number): { left: number; right: number }` — 未满的右页返回 0（不显示页码）
- `loadReadingPosition(storage, bookId): { chapterNo: number; spread: number } | null`；坏 JSON / 负值 / 版本不符返回 null
- `saveReadingPosition(storage, bookId, pos): void`（写入失败静默）

**步骤**：先写测试（含 0、1、奇数、负数、坏数据），再实现，`vitest --project unit` 全绿。

---

### Task 2：阅读页壳（可读）

**Files**
- Create: `apps/web/src/pages/ReadPage.tsx`
- Modify: `apps/web/src/stores/session.ts`（`read` 模块 + `immersive`）
- Modify: `apps/web/src/shell/AppShell.tsx`（模块项、lazy、沉浸时隐藏 chrome）
- Modify: `apps/web/src/index.css`（`--color-paper-*` token、纸纹）

**内容**
- 左栏「阅读」（❧）+ 命令面板自动带上
- 目录抽屉：全部章节（序号 / 章名 / 字数 / 定稿点），当前章高亮，↑↓ / Enter
- 章节切换、空章态（「本章尚未成文」+ 去写作页）
- 单页滚动排版（先用同一套段落渲染，供窄屏与降级）

---

### Task 3：双页对开 + 页眉页脚 + 章扉页 + 翻页

**Files**
- Create: `apps/web/src/reader/BookSpread.tsx`（测量、列数、translateX、页眉页脚、扉页块）
- Modify: `ReadPage.tsx`

**要点**
- `ResizeObserver` + `document.fonts.ready` 后重算列数
- 扉页块 `height: 页高` + `break-after: column`
- 页码：左页 `2s+1`、右页 `2s+2`（超过列数不显示）
- 翻页动画 220ms，`prefers-reduced-motion` 关闭
- 窄屏（<1180）自动退化成单页滚动

---

### Task 4：体感收尾

- 位置记忆（进入还原、翻页/换章落盘）+ 字号 A− / A+（按比例保留位置）
- 键盘：← → PgUp PgDn 空格 Home End `c` `f` Esc
- 沉浸：隐藏左右栏与顶栏，Esc 退出
- `aria-live` 播报页码；按钮 `aria-label`
- 章末「下一章」卡片

---

### Task 5：验收与文档

- 真机：1440×900 双页 / 1024 单页 / 375 手机；键盘、位置记忆、字号、reduced-motion
- 截图 `docs/screenshots/accept-reader.png`
- README：模块表 + 阅读器小节 + 验收记录
- `pnpm verify` 全绿；整支 CodeReview
