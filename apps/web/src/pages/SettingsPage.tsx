import { useBook } from '../api/hooks'

/**
 * 设置（spec §2.1 ⑦）：模型、判断层、项目配置。
 *
 * ★ 本轮只展示「当前生效的配置」与「怎么改」，不假装有表单：
 *   这些值都在环境变量与 novel.json 里，前端编辑要另加写接口。
 *   把「真实来源」写清楚，比给一个假的开关更诚实。
 */
export function SettingsPage() {
  const { data: book } = useBook()

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-8">
        <header>
          <h1 className="text-lg font-semibold text-neutral-900">设置</h1>
          <p className="mt-1 text-xs text-neutral-500">
            配置的来源只有两处：项目目录里的文件，和启动时的环境变量。
          </p>
        </header>

        <Card title="项目">
          <Row k="书名" v={book?.name ?? '—'} />
          <Row k="体裁" v={book?.genre ?? '—'} />
          <Row k="项目 ID" v={book?.id ?? '—'} mono />
          <Row k="文件夹锚点" v={book?.folderId ?? '—'} mono />
          <Row k="元数据" v="novel.json（直接改文件即可，索引可重建）" />
        </Card>

        <Card title="模型">
          <Row k="生成" v="deepseek-flash（DEEPSEEK_API_KEY，.env 或环境变量）" />
          <Row k="判断层" v="硅基流动 / TypeSafe JEV（INKLOOM_JUDGE=off|mock|openai|typesafe）" />
          <Row k="生图" v="硅基流动 Kolors（SILICONFLOW_API_KEY）" />
          <Row k="搜索" v="Tavily（TAVILY_API_KEY，按需触发）" />
        </Card>

        <Card title="数据与版本">
          <Row k="真相" v="正文与要素都是文件；SQLite 索引可删，reindex 能全量重建" />
          <Row k="版本" v="每本书自带 Git 仓库；接受 / 定稿 / 撤销都会自动提交" />
          <Row k="回退" v="CLI：checkpoint 建点、rollback 回点、element rollback 回要素" />
        </Card>

        <Card title="启动参数">
          <Row k="书目录" v="INKLOOM_BOOK=./my-novel（必填）" mono />
          <Row k="端口" v="PORT=8787（默认；只绑 127.0.0.1）" mono />
          <Row k="判断层" v="INKLOOM_JUDGE=off（默认关闭，开启才计费）" mono />
        </Card>

        <p className="text-[11px] text-neutral-400">
          两个键位：<Kbd>Ctrl+K</Kbd> 命令面板 · <Kbd>Ctrl+Shift+E</Kbd> 专注模式。
        </p>
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <h2 className="border-b border-neutral-100 px-4 py-2 text-sm font-medium text-neutral-800">
        {title}
      </h2>
      <dl className="divide-y divide-neutral-50">{children}</dl>
    </section>
  )
}

function Row({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-4 px-4 py-2 text-[13px]">
      <dt className="w-24 shrink-0 text-neutral-400">{k}</dt>
      <dd
        className={`min-w-0 flex-1 break-words text-neutral-700 ${mono ? 'font-mono text-[11px]' : ''}`}
      >
        {v}
      </dd>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1 py-0.5 font-mono text-[10px] text-neutral-600">
      {children}
    </kbd>
  )
}
