import type { FetchLike } from '../llm/types.js'

export interface ImageRequest {
  prompt: string
  size?: string
}

export interface ImageResult {
  /** 生成图的可下载地址（服务商临时 URL） */
  url: string
  provider: string
  model: string
  params: Record<string, unknown>
}

export interface ImageProvider {
  readonly id: string
  generate(req: ImageRequest): Promise<ImageResult>
}

export interface SiliconFlowImageOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  fetchImpl?: FetchLike
}

/**
 * 硅基流动生图（P4）。
 *
 * ★ 单独一层：生图服务换起来频繁（即梦 / 硅基流动 / 本地 SD），
 *   portrait-service 只依赖 ImageProvider，不绑定具体厂商。
 * ★ 返回临时 URL，由调用方立刻下载落盘——临时链接几小时后失效，
 *   不能只存 URL 当资产。
 */
export function createSiliconFlowImage(opts: SiliconFlowImageOptions): ImageProvider {
  const base = (opts.baseUrl ?? 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
  const model = opts.model ?? 'Kwai-Kolors/Kolors'
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'siliconflow',
    async generate(req) {
      const params = { image_size: req.size ?? '1024x1024', batch_size: 1 }
      const res = await fetchImpl(`${base}/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, prompt: req.prompt, ...params }),
      })
      if (!res.ok) throw new Error(`image ${res.status}: ${await res.text()}`)

      const body = (await res.json()) as { images?: { url?: string }[] }
      const url = body.images?.[0]?.url
      if (typeof url !== 'string') throw new Error('生图返回里没有图片地址')
      return { url, provider: 'siliconflow', model, params }
    },
  }
}
