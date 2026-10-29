# 桌面版：Tauri 壳 + 本地服务端

**日期**：2026-10-29
**目标**：双击即用，不用开浏览器、不用记 `pnpm api`；同时把共创页「每个 token 重建整棵树」和「输入框被顶出视口」两个问题修掉。

---

## 1. 为什么不是「换个壳就快了」

慢的根因在前端运行时：SSE 的 token 级 delta 每来一条就 `setEvents` → 全量排序 → `toTraceData` 重建整棵树 → 整页重渲染。Electron / Tauri 用同一套 Chromium 渲染路径，换壳不会让它变快。

所以这一轮分两块，互不替代：

1. **Web 侧修根因**（本 spec §2）；
2. **桌面壳**（本 spec §3），买到的是「启动方式与产品形态」，不是性能。

## 2. Web 侧：性能与布局

### 2.1 事件批量刷新

- SSE 消息先塞进 `pending` ref，攒 **80ms** 再一次性 `mergeEvents` 入状态；离开运行态前强制 flush，避免最后半句丢失。
- `mergeEvents` 拆到 `apps/web/src/agent-trace/merge-events.ts` 并加**追加快路径**：同一 run 的递增 seq / 全新 run 直接 `[...prev, ...incoming]`；只有重连回放、乱序才走 map + 排序。
- 效果：token 级事件从「每条一帧」变成「每 80ms 一帧」，整树重建次数降一个数量级。

### 2.2 布局护栏（输入框被裁）

复现：1440×380 时文档高 432 > 视口 380，共创输入框被顶出。

- 根因：左栏（十个模块 + 时间机器）内容高于可用空间，`shrink-0` 且不滚动，把整行撑高；根节点只设了 `h-screen`，没有锁 `overflow`。
- 修法：`html/body/#root` 高度铺满 + `body { overflow: hidden }`；壳层用 `h-dvh`；左栏 `min-h-0` + 列表 `overflow-y-auto`；书库页改成自己的滚动容器。
- 回归断言（真机）：1440×380 下 `document.scrollHeight === innerHeight`，输入框 bottom < 视口。

### 2.3 不做

- 虚拟化 span 列表（56 个 span 时收益小，等真到几百个再加）；
- 增量 trace 对象复用（批量化后已够；要做得先解决 span 身份问题）。

## 3. 桌面壳

### 3.1 选型

Tauri 2（Rust + 系统 WebView2）。对比 Electron：产物体积小一半；代价是开发机要装 Rust/MSVC。已装：`rustc 1.99.1`，WebView2 145。**不用 Tauri 的 sidecar 插件**——Rust 侧直接 `std::process::Command` 起本地服务，少一层权限配置。

### 3.2 结构

```
apps/desktop/
├── package.json            # @tauri-apps/cli
├── scripts/stage-server.mjs# release/ 最新便携版 → src-tauri/server（打时间戳跳过）
├── web-stub/index.html     # 启动等待页 / 失败页（窗口一开就有东西看）
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json     # 1440×900、最小 1100×720、NSIS、资源 server/**/*
    ├── capabilities/default.json
    ├── src/main.rs
    └── icons/
```

### 3.3 启动流程

1. 建窗口（**先加载本地等待页**，不是白屏）；
2. 取一个空闲端口（`bind 127.0.0.1:0`）；
3. 起服务端：`server/node.exe app/node_modules/tsx/dist/cli.mjs app/apps/api/src/server.ts`，`cwd=server`，`PORT=<port>`，`INKLOOM_LIBRARY` 未设置时默认 `~/inkloom`；Windows 下 `CREATE_NO_WINDOW` 不弹黑框；stdout/stderr 写 `%APPDATA%\inkloom\server.log`；
4. 探活：真正 `GET /api/library` 直到 200（最多 90 秒）；
5. `window.navigate(http://127.0.0.1:<port>/)`；失败则把错误写进等待页（含日志路径）；
6. 退出时 kill 子进程（`RunEvent::Exit` / `ExitRequested`）。
7. 单实例：`tauri-plugin-single-instance`（第一个注册），再双击只把已有窗口唤到前台，不会起第二个服务端。

### 3.4 与浏览器版的一致性

- 书库默认 `~/inkloom`，与 CLI、浏览器版相同；外部设了 `INKLOOM_LIBRARY` 就尊重外部（开发时指向 `.tmp-library`）。
- **配置放用户目录** `%APPDATA%\inkloom\.env`，不放在安装目录：NSIS 的 currentUser 安装就是 `%LOCALAPPDATA%\inkloom`，把 .env 放那儿会在卸载时连 key 一起删。壳层给子进程传 `--env-file-if-exists=<该路径>` 与 `INKLOOM_ENV_FILE`，设置页 `PUT /api/settings` 写入同一文件，下次启动自动加载。便携版与开发版不设这两个变量，仍是 `cwd/.env`。
- 前端零改动：服务端同时托管 `apps/web/dist`（`INKLOOM_WEB_DIST` 可覆盖），SSE 同源。
- 端口随机：桌面版不会和开发用的 8787 抢。

### 3.5 打包

`stage-server.mjs`（release → resources）→ `tauri build` → NSIS（currentUser，简体中文）。
产物预估：安装包 60–90 MB（压缩后），安装后约 250–300 MB。

### 3.6 不做（这一轮）

自动更新、托盘常驻、开机自启、代码签名、把 API 改写成 Rust、把 Node 运行时换成 SEA。
