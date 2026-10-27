/** 只允许公网 http(s)；拒绝本机、内网、链路本地与 file。 */
export function assertPublicUrl(raw: string): URL {
  const u = new URL(raw)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 链接')

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('不允许访问本机地址')
  if (host === '::1' || host === '0.0.0.0') throw new Error('不允许访问本机地址')
  if (/^127\./.test(host)) throw new Error('不允许访问本机地址')
  // 纯数字 / 0x 十六进制主机名是 IP 的另一种写法（http://2130706433/ = 127.0.0.1）
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new Error('不允许访问内网地址')
  // IPv4 映射的 IPv6（[::ffff:127.0.0.1]）会被 URL 规范化成 ::ffff:7f00:1，
  // 统一由下面「IPv6 只放行 2000::/3」的规则拒掉
  // 其他 IPv6 只放行全球单播 2000::/3；fc00::/7（内网）、fe80::/10（链路本地）一律拒
  if (host.includes(':') && !/^[23]/.test(host)) throw new Error('不允许访问内网地址')
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    throw new Error('不允许访问内网地址')
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) throw new Error('不允许访问内网地址')

  return u
}
