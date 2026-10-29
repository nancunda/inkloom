import type { LibraryData } from '../api/types'
import { BookBrowser } from './BookBrowser'

/**
 * 书库页：没有打开任何书时的入口。
 *
 * ★ 它是「应用关卡」，不是弹窗：连书都没打开时，七个模块全部无意义。
 * ★ 不再是 useBook() 报错页——空书库是正常状态（新用户第一次启动）。
 */
export function LibraryPage({ data }: { data: LibraryData }) {
  return (
    <div className="h-dvh overflow-y-auto bg-neutral-50">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="text-[11px] uppercase tracking-[0.2em] text-neutral-400">inkloom</div>
        <h1 className="mt-2 text-xl font-semibold text-neutral-900">书库</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          一本书 = 一个文件夹，全部放在{' '}
          <code className="rounded bg-neutral-100 px-1 py-0.5 text-[12px]">{data.libraryRoot}</code>{' '}
          下。每本书自带 Git 历史与索引，可以整个拷走或备份。
        </p>

        <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-5">
          <BookBrowser data={data} />
        </div>

        <p className="mt-4 text-xs text-neutral-400">
          想换书库位置：启动时设置 INKLOOM_LIBRARY=你的目录。
        </p>
      </div>
    </div>
  )
}
