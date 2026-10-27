import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import type { FetchLike } from '../llm/types.js'
import { assertPublicUrl } from './ssrf.js'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_BYTES = 5 * 1024 * 1024

export interface ExtractResult {
  title: string
  text: string
  url: string
  extracted: boolean
}

function charsetOf(contentType: string | null, head: string): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType ?? '')?.[1]
  if (fromHeader !== undefined) return fromHeader.toLowerCase()
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1]
  return (fromMeta ?? 'utf-8').toLowerCase()
}

/** 先把字节按声明编码解码，再做 DOM 解析；gb18030 由 TextDecoder 支持。 */
export function decodeHtml(buf: ArrayBuffer, contentType: string | null): string {
  const head = new TextDecoder('utf-8').decode(buf.slice(0, 2048))
  const charset = charsetOf(contentType, head)
  try {
    return new TextDecoder(charset).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

export async function fetchReadable(
  url: string,
  opts: { fetchImpl?: FetchLike; maxChars?: number; timeoutMs?: number } = {},
): Promise<ExtractResult> {
  const target = assertPublicUrl(url)
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  const res = await fetchImpl(target.toString(), {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  })
  if (!res.ok) throw new Error(`读取失败：HTTP ${res.status}`)

  const contentType = res.headers.get('content-type')
  if (contentType !== null && !contentType.includes('text/html')) {
    throw new Error(`不是网页：${contentType}`)
  }

  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new Error('网页太大（超过 5MB）')

  const html = decodeHtml(buf, contentType)
  const { document } = parseHTML(html)
  const maxChars = opts.maxChars ?? 6000

  try {
    const doc = document as unknown as ConstructorParameters<typeof Readability>[0]
    const article = new Readability(doc).parse()
    const text = (article?.textContent ?? '').trim()
    if (text.length > 0) {
      return {
        title: (article?.title ?? document.title ?? '').trim(),
        text: text.slice(0, maxChars),
        url: target.toString(),
        extracted: true,
      }
    }
  } catch {
    // 落到纯文本兜底
  }

  const fallback = (document.body?.textContent ?? '').trim()
  return {
    title: (document.title ?? '').trim(),
    text: fallback.slice(0, Math.min(maxChars, 3000)),
    url: target.toString(),
    extracted: false,
  }
}
