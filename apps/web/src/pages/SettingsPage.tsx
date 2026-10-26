import { useEffect, useState } from 'react'
import { useSaveSettings, useSettings } from '../api/hooks'
import type { SettingsField } from '../api/types'

const GROUPS: { title: string; hint: string; keys: string[] }[] = [
  {
    title: '生成（DeepSeek）',
    hint: '没有 key 时「生成本章」会返回 401，并提示缺哪个变量。',
    keys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL'],
  },
  {
    title: '判断层 / 生图 / 搜索',
    hint: '判断层默认关闭：打开才会计费。硅基流动同时供判断与生图。',
    keys: [
      'INKLOOM_JUDGE',
      'SILICONFLOW_API_KEY',
      'INKLOOM_JUDGE_MODEL',
      'SILICONFLOW_IMAGE_MODEL',
      'TYPESAFE_API_KEY',
      'TAVILY_API_KEY',
    ],
  },
  {
    title: '写作参数',
    hint: '目标字数只影响提示与进度，不截断模型输出。',
    keys: ['INKLOOM_WORDS_PER_CHAPTER'],
  },
]

const LABEL: Record<string, string> = {
  DEEPSEEK_API_KEY: 'DeepSeek API Key',
  DEEPSEEK_MODEL: '生成模型',
  DEEPSEEK_BASE_URL: '接口地址',
  INKLOOM_JUDGE: '判断层',
  SILICONFLOW_API_KEY: '硅基流动 API Key',
  INKLOOM_JUDGE_MODEL: '判断模型',
  SILICONFLOW_IMAGE_MODEL: '生图模型',
  TYPESAFE_API_KEY: 'TypeSafe JEV Key',
  TAVILY_API_KEY: 'Tavily Key（联网搜索）',
  INKLOOM_WORDS_PER_CHAPTER: '每章目标字数',
}

/**
 * 设置（spec §2.1 ⑦）：在这里填 key 与参数，保存即生效。
 *
 * ★ 写入的是项目根的 .env，同时改 process.env——server 每次调用都读 env，
 *   所以不用重启；.env 只负责「下次启动还记得」。
 * ★ 密钥输入框留空 = 不修改；要清除就点「清除」。避免把打码串当新 key 存进去。
 */
export function SettingsPage() {
  const { data, isLoading } = useSettings()
  const save = useSaveSettings()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<string | null>(null)

  // 切到别的页面再回来，草稿不该残留
  useEffect(() => {
    setDraft({})
    setMsg(null)
  }, [])

  if (isLoading) return <p className="p-8 text-sm text-neutral-500">读取设置…</p>
  if (data === undefined) return null

  const fieldOf = (key: string): SettingsField | undefined => data.fields.find((f) => f.key === key)
  const changed = Object.entries(draft).filter(([, v]) => v !== '')

  const submit = (): void => {
    if (changed.length === 0) {
      setMsg('没有改动')
      return
    }
    save.mutate(Object.fromEntries(changed), {
      onSuccess: (r) => {
        setDraft({})
        setMsg(`已保存 ${changed.length} 项 · ${r.note}`)
      },
      onError: (e) => setMsg(e.message),
    })
  }

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-8">
        <header className="flex items-baseline gap-3">
          <div>
            <h1 className="text-lg font-semibold text-neutral-900">设置</h1>
            <p className="mt-1 text-xs text-neutral-500">
              保存后立刻生效（生成 / 判断 / 生图都在调用时读环境变量）。
            </p>
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={save.isPending}
            className="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-40"
          >
            {save.isPending
              ? '保存中…'
              : `保存${changed.length > 0 ? `（${changed.length}）` : ''}`}
          </button>
        </header>

        {msg !== null && (
          <p className="rounded border border-neutral-200 bg-white px-3 py-2 text-[11px] text-neutral-600">
            {msg}
          </p>
        )}

        {GROUPS.map((g) => (
          <section key={g.title} className="rounded-lg border border-neutral-200 bg-white">
            <div className="border-b border-neutral-100 px-4 py-2">
              <h2 className="text-sm font-medium text-neutral-800">{g.title}</h2>
              <p className="mt-0.5 text-[11px] text-neutral-400">{g.hint}</p>
            </div>
            <div className="divide-y divide-neutral-50">
              {g.keys.map((key) => {
                const f = fieldOf(key)
                if (f === undefined) return null
                return (
                  <Field
                    key={key}
                    field={f}
                    draft={draft[key]}
                    onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                  />
                )
              })}
            </div>
          </section>
        ))}

        <p className="text-[11px] text-neutral-400">
          配置文件：<span className="font-mono">{data.envPath}</span>
          {data.exists ? '' : '（尚未创建，首次保存会生成）'}
          <br />
          这个文件不进 Git，也不会被写进书稿目录。
        </p>
      </div>
    </div>
  )
}

function Field({
  field,
  draft,
  onChange,
}: {
  field: SettingsField
  draft: string | undefined
  onChange: (v: string) => void
}) {
  const [reveal, setReveal] = useState(false)
  const isJudge = field.key === 'INKLOOM_JUDGE'
  const value = draft ?? ''

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <label htmlFor={field.key} className="w-40 shrink-0 text-[12px] text-neutral-500">
        {LABEL[field.key] ?? field.key}
      </label>

      {isJudge ? (
        <select
          id={field.key}
          value={value !== '' ? value : field.value || 'off'}
          onChange={(e) => onChange(e.target.value)}
          className="w-56 rounded border border-neutral-300 px-2 py-1 text-[12px]"
        >
          <option value="off">off（关闭，不计费）</option>
          <option value="mock">mock（只验管线）</option>
          <option value="openai">siliconflow（硅基流动）</option>
          <option value="typesafe">typesafe（JEV 官方）</option>
        </select>
      ) : (
        <input
          id={field.key}
          type={field.secret && !reveal ? 'password' : 'text'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            field.set ? `已设置（${field.value}），留空 = 不修改` : field.default || '未设置'
          }
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 font-mono text-[12px]"
        />
      )}

      {field.secret && (
        <button
          type="button"
          onClick={() => setReveal(!reveal)}
          className="text-[11px] text-neutral-400 hover:text-neutral-600"
        >
          {reveal ? '隐藏' : '显示'}
        </button>
      )}

      <span
        className={`w-14 text-right text-[10px] ${field.set ? 'text-emerald-600' : 'text-neutral-300'}`}
      >
        {field.pendingRestart ? '待重启' : field.set ? '已设置' : '未设置'}
      </span>
    </div>
  )
}
