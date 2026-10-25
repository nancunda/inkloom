import type { DiffSpan } from '../api/types'

/**
 * 字符级 diff 渲染。
 *
 * ★ 必须逐 span 渲染成 <span>，绝不能拼 HTML 字符串：
 *   正文里可能有引号、<、>、&，拼字符串要么注入要么显示错乱。
 * ★ 用 <pre> + whitespace-pre-wrap：保留模型输出的换行，同时长段落自动折行。
 */
export function DiffView({ spans }: { spans: DiffSpan[] }) {
  return (
    <pre className="whitespace-pre-wrap font-serif text-[15px] leading-8 text-neutral-800">
      {spans.map((s, i) =>
        s.op === 'same' ? (
          <span key={i}>{s.text}</span>
        ) : s.op === 'add' ? (
          <span key={i} className="bg-emerald-100 text-emerald-900">
            {s.text}
          </span>
        ) : (
          <span key={i} className="bg-rose-100 text-rose-900 line-through decoration-rose-400">
            {s.text}
          </span>
        ),
      )}
    </pre>
  )
}
