# 图谱可视化 / 图算法 / 联网检索 技术栈核实报告

- 核实日期：2026-10-27（版本、发版日、包体、提交数、星标均为当日抓取）
- 证据源：各项目官方站与仓库、npm registry、GitHub REST API、bundlephobia；不可达项标注「未核实」
- 约束前提：React 19 + Vite + @xyflow/react 12 + Hono + Node 24，Windows 便携版，无 Docker，本地优先

## 0. 结论速览

| 议题 | 结论 |
|---|---|
| 图可视化 | 选 **Cytoscape.js 3.34.4**：唯一同时内置 compound + 布局 + 全算法 + 最短路径元素回传 |
| 图算法库 | **不引 graphology**；Cytoscape 官方支持 Node headless 跑算法，前后端共用一套实现 |
| RDF/OWL | **不做**。Oxigraph 0.5.13 纯 WASM 可跑 SPARQL 1.1，但仅内存态，收益不抵成本 |
| 内嵌图库 | Kuzu 已归档淘汰；LadybugDB 确有 win32-x64 预编译，但暂不引入 |
| 联网搜索 | 降级链：Tavily → Brave → Firecrawl keyless → SearXNG 公共实例 → DDG lite |
| 正文提取 | `@mozilla/readability` 0.6.0 + linkedom（仅 Node 侧，不进前端包体） |

## 1. 图可视化四选一

### 1.1 版本 / 活跃度 / 体积（2026-10-27 实测）

| 项目 | 最新版 | 许可证 | min+gzip | 运行依赖 | 近 6 月提交 | Stars |
|---|---|---|---|---|---|---|
| Cytoscape.js | 3.34.4（2026-10-15） | MIT | 435KB / 137KB | 0 | ≥100 | 11.3k |
| AntV G6 | 5.1.1（2026-05-08） | MIT | 1.40MB / 400KB | 11 | 13 | 12.4k |
| Sigma.js | 4.0.3（2026-10-15） | MIT | 374KB / 97KB | 2（另需 graphology） | ≥100 | 12.2k |
| @xyflow/react | 12.12.0（2026-09-24） | MIT | 188KB / 60KB | 3 | ≥100 | 38.8k |

### 1.2 能力矩阵

| 能力项 | Cytoscape 3.34.4 | G6 5.1.1 | Sigma 4.0.3 | @xyflow/react 12.12 |
|---|---|---|---|---|
| React 19 集成 | 无官方封装；建议 useEffect 命令式封装 | 官方 useEffect+ref 示例 | 官方 @react-sigma/core 6.0.0（peer ^18‖^19）最佳 | 原生组件 |
| 内置布局 | grid/circle/concentric/breadthfirst/cose（原生支持 compound） | force/d3-force/forceAtlas2/fruchterman/circular/concentric/grid/radial/dagre/comboCombined/4 种树布局 | **无**（算法交给 graphology） | **无**（官方：未实现布局） |
| compound/parent | 原生 `parent` 复合节点 | 原生 Combo（可展开收起） | 无 | Sub Flow（需绝对坐标） |
| 拖拽 / 框选 | 有 / boxSelection | drag-element + brush-select | 拖拽自写，框选自写 | 有 / selectionOnDrag |
| 最短路径 + 高亮 | dijkstra/aStar/bellmanFord/floydWarshall + `.path()` 直接回传元素 | `findShortestPath()` 取自 @antv/algorithm（2023-08 停更） | graphology-shortest-path，高亮自绘 | 无 |
| 图算法 | pageRank、三类中心性、连通分量、tarjan SCC 全内置 | 依赖 @antv/algorithm | graphology-metrics / traversal / louvain | 无 |
| 万级节点 | canvas 可行；cose 偏慢（配 fcose）「未实测」 | canvas，大图需性能模式「未实测」 | WebGL 最强「未实测」 | DOM 节点，千级舒适 |
| TS 类型 | 需 @types/cytoscape 3.31.0（落后于运行时） | 原生 | 原生 | 原生（最佳） |

### 1.3 推荐：Cytoscape.js 3.34.4 作本体图主渲染

1. **一库三用**：compound 承载「类 → 实例」分组，内置力导向/层次/同心布局，最短路径与中心性同源，不必再拼 4 个包。
2. 官方原文支持 **「use Cytoscape.js headlessly on Node.js to do graph analysis」** → Agent 工具与前端共用同一份 elements 与同名算法，避免双实现漂移。
3. 活跃度/体积最优：0 运行依赖、137KB gzip；G6 则 400KB + 11 依赖且 5.5 个月未发版。
4. 代价：需自写 React 封装（约 150 行：容器 ref、实例缓存、数据 diff、StrictMode 双挂载保护），@types 落后需局部断言。

不选其他三家：G6 停止发版 + 算法包 2023 停更 + 包体最大；Sigma 无 compound、无布局、无内置算法；React Flow 无布局无算法、DOM 节点到万级会卡（与现状「节点不可拖、无聚类、无路径高亮」痛点重合），保留给流程/小图场景。

## 2. 图数据结构 / 算法库取舍

| 方案 | 状态 | 优点 | 缺点 | 后端引入 |
|---|---|---|---|---|
| graphology | 0.26.0（npm 2025-01-26，近 6 月 6 次提交） | 纯 JS 无 DOM，算法分包 | 事实维护模式；无 compound；需再装 3~4 包 | 否 |
| Cytoscape 内置算法 | 3.34.4 | 前后端同一实现，算法覆盖最全 | headless 需构造 cy 实例（万级毫秒级，可缓存） | 是（复用） |
| 自研纯函数 | — | 零依赖、易测、可控 | 中心性/最短路径的权重语义要自己保证 | 仅补本体校验逻辑 |

## 3. RDF/OWL 路线

| 库 | 版本/日期 | 结论 |
|---|---|---|
| Oxigraph | 0.5.13（2026-10-22） | 包内 node_bg.wasm 4.3MB，**纯 WASM 无原生依赖**；README 明确 in-memory store + SPARQL 1.1 Query/Update，支持 Turtle/TriG/N-Triples/N-Quads/RDF-XML，Node 18+ |
| N3.js | 2.13.12（2026-10-10） | 流式解析 + 内存 Store（getQuads 模式匹配），**无 SPARQL 引擎** |
| rdflib.js | 2.4.1（2026-09-18） | 仍在维护（Solid 生态），SPARQL 覆盖度「未核实」 |

**建议：不做 RDF 只读索引。** 成本：本体→IRI 映射与词表选型 2~4 人日、每次变更重导出、Agent 生成 SPARQL 的错误率与调试成本、+4.3MB WASM 冷启动。收益：标准化导出/外部互操作，而本项目查询多为 1~2 跳邻居与路径，JSON + 内存索引已足够。若将来需对外发布本体，用 N3.js 写一次性导出器（半天）即可，不引 SPARQL 运行时。

## 4. 内嵌图数据库

- **Kuzu：淘汰。** npm `kuzu` 0.11.3 已被官方标记 deprecated；GitHub `kuzudb/kuzu` archived=true，最后 push 2025-10-10。
- **LadybugDB：有预编译 win32-x64。** `@ladybugdb/core` 0.22.0（2026-10-25，MIT），optionalDependencies 含 `@ladybugdb/core-win32-x64@0.22.0`（15.6MB）；仓库仍活跃。
- 暂不引入：① core 仍把 `cmake-js` 列为运行时依赖，预编译下载失败会回退源码构建；② 依赖 node-addon-api，Node 24 未实测；③ 便携包 +15MB 且需管理 db 目录与独占文件锁；④ 万级三元组内存查询已毫秒级，Cypher 表达力收益 < 运维成本。列 P3 观察。

## 5. 联网搜索（免费 / 开源）

| 方案 | key | 免费额度 | 主要失败模式 | 备注（2026-10-27） |
|---|---|---|---|---|
| SearXNG 自托管 | 无 | 无限（自付资源） | 无 Docker 需自带 Python+Redis；上游引擎超时；`format=json` 未开启则 **403** | 便携版部署成本高 |
| SearXNG 公共实例 | 无 | 视实例 | 官方文档：很多公共实例禁用 JSON → 403；429；实例下线 | 需多实例轮询 + 探活 |
| DuckDuckGo html/lite | 无 | 无承诺 | 需 vqd token + 浏览器 UA；高频 403/挑战页；随时改版 | **未实测** |
| Firecrawl keyless | 无 | 按 IP 每日双上限（数值未公布） | 429；质量依赖其抓取链路 | 有 key 赠 1,000 credits |
| Brave Search API | 有 | 2026 起每月 $5 credit（≈1,000 次） | 401/402；1 QPS | 定价页未直接核实 |
| Tavily | 有 | 1,000 credits/月，无需绑卡 | 432/429 | docs.tavily.com 已核实 |

**降级链**：有 key → `Tavily → Brave → Firecrawl(keyless 兜底)`；零 key → `SearXNG 公共实例(3~5 个轮询) → DDG lite → Firecrawl keyless → 明确提示「未联网/需配 key」`。每跳 8s 超时，单 provider 连续 2 次失败熔断 10 分钟，结果统一归一化为 `{title,url,snippet,publishedAt,provider}`（附 `degraded:true` 供 UI 提示）。

## 6. 网页正文提取

| 方案 | 版本/日期 | min+gzip | 能力 | 定位 |
|---|---|---|---|---|
| @mozilla/readability | 0.6.0（2025-03-03，Apache-2.0） | 34KB / 11KB | 需真实 DOM | 正文识别最佳（Firefox 阅读模式同源） |
| linkedom | 0.18.14（2026-10-21，ISC） | 231KB / 75KB | 轻量 DOM，可喂 Readability | 给 Readability 供 DOM |
| cheerio | 1.2.0（2026-01-23，MIT） | 316KB / 119KB | 无 DOM，只做选择器抽取 | 站点专用兜底 |

**结论：readability + linkedom。** 中文站编码需按 meta charset / Content-Type 用 `TextDecoder('gb18030')` 先解码（Node 官方发行版含 full-icu；未实测）。

## 7. 落地建议与待实测

- **P0**：抽 `graph-model` 投影层（现有 JSON 为唯一真相源 → cytoscape elements）；Cytoscape 封装组件；Agent 工具 `graph.neighbors` / `graph.path` / `graph.rank` 走 Node headless 同一实现。
- **P1**：compound 分组折叠、边类型过滤、布局切换（cose/breadthfirst/concentric）、最短路径高亮、节点拖拽保存布局。
- **P2**：搜索 provider 抽象 + 降级链；readability 正文提取。
- **待实测**：Cytoscape 1 万节点拖拽帧率；React 19 StrictMode 双挂载；@types/cytoscape 3.31 与 3.34 的 API 缺口；LadybugDB win32 在 Node 24 的加载。

## 附：证据链接

- cytoscape: js.cytoscape.org（布局/算法章节）、github.com/cytoscape/cytoscape.js releases v3.34.4
- g6: g6.antv.antgroup.com（layout、combo、integration/react、shortest-path）
- sigma: sigmajs.org；@react-sigma/core npm 6.0.0
- xyflow: reactflow.dev/learn/layouting/layouting、/learn/advanced-use/performance
- oxigraph: npm oxigraph 0.5.13 README
- ladybug: github.com/LadybugDB/ladybug；npm @ladybugdb/core-win32-x64 0.22.0
- searxng: docs.searxng.org/dev/search_api.html
- firecrawl: docs.firecrawl.dev/rate-limits；tavily: docs.tavily.com/documentation/api-credits
