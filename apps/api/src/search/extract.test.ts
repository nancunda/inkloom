import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../llm/types.js'
import { decodeHtml, fetchReadable } from './extract.js'
import { assertPublicUrl } from './ssrf.js'

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  })
}

describe('assertPublicUrl', () => {
  it('拒绝本机与内网', () => {
    for (const bad of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://10.0.0.2/x',
      'http://172.20.1.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest',
      'http://[::1]/x',
      'file:///c:/secret.txt',
    ]) {
      expect(() => assertPublicUrl(bad)).toThrow()
    }
  })

  it('放行公网 http/https', () => {
    expect(assertPublicUrl('https://example.com/a?b=1').hostname).toBe('example.com')
  })

  it('★ 拒绝 IP 变体与 IPv6 内网（不止字面 127.0.0.1）', () => {
    for (const bad of [
      'http://2130706433/',
      'http://0x7f000001/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fc00::1]/',
      'http://[fe80::1]/',
    ]) {
      expect(() => assertPublicUrl(bad)).toThrow()
    }
  })
})

describe('decodeHtml', () => {
  it('按 header 的 charset 解码 gb18030', () => {
    // "中文" 的 GBK 字节
    const buf = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer
    expect(decodeHtml(buf, 'text/html; charset=gb18030')).toBe('中文')
  })

  it('从 meta charset 推断', () => {
    const bytes = Uint8Array.from([
      ...Buffer.from('<meta charset="gbk"><p>', 'latin1'),
      0xd6,
      0xd0,
      0xce,
      0xc4,
      ...Buffer.from('</p>', 'latin1'),
    ]).buffer
    expect(decodeHtml(bytes, 'text/html')).toContain('中文')
  })
})

describe('fetchReadable', () => {
  it('提取正文并截断', async () => {
    const long = '剑冢是一种埋剑的墓。'.repeat(400)
    const fetchImpl: FetchLike = async () =>
      html(
        `<html><head><title>剑冢</title></head><body><article><p>${long}</p></article></body></html>`,
      )
    const r = await fetchReadable('https://example.com/a', { fetchImpl, maxChars: 500 })
    expect(r.title).toBe('剑冢')
    expect(r.extracted).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(500)
  })

  it('★ 正文提取失败时退回纯文本', async () => {
    const fetchImpl: FetchLike = async () => html('<html><body>只有一句话</body></html>')
    const r = await fetchReadable('https://example.com/b', { fetchImpl })
    expect(r.text).toContain('只有一句话')
  })

  it('★ 非 HTML 直接拒绝', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('binary', { status: 200, headers: { 'content-type': 'application/pdf' } })
    await expect(fetchReadable('https://example.com/c', { fetchImpl })).rejects.toThrow('不是网页')
  })

  it('★ 内网地址在发请求前就被拒', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => {
      called = true
      return html('x')
    }
    await expect(fetchReadable('http://127.0.0.1/x', { fetchImpl })).rejects.toThrow('本机')
    expect(called).toBe(false)
  })

  it('★ 重定向到内网被拒：每一跳都重新校验', async () => {
    const seen: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      seen.push(String(url))
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1:8787/api/book' },
      })
    }
    await expect(fetchReadable('https://example.com/x', { fetchImpl })).rejects.toThrow('本机')
    expect(seen).toEqual(['https://example.com/x'])
  })

  it('重定向到公网会跟着走一跳', async () => {
    const fetchImpl: FetchLike = async (url) =>
      String(url).endsWith('/final')
        ? html('<html><body><p>落地页</p></body></html>')
        : new Response('', { status: 301, headers: { location: 'https://example.com/final' } })
    const r = await fetchReadable('https://example.com/start', { fetchImpl })
    expect(r.text).toContain('落地页')
  })

  it('★ 声明体积超 5MB 不读正文就拒', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': String(6 * 1024 * 1024) },
      })
    await expect(fetchReadable('https://example.com/big', { fetchImpl })).rejects.toThrow('太大')
  })
})
